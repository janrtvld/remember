import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import type { DictationBridge, DictationNote, RememberBridge } from '@remember/shared'
import type { ElectronApplication, Locator, Page } from 'playwright-core'
import { DEFAULT_SETTINGS } from '../../src/main/settingsStore'

declare global {
  interface Window {
    remember: RememberBridge
    rememberDictation?: DictationBridge
  }
}

const noteA = {
  id: '76000000-0000-4000-8000-000000000001',
  text: 'De Atlas prijsreview is morgen. De volumeschatting en acceptatiecriteria ontbreken nog.',
}
const noteB = {
  id: '76000000-0000-4000-8000-000000000002',
  text: 'De Cedar release is vrijdag. De eigenaar en terugvalcriteria zijn nog onbekend.',
}
const initiativeA =
  'In je notitie ontbreken nog de volumeschatting en acceptatiecriteria voor de Atlas prijsreview. Wil je die samen nalopen?'
const initiativeB = 'In je Cedar-notitie ontbreken een eigenaar en terugvalcriteria. Wil je die eerst verduidelijken?'
const question = 'Waarom zeg je dit over mijn notitie?'
const answer =
  'Synthetisch QA-antwoord: de opgeslagen Atlas-notitie noemt twee ontbrekende gegevens voor de prijsreview.'
