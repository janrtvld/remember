import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { WikiPage, WikiSpace } from '@remember/shared'
import { runCodexWorker } from '../../src/main/codexWorker'
import { EvidenceStore } from '../../src/main/dailyReview/evidenceStore'
import type { ProactiveDecision } from '../../src/main/dailyReview/proactiveStore'
import { RESIDENT_AGENT_INSTRUCTIONS } from '../../src/main/residentAgentInstructions'
import { createResidentMemoryTool } from '../../src/main/residentAgentMemoryTool'
import { createResidentAgentService } from '../../src/main/residentAgentService'
import { ResidentAgentStore } from '../../src/main/residentAgentStore'
import { createResidentArchiveSession } from '../../src/main/residentArchiveSession'
import { RESIDENT_ARCHIVE_GUIDE } from '../../src/main/residentArchiveTool'
import { createResidentDataTool } from '../../src/main/residentDataTool'
import { createResidentTaskTool } from '../../src/main/residentTaskTool'
import { createResidentTurnTools } from '../../src/main/residentTurnTools'
import { DEFAULT_SETTINGS } from '../../src/main/settingsStore'

// Opt-in live inference over synthetic data and isolated stores. No real task,
// Space, transcript or user conversation is sent to the provider or changed.
const directory = mkdtempSync('/private/tmp/remember-agent-live-')
mkdirSync(join(directory, 'workspace'))
const settings = JSON.parse(readFileSync(join(homedir(), 'Library/Application Support/Remember/settings.json'), 'utf8'))
const evidence = new EvidenceStore(join(directory, 'evidence.sqlite'))
const file = join(directory, 'chat.sqlite')
let store = new ResidentAgentStore(file)
const task = evidence.createWorkItem('Controleer de Woub-storepublicatie', 'Alleen synthetische QA.')
const space: WikiSpace = {
  id: 'qa-woub',
  name: 'Woub QA',
  maintenanceMode: 'auto',
  description: '',
  icon: 'book',
  color: 'slate',
}
let pages: WikiPage[] = [
  {
    slug: 'release',
    title: 'Release',
    content: '# Release\nMitchel doet de storepublicatie.',
    excerpt: 'Mitchel doet de storepublicatie.',
    revision: 'r1',
    sourceCount: 0,
    updatedAt: Date.now(),
  },
]
const now = Date.now(),
  date = new Date().toLocaleDateString('en-CA')
const initiative: ProactiveDecision = {
  id: 'live-qa-build',
  kind: 'clarify',
  text: 'Both production builds are now successful. The remaining Woub release question is whether the store publication has been confirmed. If you share the store status, I can help pin down the release follow-up.',
  topicKey: 'qa-publication',
  createdAt: now,
  expiresAt: now + 60_000,
  sourceIds: ['context:qa-source'],
  supportingQuotes: [{ sourceId: 'context:qa-source', quote: 'Builds successful' }],
  policyToken: 'qa',
  conversationGeneration: 0,
  inputHash: 'a'.repeat(64),
  consumerGeneration: 1,
  deletionRevision: 0,
  deliveredMessageId: null,
  invalidatedAt: null,
  sourceRefs: [
    {
      kind: 'context',
      sourceId: 'qa-source',
      evidenceId: 'context:qa-source',
      eventId: 'qa-event',
      eventRevision: 'b'.repeat(64),
      revision: 'c'.repeat(64),
      contentKey: 'd'.repeat(64),
      workdayId: 'qa-day',
      observedAt: now,
      appName: 'QA',
      windowTitle: '',
      url: '',
    },
  ],
}
assert(store.appendProactiveInitiative(initiative))
const results: { request: string; response: string; tools: string[]; durationMs: number; reviews: string[] }[] = []
let toolCalls: string[] = [],
  reviews: string[] = []
