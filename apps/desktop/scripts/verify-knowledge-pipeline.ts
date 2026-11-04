import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

// Exercise the real snapshot/generator/reviewer/writer with copied stores. Only
// Electron platform access and the authenticated CLI location are adapted for Node.
const [fixturePath, sourcePath, outputPath] = process.argv.slice(2)
assert.ok(fixturePath && sourcePath && outputPath, 'Expected Wiki fixture, original source and new temporary directory')
const output = resolve(outputPath)
assert.equal(realpathSync(dirname(output)), '/private/tmp')
assert.match(basename(output), /^remember-knowledge-pipeline-[a-z0-9-]+$/)
mkdirSync(output, { mode: 0o700 })
const captured = JSON.parse(readFileSync(sourcePath, 'utf8'))
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
const electronSource = `
export const app={isPackaged:false,getPath:(key)=>key==='userData'?${JSON.stringify(output)}:${JSON.stringify(homedir())},getAppPath:()=>${JSON.stringify(resolve(import.meta.dirname, '..'))},getLocale:()=>'en-US',getVersion:()=>'0.0.0',on:()=>{},whenReady:async()=>{}};
export const BrowserWindow={getAllWindows:()=>[]};
export const nativeTheme={themeSource:'system'};
export const powerMonitor={on:()=>{},removeListener:()=>{}};
export const clipboard={}; export const shell={}; export const safeStorage={isEncryptionAvailable:()=>false};
export const ipcMain={handle:()=>{},on:()=>{}}; export const screen={};
export const systemPreferences={}; export const dialog={}; export const net={};
export const session={}; export const protocol={}; export const Menu={};
export const Tray={}; export const Notification={}; export const desktopCapturer={};
export const nativeImage={}; export const globalShortcut={};
`
const cliSource = `
export const bundledClaudeExecutable=()=>'/opt/homebrew/bin/claude';
export const claudeProcessEnvironment=async()=>({...process.env});
export const rememberClaudeConfigDirectory=()=>${JSON.stringify(join(output, 'unused-config'))};
`
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'electron')
      return { url: `data:text/javascript,${encodeURIComponent(electronSource)}`, shortCircuit: true }
    const resolved = next(specifier, context)
    if (resolved.url.endsWith('/main/claudeRuntime.ts'))
      return { url: `data:text/javascript,${encodeURIComponent(cliSource)}`, shortCircuit: true }
    return resolved
  },
})

const { DEFAULT_SETTINGS } = await import('../src/main/settingsStore')
writeFileSync(
  join(output, 'settings.json'),
  JSON.stringify({
    ...DEFAULT_SETTINGS,
    defaultAgentProvider: 'claude',
    claudeAnalysisModel: 'opus',
    cloudAnalysisConsent: true,
    agentLearningEnabled: true,
    agentLearningEnabledAt: captured.timestamp - 1,
    capturePaused: false,
  }),
  { mode: 0o600 }
)
const knowledge = await import('../src/main/dailyReview/knowledgeStore')
knowledge.initializeKnowledgeStore(output)
const copyWiki = join(output, 'daily-review', 'wiki')
for (const page of fixture.pages) {
  knowledge.applyManagedKnowledgeUpdatesAt(copyWiki, 'production-copy://seed', captured.timestamp, [
    {
      slug: page.slug,
      title: page.title,
      content: page.content,
      summary: 'Copied current production page',
      changeType: 'created',
      evidence: page.evidence,
    },
  ])
}
const { getEvidenceStore, closeEvidenceStore } = await import('../src/main/dailyReview/evidenceRepository')
const store = getEvidenceStore()
store.upsertSession({
  id: captured.workdayId,
  localDay: new Date(captured.timestamp).toISOString().slice(0, 10),
  startedAt: captured.timestamp - 1,
  endedAt: captured.timestamp + 1,
  activeDurationMs: 0,
  moments: [],
  appActivity: [],
  contextMoments: [],
  memory: null,
  refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
})
store.appendContextMoment(
  captured.workdayId,
  {
    id: captured.id,
    timestamp: captured.timestamp,
    appName: captured.application[1],
    windowTitle: captured.windowTitle,
    url: captured.url,
    text: captured.text,
    textSource: 'accessibility',
    trigger: 'window-change',
    monitorName: '',
    screenshotPath: '',
  },
  null,
  captured.application[0]
)
const { knowledgeMaintenanceSnapshot } = await import('../src/main/agentLearning')
const { generateKnowledgeOrganizationUpdates } = await import('../src/main/dailyReview/analyzer')
const { createKnowledgeMaintenance } = await import('../src/main/knowledgeMaintenance')
const { applyKnowledgeUpdatesByProject } = await import('../src/main/wikiSpaceStore')
const { closeWikiHistoryStore } = await import('../src/main/wikiHistoryStore')
const before = knowledge.listKnowledgePagesAt(copyWiki).filter((page) => !['index', 'log'].includes(page.slug))
let generated = 0
try {
  const snapshot = await knowledgeMaintenanceSnapshot()
  assert.ok(snapshot)
  assert.equal(snapshot.sources.length, 1)
  assert.equal(snapshot.sources[0]?.id, captured.id)
  assert.equal(snapshot.sources[0]?.text, captured.text)
  const maintenance = createKnowledgeMaintenance({
    statePath: join(output, 'coverage.json'),
    snapshot: knowledgeMaintenanceSnapshot,
    generate: async (input) => {
      generated += 1
      const updates = await generateKnowledgeOrganizationUpdates(input.pages, input.sources, 'en', 'claude')
      writeFileSync(join(output, 'reviewed-updates.json'), JSON.stringify(updates, null, 2), { mode: 0o600 })
      return updates
    },
    apply: async (updates, input, isCurrent) => {
      await applyKnowledgeUpdatesByProject('production-copy-quality', Date.now(), updates, {
        sourceId: 'knowledge-maintenance://production-copy',
        explicitDestinations: true,
        expectedPages: input.pages.map((page) => ({ ...page, spaceId: 'personal' })),
        assertCurrent: isCurrent,
      })
    },
  })
  const result = await maintenance.run()
  assert.equal(result.status, 'applied')
  assert.equal((await maintenance.run()).status, 'covered')
  assert.equal(generated, 1)
  const after = knowledge.listKnowledgePagesAt(copyWiki)
  for (const page of before)
    assert.equal(after.find((candidate) => candidate.slug === page.slug)?.content, page.content)
  const tom = after.find((page) => page.slug === 'people/tom')
  assert.ok(
    tom,
    'The retained draft explicitly describes a meaningful partnership; a qualified orientation should be saved'
  )
  assert.match(tom.content, /observ|draft|display|screen|document/i)
  const proof = {
    status: 'passed',
    boundary:
      'Real application pipeline; Node adapts Electron paths and uses existing authenticated Claude CLI; all stores are temporary copies',
    productionWritten: false,
    realSnapshotBuilder: true,
    realGeneratorParserReviewerWriter: true,
    originalPagesPreserved: before.length,
    generatedCalls: generated,
    replay: 'covered',
    pagesCreated: after
      .filter((page) => !before.some((old) => old.slug === page.slug) && !['index', 'log'].includes(page.slug))
      .map(({ slug }) => slug),
  }
  writeFileSync(join(output, 'proof.json'), JSON.stringify(proof, null, 2), { mode: 0o600 })
  console.log(JSON.stringify(proof))
} finally {
  closeEvidenceStore()
  closeWikiHistoryStore()
}