const reasoning = 'Synthetische QA-redenering op basis van alleen de huidige Atlas-notitie.'
const afterQuestion = 'Wat kun je nu nog zeggen over die notitie?'
const afterAnswer = 'Synthetisch QA-antwoord: die bron en de eerdere afgeleide uitleg zijn niet meer beschikbaar.'
type Row = Record<string, unknown>
const json = (value: unknown) => JSON.stringify(value, null, 2)
const lines = (file: string): Row[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []

function replaceOnce(file: string, pattern: RegExp, replacement: string) {
  const text = readFileSync(file, 'utf8')
  assert.equal([...text.matchAll(new RegExp(pattern, 'g'))].length, 1, `One copied fixture boundary in ${file}`)
  writeFileSync(file, text.replace(pattern, replacement))
}

export function seedProactiveNotesProfile(profile: string) {
  mkdirSync(join(profile, 'dictation'), { recursive: true, mode: 0o700 })
  writeFileSync(
    join(profile, 'settings.json'),
    json({
      ...DEFAULT_SETTINGS,
      interfaceLanguage: 'nl',
      offlineMode: false,
      cloudAnalysisConsent: true,
      cloudConsentNoticeSeen: true,
      automaticUpdates: false,
      launchAtLogin: false,
      frequentDayRefresh: false,
      liveTaskUpdates: true,
      agentLearningEnabled: false,
      audioCaptureEnabled: false,
      capturePaused: true,
      capturePausedUntil: null,
      capturePauseSources: ['audio', 'capture'],
      defaultAgentProvider: 'codex',
      dayAnalysisProvider: 'codex',
      codexAnalysisModel: 'gpt-5.6-luna',
      codexAnalysisEffort: 'low',
      dayAnalysisOnboardingCompleted: true,
      privacyOnboardingCompleted: true,
      audioCaptureOnboardingCompleted: true,
      contextImportOnboardingCompleted: true,
    }),
    { mode: 0o600 }
  )
  for (const marker of [
    '.legacy-user-data-migration-complete',
    '.legacy-archive-import-complete',
    '.legacy-model-import-complete',
  ])
    writeFileSync(join(profile, marker), 'qa\n', { mode: 0o600 })
  const now = Date.now()
  const ids = [
    ...Array.from({ length: 52 }, (_, index) => `76000000-0000-4000-8001-${String(index + 1).padStart(12, '0')}`),
    noteA.id,
    noteB.id,
  ]
  const notes: DictationNote[] = ids.map((id, index) => ({
    id,
    createdAt: now - (index + 1) * 60_000,
    durationMs: 0,
    text: '',
    status: 'failed',
    error: 'interrupted',
    hasAudio: false,
  }))
  writeFileSync(join(profile, 'dictation/history.json'), json({ version: 1, notes }), { mode: 0o600 })
}

/** Only copied executable discovery, transcript ingress, diagnostic logs and prohibited-effect traps change. */
export function installProactiveNotesFixture(desktopDirectory: string) {
  assert(!desktopDirectory.endsWith('/apps/desktop'), 'Never install QA hooks in the checkout')
  const log = join(desktopDirectory, 'notes-provider.jsonl')
  const traps = join(desktopDirectory, 'notes-prohibited-effects.jsonl')
  const ingress = join(desktopDirectory, 'notes-ingress.jsonl')
  const release = join(desktopDirectory, 'notes-release-b')
  const expected = join(desktopDirectory, 'notes-expected.json')
  const executable = join(desktopDirectory, 'notes-codex-fixture.cjs')
  for (const file of [log, traps, ingress]) writeFileSync(file, '')
  const main = join(desktopDirectory, 'src/main/dictation/index.ts')
  writeFileSync(
    main,
    `${readFileSync(main, 'utf8')}\nObject.assign(globalThis, { qaNotesCommit(id: string, text: string) {\n  const result = completeDictationNote(id, text)\n  require('node:fs').appendFileSync(${JSON.stringify(ingress)}, JSON.stringify({ id, text, result, at: Date.now(), pid: process.pid }) + '\\n')\n  return result\n} })\n`
  )
  const addTrap = (relative: string, pattern: RegExp, kind: string, condition = '') => {
    const file = join(desktopDirectory, relative)
    replaceOnce(
      file,
      pattern,
      `$&\n${condition ? `if (${condition}) ` : ''}{ require('node:fs').appendFileSync(${JSON.stringify(traps)}, JSON.stringify({ kind: ${JSON.stringify(kind)}, at: Date.now(), pid: process.pid }) + '\\n'); throw new Error('qa-notes-prohibited-effect') }`
    )
  }
  addTrap(
    'src/main/dictation/recorder.ts',
    /function send\(command: DictationRecorderCommand\) \{/,
    'dictation-start',
    "command.type === 'start' || command.type === 'sound'"
  )
  addTrap(
    'src/main/dailyReview/microphoneAudio.ts',
    / {6}if \(disposed \|\| !isMicrophoneAudioCaptureAvailable\(\)\) return false/,
    'shared-dictation-start'
  )
  addTrap(
    'src/main/dailyReview/microphoneAudio.ts',
    / {2}if \(!isMicrophoneAudioCaptureAvailable\(\)\) return null/,
    'microphone-capture-start'
  )
  addTrap(
    'src/main/dailyReview/context.ts',
    / {2}if \(!isContextCaptureAvailable\(\)\) return null/,
    'context-capture-start'
  )
  addTrap(
    'src/main/dailyReview/systemAudio.ts',
    / {2}if \(!isSystemAudioCaptureAvailable\(\)\) return null/,
    'system-audio-capture-start'
  )
  writeFileSync(
    executable,
    `#!${process.execPath}
const assert=require('node:assert/strict'),fs=require('node:fs');
const log=value=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({at:Date.now(),pid:process.pid,...value})+'\\n');
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const values=value=>typeof value==='string'?[value]:Array.isArray(value)?value.flatMap(values):value&&typeof value==='object'?Object.values(value).flatMap(values):[];
if(process.argv.includes('--version')){console.log('codex-cli 0.0.0-notes-qa');process.exit(0)}
if(process.argv.includes('login')&&process.argv.includes('status')){console.log('Logged in using ChatGPT');process.exit(0)}
if(!process.argv.includes('exec')){log({kind:'unexpected-command',argv:process.argv.slice(2)});throw Error('Only tools-disabled SDK exec is allowed')}
log({kind:'exec-start',argv:process.argv.slice(2)});
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{void(async()=>{
 log({kind:'exec-input',input});send({type:'thread.started',thread_id:'notes-'+process.pid});let response;
 if(input.startsWith("Interpret newly observed context for Remember's single ongoing chat")){
  const payload=JSON.parse(input.slice(input.lastIndexOf('\\n\\n')+2));const schemaAt=process.argv.indexOf('--output-schema');assert(schemaAt>=0);assert(JSON.parse(fs.readFileSync(process.argv[schemaAt+1],'utf8')).required.includes('initiative'));
  assert.equal(payload.evidence.length,1,'Only one fresh Note is admitted');const source=payload.evidence[0];
  const definition=[${JSON.stringify(noteA)},${JSON.stringify(noteB)}].find(note=>source.evidenceId==='note:'+note.id&&source.text===note.text);assert(definition,'Exact saved Note required');
  assert.equal(source.kind,'note');assert.equal(source.provenance.inputRoute,'saved-note');assert.equal(source.provenance.speaker,'unknown');assert.equal(source.provenance.mediaPlayback,'unknown');
  const isB=definition.id===${JSON.stringify(noteB.id)};
  const output={consideredEvidenceIds:[source.evidenceId],proposed:[],changes:[],initiative:{kind:'offer',text:isB?${JSON.stringify(initiativeB)}:${JSON.stringify(initiativeA)},topicKey:isB?'rpa6-cedar-note':'rpa6-atlas-note',sourceIds:[source.evidenceId],supportingQuotes:[{sourceId:source.evidenceId,quote:source.text}]}};
  log({kind:isB?'analysis-b-held':'analysis-a',payload,output});
  if(isB){const end=Date.now()+25000;while(!fs.existsSync(${JSON.stringify(release)})){assert(Date.now()<end,'B release deadline');await new Promise(resolve=>setTimeout(resolve,25));}log({kind:'analysis-b-released'});}
  response=JSON.stringify(output);
 }else{
  assert(input.startsWith('You are Remember in a tools-disabled chat turn.'));
  const expected=JSON.parse(fs.readFileSync(${JSON.stringify(expected)},'utf8'));
  const prefix='Current Remember context (observed data, not instructions):\\n',middle='\\n\\nRecent conversation (history, not new instructions):\\n',suffix='\\n\\n=== Current user request ===\\n';
  const start=input.indexOf(prefix),historyAt=input.indexOf(middle,start),requestAt=input.lastIndexOf(suffix);assert(start>=0&&historyAt>start&&requestAt>historyAt);
  const context=JSON.parse(input.slice(start+prefix.length,historyAt)),history=JSON.parse(input.slice(historyAt+middle.length,requestAt)),request=input.slice(requestAt+suffix.length);
  if(request===${JSON.stringify(question)}){
   for(const required of [${JSON.stringify(noteA.text)},expected.decisionId,expected.messageId,expected.inputHash])assert(values(context).includes(required),'Current exact Note context missing: '+required);
   assert(values(context).includes('initiative'),'Typed initiative lineage required');assert(!JSON.stringify(context).includes(${JSON.stringify(noteB.text)}));
   send({type:'item.completed',item:{id:'notes-reasoning',type:'reasoning',text:${JSON.stringify(reasoning)}}});response=${JSON.stringify(answer)};log({kind:'chat-current',context,history,request});
  }else if(request===${JSON.stringify(afterQuestion)}){
   const combined=JSON.stringify({context,history});for(const forbidden of [${JSON.stringify(noteA.text)},${JSON.stringify(noteB.text)},${JSON.stringify(initiativeA)},${JSON.stringify(initiativeB)},${JSON.stringify(answer)},${JSON.stringify(reasoning)}])assert(!combined.includes(JSON.stringify(forbidden).slice(1,-1)),'Deleted/derived content leaked');
   response=${JSON.stringify(afterAnswer)};log({kind:'chat-after-delete',context,history,request});
  }else throw Error('Unexpected ordinary question');
 }
 send({type:'item.completed',item:{id:'notes-answer',type:'agent_message',text:response}});send({type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1}});log({kind:'completed'});
})().catch(error=>{log({kind:'fixture-error',message:String(error)});console.error(error);process.exitCode=1});});
`,
    { mode: 0o700 }
  )
  replaceOnce(
    join(desktopDirectory, 'src/main/codexRuntime.ts'),
    /export function bundledCodexExecutable\(\) \{[\s\S]*?\n\}/,
    `export function bundledCodexExecutable() { return ${JSON.stringify(executable)} }`
  )
}

async function waitFor<T>(read: () => Promise<T | null | false>, label: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== null && value !== false) return value
    assert(Date.now() < deadline, label)
    await delay(100)
  }
}
function gone(pid: number) {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
    throw error
  }
}
function rows(file: string, tables: string[]) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return Object.fromEntries(
      tables.map((table) => {
        assert(/^[a-z_]+$/.test(table))
        return [
          table,
          db
            .prepare(`SELECT * FROM ${table}`)
            .all()
            .map((row) => ({ ...row })),
        ]
      })
    ) as Record<string, Row[]>
  } finally {
    db.close()
  }
}
function facts(profile: string) {
  return {
    evidence: rows(join(profile, 'daily-review/evidence.sqlite'), [
      'work_item',
      'audio_evidence',
      'context_evidence',
      'proactive_event',
      'proactive_decision',
      'proactive_consumer',
    ]),
    resident: rows(join(profile, 'daily-review/assistant/conversation.sqlite'), [
      'assistant_message',
      'assistant_proactive_initiative',
      'assistant_reply_context',
      'assistant_initiative_action',
      'assistant_task_run',
      'assistant_host_run',
      'assistant_tool_call',
    ]),
    history: JSON.parse(readFileSync(join(profile, 'dictation/history.json'), 'utf8')) as Row,
  }
}
function mediaFiles(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name)
    return entry.isDirectory() ? mediaFiles(file) : /\.(png|jpe?g|webp|wav|m4a|mp3|aiff)$/i.test(file) ? [file] : []
  })
}
function archiveClosed(profile: string, target: string) {
  mkdirSync(target, { recursive: true })
  for (const [label, relative] of [
    ['evidence', 'daily-review/evidence.sqlite'],
    ['resident', 'daily-review/assistant/conversation.sqlite'],
  ]) {
    for (const suffix of ['', '-wal', '-shm']) {
      const file = join(profile, relative + suffix)
      if (existsSync(file)) copyFileSync(file, join(target, `${label}.sqlite${suffix}`))
    }
  }
  copyFileSync(join(profile, 'dictation/history.json'), join(target, 'history.json'))
}
async function keyboard(control: Locator) {
  await control.waitFor({ state: 'visible' })
  await control.focus()
  assert(await control.evaluate((element) => document.activeElement === element))
  await control.press('Enter')
}