let active: AbortController | null = null
const create = () =>
  createResidentAgentService({
    store,
    context: () =>
      JSON.stringify({
        today: date,
        timezone: 'Europe/Amsterdam',
        execution: 'local',
        sources: RESIDENT_ARCHIVE_GUIDE,
      }),
    assertAvailable() {},
    changed() {},
    replyContextPermitted: () => true,
    proactive: { canPublish: () => true, changed() {}, messagePermitted: () => true },
    driver: {
      cancel() {
        active?.abort()
      },
      async run(input) {
        const started = performance.now()
        active = new AbortController()
        const signal = AbortSignal.any([active.signal, AbortSignal.timeout(180_000)])
        const guard = () => {
          signal.throwIfAborted()
          input.assertContextCurrent?.()
        }
        const ask = async (request: { title: string }) => {
          reviews.push(request.title)
          return { id: 'qa-review', action: 'accept' as const, values: {} }
        }
        const archive = createResidentArchiveSession({
          instruction: input.instruction,
          recovery: false,
          locale: 'nl',
          assertCurrent: guard,
          run: async () => ({
            schemaVersion: 1,
            availability: 'available',
            sourceKind: 'local-audio-episodes',
            selector: date,
            timezone: 'Europe/Amsterdam',
            count: 1,
            offset: 0,
            nextOffset: null,
            items: [
              {
                id: 'qa-conversation',
                dayId: 'qa-day',
                date,
                startedAt: now - 100_000,
                endedAt: now - 60_000,
                acceptance: 'classified',
                revision: 'r1',
                savedTitle: 'Woub publicatie',
                text: 'We bespreken de Woub publicatie. Sam controleert morgen de winkelpagina.',
              },
            ],
          }),
        })
        const data = createResidentDataTool({
          asOf: now,
          store: evidence,
          settings: () => DEFAULT_SETTINGS,
          notes: () => ({ state: 'available', epoch: 'qa', sequence: 0, notes: [], tombstones: {} }),
          daySummaryPermitted: () => false,
          assertCurrent: guard,
        })
        const tasks = createResidentTaskTool({
          messageId: input.turnId,
          evidence,
          store,
          permitted: () => true,
          assertAvailable: guard,
          ask,
        })
        const memory = () =>
          createResidentMemoryTool(input.instruction, {
            messageId: input.turnId,
            spaces: () => [space],
            read: async () => ({ pages, state: 'fresh', checkedAt: now }),
            pagePermitted: () => true,
            assertAvailable: guard,
            store,
            ask,
            wiki: {
              getSpaces: () => [space],
              listPages: async () => pages,
              createPage: async () => {
                throw new Error('qa-create-not-allowed')
              },
              deletePage: async () => {
                throw new Error('qa-delete-not-allowed')
              },
              proposePage: async () => {
                throw new Error('qa-propose-not-allowed')
              },
              savePage: async (value) => {
                pages = [{ ...pages[0], content: value.content, revision: 'r2' }]
                return pages
              },
            },
          })
        const tools = createResidentTurnTools({
          memory,
          data,
          task: tasks,
          archive,
          conversation: input.conversationTool,
          onCall: (name, raw) => toolCalls.push(`${name}:${String((raw as { action?: string }).action ?? 'history')}`),
        })
        const answer = await runCodexWorker({
          cwd: join(directory, 'workspace'),
          version: '0.2.299',
          executable: '/opt/homebrew/bin/codex',
          env: { ...process.env, CODEX_HOME: join(homedir(), 'Library/Application Support/Remember/codex') },
          // No browser/computer plugins are needed for this Remember-only probe.
          providerHome: directory,
          model: settings.codexAnalysisModel,
          effort: settings.codexAnalysisEffort,
          prompt: input.prompt,
          systemPrompt: `${RESIDENT_AGENT_INSTRUCTIONS}\n${RESIDENT_ARCHIVE_GUIDE}`,
          threadId: null,
          signal,
          tools,
          assertCurrent: guard,
          onThread() {},
          onUsage() {},
          report: () => {},
          ask: async () => {
            throw new Error('qa-unexpected-provider-approval')
          },
        })
        guard()
        const response = await archive.finalize(answer.response, signal)
        return { provider: 'codex' as const, response, durationMs: performance.now() - started, steps: [] }
      },
    },
  })
let service = create()
async function send(request: string) {
  toolCalls = []
  reviews = []
  const started = performance.now()
  service.send({ text: request, provider: 'codex' })
  while (service.snapshot().activeTurnId) await delay(100)
  const answer = service.snapshot().messages.at(-1)
  assert(answer?.status === 'completed', answer?.error ?? 'Live turn failed')
  const result = {
    request,
    response: answer.text,
    tools: [...toolCalls],
    reviews: [...reviews],
    durationMs: Math.round(performance.now() - started),
  }
  results.push(result)
  writeFileSync(
    join(directory, 'proof.json'),
    JSON.stringify(
      {
        model: settings.codexAnalysisModel,
        scope: 'Live model; synthetic records; isolated stores; controlled approval of fixture-only writes',
        results,
      },
      null,
      2
    )
  )
  console.log(JSON.stringify(result))
  return result
}
console.log(`Evidence: ${directory}/proof.json`)
try {
  const correction = await send('Mitchel is picking that up.')
  assert.equal(correction.tools.length, 0, 'An ownership correction needs no retrieval')
  assert.doesNotMatch(correction.response, /what is Mitchel|wat pakt Mitchel|wat neemt Mitchel/i)
  await service.dispose()
  store = new ResidentAgentStore(file)
  service = create()
  const recall = await send('Who handles the store publication again?')
  assert.match(recall.response, /Mitchel/i)
  assert.equal(recall.tools.length, 0)
  const taskAnswer = await send(`Vink de taak "${task.title}" af; die is klaar.`)
  assert.equal(evidence.getWorkItem(task.id)?.lifecycle, 'completed')
  assert.doesNotMatch(taskAnswer.response, /niet betrouwbaar|could not reliably/i)
  assert(reviews.length > 0, 'The real Task tool must request review')
  const spaceAnswer = await send(
    'Lees in Space Woub QA de pagina release en vervang "Mitchel doet de storepublicatie." door "Sam doet de storepublicatie."'
  )
  assert.match(pages[0].content, /Sam doet de storepublicatie/)
  assert.doesNotMatch(spaceAnswer.response, /niet betrouwbaar|could not reliably/i)
  assert(reviews.length > 0, 'The real Space tool must request review')
  const conversations = await send(`Welke gesprekken had ik op ${date}?`)
  assert.match(conversations.response, /Woub publicatie|Sam controleert morgen de winkelpagina/i)
  assert(conversations.tools.some((name) => name === 'remember_archive:conversations'))
  console.log('Live continuity, Task, Space and conversation checks passed.')
} finally {
  await service.dispose()
  evidence.close()
}