export async function proactiveNotesQa({
  directory,
  desktopDirectory,
  launch,
  close,
  getElectron,
  checks,
}: {
  directory: string
  desktopDirectory: string
  launch(): Promise<Page>
  close(): Promise<void>
  getElectron(): ElectronApplication | undefined
  checks: string[]
}) {
  const profile = join(directory, 'profile')
  const providerLog = join(desktopDirectory, 'notes-provider.jsonl')
  const trapLog = join(desktopDirectory, 'notes-prohibited-effects.jsonl')
  const release = join(desktopDirectory, 'notes-release-b')
  const proof: Row = {
    startedAt: Date.now(),
    boundary:
      'Real isolated Electron, production completed-transcript/history seam, worker, SDK CLI boundary, UI, IPC, SQLite/history and full quits. Preseeded no-audio Notes and deterministic interpreter/chat. No recording, ASR, actual model, Mini, cloud, host effect or release.',
  }
  const mediaInventory = () =>
    mediaFiles(profile)
      .sort()
      .map((file) => {
        const bytes = readFileSync(file)
        return {
          path: file.slice(profile.length + 1),
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        }
      })
  let initialMedia: ReturnType<typeof mediaInventory> = []
  const pids: number[] = []
  const cleanupErrors: string[] = []
  const save = () => writeFileSync(join(directory, 'proactive-notes-proof.json'), json(proof))
  const snapshot = (target: Page) => target.evaluate(() => window.remember.getAssistantConversation())
  let page: Page | null = null
  const assertQuiet = async (target: Page) => {
    const settings = await target.evaluate(() => window.remember.getSettings())
    assert.equal(settings.capturePaused, true)
    assert.equal(settings.audioCaptureEnabled, false)
    assert.deepEqual(lines(trapLog), [])
    assert.deepEqual(mediaInventory(), initialMedia, 'Only the exact unchanged prelaunch model test WAVs may exist')
    return { capturePaused: settings.capturePaused, audioCaptureEnabled: settings.audioCaptureEnabled }
  }
  const start = async () => {
    const target = await launch()
    target.setDefaultTimeout(20_000)
    target.setDefaultNavigationTimeout(90_000)
    const pid = getElectron()?.process().pid
    assert(pid)
    pids.push(pid)
    await target.goto(`${new URL(target.url()).origin}/assistant/`)
    await waitFor(async () => (await snapshot(target)).proactiveEnabled || null, 'Proactive conversation owner ready')
    await waitFor(
      async () => facts(profile).evidence.proactive_consumer.some((row) => row.enabled === 1) || null,
      'Actual Note consumer is enabled before transcript commit'
    )
    await assertQuiet(target)
    return target
  }
  const quit = async (label: string) => {
    const pid = pids.at(-1)
    assert(pid)
    await close()
    page = null
    await waitFor(async () => gone(pid) || null, 'Full native quit removes this PID', 15_000)
    archiveClosed(profile, join(directory, label))
    proof[label] = { pid, gone: true, at: Date.now() }
    save()
  }
  const commit = async (note: typeof noteA) => {
    const electron = getElectron()
    assert(electron)
    const value = await electron.evaluate((_electron, note) => {
      const hook = (globalThis as typeof globalThis & { qaNotesCommit?: (id: string, text: string) => DictationNote })
        .qaNotesCommit
      if (!hook) throw new Error('qa-notes-completion-seam-missing')
      return hook(note.id, note.text)
    }, note)
    assert.equal(value.id, note.id)
    assert.equal(value.text, note.text)
    assert.equal(value.status, 'completed')
    assert.equal(value.hasAudio, false)
    return value
  }
  const send = async (target: Page, text: string, expectedText: string) => {
    const before = new Set((await snapshot(target)).messages.map((message) => message.id))
    const composer = target.locator('#assistant-message')
    await composer.fill(text)
    await composer.press('Enter')
    return waitFor(
      async () =>
        (await snapshot(target)).messages.find(
          (message) =>
            !before.has(message.id) &&
            message.role === 'assistant' &&
            message.status === 'completed' &&
            message.text === expectedText
        ) ?? null,
      'Actual composer reply completes'
    )
  }
  const deleteNote = async (target: Page, id: string) => {
    await target.goto(`${new URL(target.url()).origin}/notes/?noteId=${encodeURIComponent(id)}`)
    const row = target.locator(`[data-note-id="${id}"]`)
    await row.waitFor()
    await waitFor(
      async () => (await row.evaluate((element) => document.activeElement === element)) || null,
      'Exact Note gains focus'
    )
    await keyboard(row.getByRole('button', { name: 'Notitie verwijderen', exact: true }))
    await keyboard(row.getByRole('button', { name: 'Verwijderen', exact: true }))
    await waitFor(
      async () =>
        !(
          await target.evaluate(() => {
            if (!window.rememberDictation) throw new Error('dictation-bridge-missing')
            return window.rememberDictation.getHistory()
          })
        ).some((note) => note.id === id) || null,
      'Real delete IPC removes exact Note'
    )
    await target.locator(`[data-note-unavailable="${id}"]`).waitFor()
  }
  try {
    initialMedia = mediaInventory()
    assert.deepEqual(
      initialMedia.map((entry) => entry.path),
      ['de', 'en', 'es', 'fr'].map((language) => `models/parakeet-tdt-0.6b-v3-int8/test_wavs/${language}.wav`),
      'Prelaunch media must be exactly the four known ASR model test assets'
    )
    proof.initialMedia = initialMedia
    save()
    page = await start()
    await page.setViewportSize({ width: 1040, height: 900 })
    assert.equal((await snapshot(page)).messages.length, 0)
    assert.equal(lines(providerLog).filter((entry) => entry.kind === 'exec-start').length, 0)
    await page.evaluate(() =>
      window.remember.createWorkItem({
        title: 'Handmatige taak blijft open',
        description: 'RPA-6 mag deze taak niet aanpassen.',
      })
    )
    const baseline = facts(profile)
    assert(baseline.evidence.work_item.length > 0)
    assert.deepEqual(baseline.evidence.audio_evidence, [])
    assert.deepEqual(baseline.evidence.context_evidence, [])
    assert.deepEqual(baseline.resident.assistant_initiative_action, [])
    assert.deepEqual(baseline.resident.assistant_task_run, [])
    assert.deepEqual(baseline.resident.assistant_host_run, [])
    assert.deepEqual(baseline.resident.assistant_tool_call, [])
    proof.baseline = baseline
    proof.commitA = await commit(noteA)
    const firstPage = page
    const a = await waitFor(
      async () =>
        (await snapshot(firstPage)).messages.find((message) => message.text === initiativeA && message.initiative) ??
        null,
      'Saved Note produces one actual source-backed initiative'
    )
    assert(a.initiative)
    assert.equal(a.initiative.sources.length, 1)
    assert.deepEqual(
      { ...a.initiative.sources[0], observedAt: 0 },
      {
        id: `note:${noteA.id}`,
        kind: 'note',
        noteId: noteA.id,
        quote: noteA.text,
        observedAt: 0,
        appName: '',
        windowTitle: '',
      }
    )
    const published = facts(profile)
    const receipt = published.resident.assistant_proactive_initiative.find((row) => row.message_id === a.id)
    assert(receipt)
    const reference = {
      kind: 'initiative',
      decisionId: a.initiative.decisionId,
      messageId: a.id,
      inputHash: String(receipt.input_hash),
    }
    writeFileSync(join(desktopDirectory, 'notes-expected.json'), json(reference))
    const source = page.locator(`[data-proactive-decision="${a.initiative.decisionId}"]`)
    await keyboard(source.locator('summary'))
    assert.equal(await source.locator('blockquote').textContent(), noteA.text)
    await page.screenshot({ path: join(directory, 'notes-source-standard.png') })
    await page.setViewportSize({ width: 720, height: 900 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true)
    await page.screenshot({ path: join(directory, 'notes-source-720.png') })
    const link = source.getByRole('link', { name: 'Notitie openen', exact: true })
    assert.equal(await link.getAttribute('href'), `/notes/?noteId=${noteA.id}`)
    await keyboard(link)
    const target = page.locator(`[data-note-id="${noteA.id}"]`)
    await target.waitFor()
    await waitFor(
      async () => (await target.evaluate((element) => document.activeElement === element)) || null,
      'Source link focuses exact Note beyond first 50'
    )
    assert.equal(await page.locator('[data-note-id]').count(), 53)
    await page.screenshot({ path: join(directory, 'notes-exact-row-720.png') })
    await page.goto(`${new URL(page.url()).origin}/assistant/`)
    const reply = await send(page, question, answer)
    const withReply = facts(profile)
    const lineage = withReply.resident.assistant_reply_context.filter((row) => row.message_id === reply.id)
    assert.equal(lineage.length, 1)
    assert.deepEqual(JSON.parse(String(lineage[0].references_json)), [reference])
    assert.deepEqual(withReply.evidence.work_item, baseline.evidence.work_item)
    proof.a = { message: a, reference, reply, lineage, native: withReply, quiet: await assertQuiet(page) }
    save()
    checks.push(
      'A saved no-audio Note yields one initiative; source opens exact row beyond 50; ordinary reply binds exact Note lineage'
    )
    const beforeRestartCount = lines(providerLog).filter((entry) => entry.kind === 'exec-start').length
    assert.equal(beforeRestartCount, 2)
    await quit('notes-first-quit')
    page = await start()
    const restored = await snapshot(page)
    assert.deepEqual(
      restored.messages.find((message) => message.id === a.id),
      a
    )
    assert.deepEqual(
      restored.messages.find((message) => message.id === reply.id),
      reply
    )
    assert.equal(lines(providerLog).filter((entry) => entry.kind === 'exec-start').length, beforeRestartCount)
    await page.screenshot({ path: join(directory, 'notes-first-restart.png') })
    proof.firstRestart = { conversation: restored, native: facts(profile), inferenceStarts: beforeRestartCount }
    checks.push('First full quit/restart preserves exact initiative/reply identities and performs no inference replay')
    proof.commitB = await commit(noteB)
    await waitFor(
      async () => lines(providerLog).find((entry) => entry.kind === 'analysis-b-held') ?? null,
      'B interpreter is genuinely held after actual source input'
    )
    await deleteNote(page, noteB.id)
    writeFileSync(release, 'release after actual delete IPC\n')
    await waitFor(
      async () => {
        const held = lines(providerLog).find((entry) => entry.kind === 'analysis-b-held')
        return (held && gone(Number(held.pid))) || null
      },
      'Held B interpreter settles or is aborted',
      15_000
    )
    await page.screenshot({ path: join(directory, 'notes-deleted-b.png') })
    await deleteNote(page, noteA.id)
    await page.screenshot({ path: join(directory, 'notes-deleted-a.png') })
    await page.goto(`${new URL(page.url()).origin}/assistant/`)
    const deletionPage = page
    const withheld = await waitFor(async () => {
      const current = await snapshot(deletionPage)
      const original = current.messages.find((message) => message.id === a.id)
      const derivative = current.messages.find((message) => message.id === reply.id)
      return original?.error === 'assistant-proactive-source-unavailable' &&
        derivative?.error === 'assistant-proactive-source-unavailable' &&
        !original.text &&
        !derivative.text
        ? current
        : null
    }, 'Deleted Note and derived reply are withheld in actual chat snapshot')
    assert(!withheld.messages.some((message) => message.text === initiativeB))
    await page.getByText('De bron is niet meer beschikbaar.', { exact: true }).first().waitFor()
    await page.setViewportSize({ width: 720, height: 900 })
    proof.withheldViewport = page.viewportSize()
    await page.screenshot({ path: join(directory, 'notes-withheld-720.png') })
    const afterReply = await send(page, afterQuestion, afterAnswer)
    assert.equal(lines(providerLog).filter((entry) => entry.kind === 'chat-after-delete').length, 1)
    const deleted = facts(profile)
    assert.deepEqual(deleted.evidence.work_item, baseline.evidence.work_item)
    assert.equal(deleted.resident.assistant_proactive_initiative.length, 1)
    assert.deepEqual(deleted.resident.assistant_initiative_action, [])
    assert.deepEqual(deleted.resident.assistant_task_run, [])
    assert.deepEqual(deleted.resident.assistant_host_run, [])
    assert.deepEqual(deleted.resident.assistant_tool_call, [])
    proof.deletion = {
      withheld,
      afterReply,
      native: deleted,
      bReleasedOutput: lines(providerLog).some((entry) => entry.kind === 'analysis-b-released'),
      quiet: await assertQuiet(page),
    }
    save()
    checks.push(
      'Actual delete IPC defeats held B publication and masks A/derived history; next actual prompt excludes deleted and derived content'
    )
    const startsBeforeSecond = lines(providerLog).filter((entry) => entry.kind === 'exec-start').length
    assert.equal(startsBeforeSecond, 4)
    await quit('notes-second-quit')
    page = await start()
    const finalConversation = await snapshot(page)
    for (const id of [a.id, reply.id]) {
      const item = finalConversation.messages.find((message) => message.id === id)
      assert(item)
      assert.equal(item.error, 'assistant-proactive-source-unavailable')
      assert.equal(item.text, '')
      assert.deepEqual(item.steps, [])
    }
    assert.deepEqual(
      finalConversation.messages.find((message) => message.id === afterReply.id),
      afterReply
    )
    const remaining = await page.evaluate(() => {
      if (!window.rememberDictation) throw new Error('dictation-bridge-missing')
      return window.rememberDictation.getHistory()
    })
    assert(!remaining.some((note) => note.id === noteA.id || note.id === noteB.id))
    assert.equal(lines(providerLog).filter((entry) => entry.kind === 'exec-start').length, startsBeforeSecond)
    assert.equal(lines(providerLog).filter((entry) => entry.kind === 'analysis-a').length, 1)
    assert.equal(lines(providerLog).filter((entry) => entry.kind === 'analysis-b-held').length, 1)
    assert.equal(lines(providerLog).filter((entry) => entry.kind === 'chat-current').length, 1)
    assert.equal(lines(providerLog).filter((entry) => entry.kind === 'unexpected-command').length, 0)
    assert.equal(lines(providerLog).filter((entry) => entry.kind === 'fixture-error').length, 0)
    const completionCount = lines(providerLog).filter((entry) => entry.kind === 'completed').length
    assert.equal(completionCount, lines(providerLog).some((entry) => entry.kind === 'analysis-b-released') ? 4 : 3)
    const final = facts(profile)
    assert.deepEqual(final.evidence.work_item, baseline.evidence.work_item)
    assert.deepEqual(final.evidence.audio_evidence, [])
    assert.deepEqual(final.evidence.context_evidence, [])
    proof.final = {
      conversation: finalConversation,
      native: final,
      remaining,
      inferenceStarts: startsBeforeSecond,
      completionCount,
      quiet: await assertQuiet(page),
    }
    await page.screenshot({ path: join(directory, 'notes-second-restart.png') })
    checks.push(
      'Second full quit/restart retains exact deletion/no replay; human Tasks unchanged, zero capture/recording and host effects'
    )
    proof.status = 'passed'
  } catch (error) {
    proof.status = 'failed'
    proof.error = error instanceof Error ? (error.stack ?? error.message) : String(error)
    throw error
  } finally {
    writeFileSync(release, 'cleanup releases own fixture only\n')
    if (page) {
      try {
        await page.evaluate(() => window.remember.pauseCapture())
        proof.cleanupSettings = await page.evaluate(() => window.remember.getSettings())
      } catch (error) {
        cleanupErrors.push(String(error))
      }
    }
    try {
      await close()
    } catch (error) {
      cleanupErrors.push(String(error))
    }
    proof.pids = pids.map((pid) => ({ pid, gone: gone(pid) }))
    proof.provider = lines(providerLog)
    proof.providerPids = [
      ...new Set(
        lines(providerLog)
          .filter((entry) => entry.kind === 'exec-start')
          .map((entry) => Number(entry.pid))
      ),
    ].map((pid) => ({ pid, gone: gone(pid) }))
    proof.traps = lines(trapLog)
    proof.ingress = lines(join(desktopDirectory, 'notes-ingress.jsonl'))
    proof.cleanupErrors = cleanupErrors
    proof.finishedAt = Date.now()
    save()
  }
  try {
    assert.deepEqual(cleanupErrors, [], 'Own cleanup must complete')
    assert(
      (proof.pids as Array<{ gone: boolean }>).every((entry) => entry.gone),
      'All native PIDs must exit'
    )
    assert(
      (proof.providerPids as Array<{ gone: boolean }>).every((entry) => entry.gone),
      'All own fake CLI PIDs must exit'
    )
  } catch (error) {
    proof.status = 'failed'
    proof.cleanupVerificationError = String(error)
    save()
    throw error
  }
}
