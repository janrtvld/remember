import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { AssistantConversation } from '@remember/shared'
import type { ElectronApplication, Page } from 'playwright-core'
import {
  BRIEFING_PROTOCOL,
  type BriefingObservation,
  type BriefingResult,
  validateBriefingObservation,
  validateBriefingResult,
} from '../../../../experiments/always-on-agent/briefing-protocol.mjs'
import { briefingQaInstallationId, validateBriefingNativeManifest } from '../../src/main/briefingNativeCore'
import { type BriefingConnection, connectBriefingTcp } from '../../src/main/briefingTcpConnector'
import type { InitiativePrepared } from '../../src/main/hostInitiativeProtocol'
import { useExistingQaCodexHome } from './ambientLive'
import { installProactiveAgentFixture } from './proactive-agent'
import { seedProactiveBriefingProfile } from './proactive-briefing'

type Row = Record<string, unknown>
type Source = { id: string; corpusId: string; text: string; sha256: string }
type Control = { title: string; personal: Source; sources: Source[]; frozenAt: number }
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const json = (value: unknown) => JSON.stringify(value, null, 2)
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const lines = (file: string): Row[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []
const names = {
  manifest: 'proactive-briefing-mini-manifest.json',
  control: 'proactive-briefing-mini-control.json',
  proof: 'proactive-briefing-mini-proof.json',
  packets: 'proactive-briefing-mini-packets.jsonl',
}
function manifest() {
  const file = process.env.REMEMBER_QA_BRIEFING_MANIFEST
  assert(typeof file === 'string' && file.startsWith('/private/tmp/'), 'An owned main-only Mini manifest is required')
  return validateBriefingNativeManifest(JSON.parse(readFileSync(file, 'utf8')))
}
function replaceOnce(file: string, pattern: RegExp, replacement: string) {
  const source = readFileSync(file, 'utf8')
  assert.equal([...source.matchAll(new RegExp(pattern, 'g'))].length, 1, `Exact snapshot boundary: ${file}`)
  writeFileSync(file, source.replace(pattern, replacement))
}
function rows(file: string, tables: string[]) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]))
  } finally {
    db.close()
  }
}
function nativeFacts(profile: string) {
  return {
    evidence: rows(join(profile, 'daily-review/evidence.sqlite'), [
      'work_item',
      'audio_evidence',
      'context_evidence',
      'proactive_consumer',
      'proactive_event',
      'proactive_considered',
      'proactive_decision',
    ]),
    resident: rows(join(profile, 'daily-review/assistant/conversation.sqlite'), [
      'assistant_message',
      'assistant_proactive_initiative',
      'assistant_standing_grant',
      'assistant_initiative_action',
    ]),
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
async function waitFor<T>(read: () => Promise<T | null | false>, label: string, timeout = 30_000): Promise<T> {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await read()
    if (value !== null && value !== false) return value
    assert(Date.now() < deadline, label)
    await delay(100)
  }
}
function mediaFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name)
    return entry.isDirectory() ? mediaFiles(file) : /\.(png|jpe?g|webp|wav|m4a|mp3|aiff)$/i.test(file) ? [file] : []
  })
}

/** Root provisions and owns exactly two Mini hosts and forwards before this setup. */
export async function setupProactiveBriefingMiniQa(directory: string) {
  const templatePath = process.env.REMEMBER_QA_BRIEFING_MINI_TEMPLATE
  assert(
    typeof templatePath === 'string' && templatePath.startsWith('/private/tmp/'),
    'An explicit owned Mini template is required'
  )
  mkdirSync(join(directory, 'profile'), { recursive: true, mode: 0o700 })
  const profilePath = realpathSync(join(directory, 'profile'))
  const template = JSON.parse(readFileSync(templatePath, 'utf8'))
  const value = validateBriefingNativeManifest({
    ...template,
    profilePath,
    installationId: briefingQaInstallationId(profilePath),
  })
  assert(value.version === 1)
  assert(value.root.startsWith('/private/tmp/'))
  assert.equal(value.evidenceSourceIds.length, 2)
  assert.equal(value.model, 'gpt-6-astra')
  assert.equal(value.effort, 'low')
  assert(
    value.slots.every((slot) => !/:4783[12]$/.test(slot.endpoint)),
    'Shared provider ports are excluded'
  )
  const corpus = join(repository, 'experiments/proactive-agent/briefing-models')
  const a = JSON.parse(readFileSync(join(corpus, 'inputs/BP01.json'), 'utf8')) as {
    sources: { sourceId: string; text: string }[]
  }
  const b = JSON.parse(readFileSync(join(corpus, 'inputs/BP02.json'), 'utf8')) as typeof a
  const source = (id: string, entry: (typeof a.sources)[number]): Source => ({
    id,
    corpusId: entry.sourceId,
    text: entry.text,
    sha256: hash(entry.text),
  })
  const control: Control = {
    title: 'Atlas — actuele beslisafspraken',
    personal: source(`personal:${value.source.slug}`, a.sources[1]),
    sources: [source(value.evidenceSourceIds[0], a.sources[0]), source(value.evidenceSourceIds[1], b.sources[0])],
    frozenAt: Date.now(),
  }
  const manifestPath = join(directory, names.manifest),
    controlPath = join(directory, names.control),
    proofPath = join(directory, names.proof)
  writeFileSync(manifestPath, json(value), { mode: 0o600 })
  writeFileSync(controlPath, json(control), { mode: 0o600 })
  writeFileSync(join(directory, names.packets), '', { mode: 0o600 })
  writeFileSync(
    join(directory, 'proactive-briefing-mini-freeze.json'),
    json({
      frozenAt: control.frozenAt,
      templatePath,
      templateHash: hash(readFileSync(templatePath)),
      manifestHash: hash(readFileSync(manifestPath)),
      controlHash: hash(readFileSync(controlPath)),
      files: ['inputs/BP01.json', 'inputs/BP02.json', 'prompt.v1.txt', 'schema.v1.json', 'oracle.v1.json'].map(
        (file) => ({ file, sha256: hash(readFileSync(join(corpus, file))) })
      ),
      observer: { model: 'gpt-5.6-luna', effort: 'low', maxCalls: 2, maxCallsPerSource: 1 },
      synthesis: { model: value.model, effort: value.effort, maxCalls: 2 },
      boundary:
        'BP01 exact substantive source text with native identities and timestamps. B reuses only BP02 context with the unchanged BP01 Personal page; B is a Stop control, not a BP02 utility claim. No ordinary chat call.',
    }),
    { mode: 0o600 }
  )
  return { manifestPath, controlPath, proofPath }
}

export const seedProactiveBriefingMiniProfile = seedProactiveBriefingProfile

/** Instrumentation is confined to the disposable copy; all model decisions remain real. */
export function installProactiveBriefingMiniFixture(desktopDirectory: string) {
  assert(!desktopDirectory.endsWith('/apps/desktop'))
  const value = manifest(),
    directory = dirname(value.profilePath)
  const control = JSON.parse(readFileSync(join(directory, names.control), 'utf8')) as Control
  const providerHome = process.env.REMEMBER_QA_CODEX_HOME
  assert(
    typeof providerHome === 'string' && providerHome.startsWith('/') && existsSync(providerHome),
    'Use an existing provider home in place'
  )
  installProactiveAgentFixture(desktopDirectory, { skipCodexFixture: true })
  useExistingQaCodexHome(desktopDirectory, providerHome)
  replaceOnce(
    join(desktopDirectory, 'src/main/dailyReview/index.ts'),
    /const context: DailyReviewContextMoment = \{ id: randomUUID\(\), bundleId, \.\.\.capturedContext \}/,
    `const context: DailyReviewContextMoment = { id: (${json(control.sources)}).find(source => source.text === capturedContext.text)?.id ?? randomUUID(), bundleId, ...capturedContext }`
  )
  replaceOnce(
    join(desktopDirectory, 'proactive-context-fixture.cjs'),
    / {2}send\(event\);/,
    `  send(event); fs.writeFileSync(${JSON.stringify(join(desktopDirectory, 'proactive-native-input.json'))}, JSON.stringify({text:''}));`
  )
  const analyzer = join(desktopDirectory, 'src/main/dailyReview/analyzer.ts')
  replaceOnce(
    analyzer,
    /import \{ appendFileSync, mkdtempSync, rmSync \} from 'node:fs'/,
    "import { appendFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'"
  )
  const inference = JSON.stringify(join(desktopDirectory, 'proactive-inference.jsonl'))
  replaceOnce(
    analyzer,
    / {4}appendFileSync\([^\n]+kind: 'start'[^\n]+\n/,
    `    const qaStarts = readFileSync(${inference}, 'utf8').split('\\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.kind === 'start')
    const qaEvidence = JSON.parse(options.prompt).evidence as { evidenceId: string }[]
    const qaIds = qaEvidence.map(source => source.evidenceId)
    if (model !== 'gpt-5.6-luna' || effort !== 'low' || !options.toolsDisabled || qaStarts.length >= 2 || qaIds.length !== 1 || !${JSON.stringify(control.sources.map((source) => source.id))}.includes(qaIds[0]) || qaStarts.some(row => JSON.parse(row.prompt).evidence.some((source: { evidenceId: string }) => qaIds.includes(source.evidenceId)))) throw new Error('qa-mini-observer-call-boundary')
    appendFileSync(${inference}, JSON.stringify({ kind: 'start', at: Date.now(), model, effort, toolsDisabled: options.toolsDisabled, prompt: options.prompt, systemPrompt: options.systemPrompt }) + '\\n')
`
  )
  replaceOnce(
    analyzer,
    /usage: turn\.usage, output: turn\.finalResponse/,
    'usage: turn.usage, threadId: thread.id, output: turn.finalResponse'
  )
  const core = join(desktopDirectory, 'src/main/briefingNativeCore.ts')
  writeFileSync(core, `import { appendFileSync } from 'node:fs'\n${readFileSync(core, 'utf8')}`)
  replaceOnce(
    core,
    / {8}void service\.startAdmitted\(admitted\.envelope\.actionId\)\.catch\(options\.error\)/,
    `        appendFileSync(${JSON.stringify(join(directory, names.packets))}, JSON.stringify({ at: Date.now(), envelope: admitted.envelope, prepared: admitted.prepared }) + '\\n')
        void service.startAdmitted(admitted.envelope.actionId).catch(options.error)`
  )
}

export async function proactiveBriefingMiniQa({
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
  const value = manifest(),
    profile = value.profilePath
  const control = JSON.parse(readFileSync(join(directory, names.control), 'utf8')) as Control
  const proof: Row = {
    startedAt: Date.now(),
    manifest: value,
    control,
    independentMiniReadback: 'pending-root-verification',
    utility: 'pending-independent-BP01-review',
    boundary:
      'Real native Electron, real small local observer and two preprovisioned Mini synthesis slots. Synthetic one-shot context ingress; snapshot-only exact-ID mapping, call cap and pre-dispatch packet logging. No physical capture, audio, new OAuth, ordinary chat, shared provider or production profile.',
  }
  const save = () => writeFileSync(join(directory, names.proof), json(proof))
  const connections: BriefingConnection[] = [],
    pids: number[] = []
  let page: Page | null = null
  const currentPage = () => {
    assert(page, 'Native page must be open')
    return page
  }
  const inference = () => lines(join(desktopDirectory, 'proactive-inference.jsonl'))
  const state = () => currentPage().evaluate(() => window.remember.getAssistantConversation())
  const row = (index: number) =>
    nativeFacts(profile).resident.assistant_initiative_action.find((entry) => entry.job_id === value.slots[index].jobId)
  const action = (conversation: AssistantConversation, index: number) => {
    const current = row(index)
    return current
      ? (conversation.messages.find((message) => message.id === current.assistant_message_id)?.briefingAction ?? null)
      : null
  }
  const snapshot = async (index: number): Promise<BriefingObservation | null> => {
    const current = row(index)
    if (!current) return null
    const prepared = JSON.parse(String(current.prepared_json)) as InitiativePrepared
    const d = prepared.descriptor
    try {
      return validateBriefingObservation(
        await connections[index].request('snapshot', {
          actionId: d.actionId,
          jobId: d.jobId,
          inputHash: d.inputHash,
          afterSeq: 0,
        }),
        d
      )
    } catch (error) {
      if (
        error instanceof Error &&
        /briefing-(binding-mismatch|job-missing)/.test(error.message) &&
        ['prepared', 'dispatch-intent'].includes(String(current.state))
      )
        return null
      throw error
    }
  }
  const observerBoundary = (index: number) => {
    const starts = inference().filter((entry) => entry.kind === 'start')
    assert(starts.length <= index + 1, 'No extra observer invocation')
    const completed = inference().filter((entry) => entry.kind === 'completed')[index]
    if (completed)
      assert.equal(
        JSON.parse(String(completed.output)).initiative.kind,
        'private-briefing',
        'Real observer did not nominate a briefing; preserve the miss without retry'
      )
  }
  const keyboard = async (button: ReturnType<Page['getByRole']>) => {
    await button.focus()
    assert(await button.evaluate((element) => document.activeElement === element))
    await button.press('Enter')
  }
  const start = async () => {
    page = await launch()
    page.setDefaultTimeout(20_000)
    await page.setViewportSize({ width: 720, height: 900 })
    const pid = getElectron()?.process().pid
    assert(pid)
    pids.push(pid)
    await page.goto(`${new URL(page.url()).origin}/assistant/`)
    await waitFor(async () => (await state()).briefingsEnabled || null, 'Native briefing owner enabled')
    assert.equal((await page.evaluate(() => window.remember.getSettings())).audioCaptureEnabled, false)
  }
  const quit = async (label: string) => {
    const pid = pids.at(-1)
    assert(pid)
    await close()
    page = null
    await waitFor(async () => gone(pid) || null, 'Full native quit must remove PID', 15_000)
    const target = join(directory, label)
    mkdirSync(target, { recursive: true })
    for (const [name, relative] of [
      ['evidence', 'daily-review/evidence.sqlite'],
      ['resident', 'daily-review/assistant/conversation.sqlite'],
    ]) {
      for (const suffix of ['', '-wal', '-shm']) {
        const source = join(profile, relative + suffix)
        if (existsSync(source)) copyFileSync(source, join(target, `${name}.sqlite${suffix}`))
      }
    }
    proof[label] = { pid, gone: true, at: Date.now(), closedNative: nativeFacts(profile) }
    save()
  }
  try {
    proof.hello = []
    for (const slot of value.slots) {
      const connection = await connectBriefingTcp(slot.endpoint)
      connections.push(connection)
      const hello = (await connection.request('hello')) as Row
      assert.equal(hello.protocol, BRIEFING_PROTOCOL)
      assert.equal(hello.capability, 'private-briefing-v1')
      for (const key of ['targetId', 'targetEpoch'] as const) assert.equal(hello[key], value[key])
      for (const key of ['jobId', 'directory', 'workspace'] as const) assert.equal(hello[key], slot[key])
      proof.hello ??= [] as unknown[] as Row[keyof Row]
      ;(proof.hello as unknown[]).push({ at: Date.now(), hello })
    }
    await start()
    const initial = nativeFacts(profile)
    assert.equal(initial.resident.assistant_message.length, 0)
    assert.equal(initial.resident.assistant_initiative_action.length, 0)
    const slug = value.source.slug,
      title = control.title
    const created = (
      await currentPage().evaluate(
        ({ slug, title }) => window.remember.createWikiPage({ spaceId: 'personal', category: 'projects', slug, title }),
        { slug, title }
      )
    ).find((entry) => entry.slug === slug)
    assert(created?.revision)
    const personal = (
      await currentPage().evaluate(
        ({ slug, title, content, revision }) =>
          window.remember.saveWikiPage({
            spaceId: 'personal',
            slug,
            title,
            content,
            expectedRevision: revision,
            strictRevision: true,
          }),
        { slug, title, content: control.personal.text, revision: created.revision }
      )
    ).find((entry) => entry.slug === slug)
    assert(personal?.revision)
    assert.equal(personal.content, control.personal.text)
    proof.personal = personal
    await currentPage().evaluate(() =>
      window.remember.createWorkItem({
        title: 'Handmatige Mini QA-controle blijft open',
        description: 'Niet aan een initiatief gekoppeld.',
      })
    )
    const baseline = nativeFacts(profile),
      mediaBefore = mediaFiles(profile)
    proof.baseline = baseline
    const invariant = () => {
      const current = nativeFacts(profile)
      assert.deepEqual(current.evidence.work_item, baseline.evidence.work_item)
      assert.deepEqual(current.evidence.audio_evidence, baseline.evidence.audio_evidence)
      assert.equal(current.resident.assistant_message.filter((message) => message.role === 'user').length, 0)
      return current
    }
    await currentPage().evaluate(() =>
      window.remember.updateSettings({
        liveTaskUpdates: true,
        audioCaptureEnabled: false,
        capturePaused: false,
        captureSchedule: { enabled: false, weekdays: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00' },
      })
    )
    await currentPage().evaluate(() => window.remember.resumeCapture())
    await waitFor(
      async () =>
        ((await currentPage().evaluate(() => window.remember.getState())).status === 'recording' &&
          nativeFacts(profile).evidence.proactive_consumer.some((entry) => entry.enabled === 1)) ||
        null,
      'Synthetic ingress and proactive consumer ready'
    )
    const dialog = () => currentPage().getByRole('dialog')
    await keyboard(currentPage().getByRole('button', { name: 'Privévoorwerk toestaan', exact: true }))
    assert((await dialog().innerText()).includes(slug))
    assert((await dialog().innerText()).includes(value.targetLabel))
    await keyboard(dialog().getByRole('button', { name: 'Annuleren', exact: true }))
    assert.equal(nativeFacts(profile).resident.assistant_standing_grant.length, 0)
    assert.equal(inference().length, 0)
    assert.equal(lines(join(directory, names.packets)).length, 0)
    proof.previewCancelledAt = Date.now()
    await keyboard(currentPage().getByRole('button', { name: 'Privévoorwerk toestaan', exact: true }))
    await currentPage().screenshot({ path: join(directory, 'mini-briefing-grant-720.png') })
    await keyboard(dialog().getByRole('button', { name: 'Toestaan', exact: true }))
    const grant = await waitFor(async () => (await state()).briefingGrant ?? null, 'Visible grant persisted')
    assert.equal(grant.remainingJobs, 2)
    proof.grant = grant
    const emit = (index: number) => {
      proof[index === 0 ? 'sourceAAt' : 'sourceBAt'] = Date.now()
      writeFileSync(join(desktopDirectory, 'proactive-native-input.json'), json({ text: control.sources[index].text }))
      save()
    }
    emit(0)
    const a = await waitFor(
      async () => {
        observerBoundary(0)
        const found = action(await state(), 0)
        if (found && ['withheld', 'stopped', 'cancelled'].includes(found.state))
          throw Error(`A did not complete: ${found.state}`)
        return found?.state === 'completed' && found.result ? found : null
      },
      'A real observer and Mini synthesis must yield one completed briefing',
      170_000
    )
    const rowA = row(0),
      hostA = await snapshot(0)
    assert(rowA)
    assert(hostA?.receipt && hostA.execution?.providerThreadId && hostA.execution.pid)
    assert.equal(hostA.phase, 'completed')
    assert.equal(hostA.execution.exit?.code, 0)
    assert.equal(hostA.events.filter((event) => event.type === 'write-intent').length, 1)
    assert.equal(hostA.events.filter((event) => event.type === 'write-consumed').length, 1)
    const d = hostA.descriptor
    const readback = validateBriefingResult(
      await connections[0].request('read-result', {
        actionId: d.actionId,
        jobId: d.jobId,
        inputHash: d.inputHash,
        resultId: hostA.receipt.resultId,
      }),
      d
    )
    const result = JSON.parse(String(rowA.result_json)) as BriefingResult
    assert.deepEqual(readback, result)
    assert.equal(hash(result.content), result.receipt.contentHash)
    assert.equal(Buffer.byteLength(result.content), result.receipt.byteLength)
    const frozenA = lines(join(directory, names.packets))[0]
    const preparedA = frozenA.prepared as InitiativePrepared
    const packetA = JSON.parse(preparedA.spec.preparedInput.prompt) as {
      sources: { sourceId: string; text: string }[]
    }
    assert.equal(preparedA.spec.preparedInput.model, value.model)
    assert.equal(preparedA.spec.preparedInput.effort, value.effort)
    assert.deepEqual(preparedA.spec.preparedInput.tools, [])
    assert.equal(
      packetA.sources.find((source) => source.sourceId === control.sources[0].id)?.text,
      control.sources[0].text
    )
    assert.equal(packetA.sources.find((source) => source.sourceId === control.personal.id)?.text, control.personal.text)
    const sourceCard = currentPage().locator(`[data-proactive-decision="${rowA.decision_id}"]`)
    await keyboard(sourceCard.locator('summary'))
    const observerA = JSON.parse(String(inference().find((entry) => entry.kind === 'completed')?.output)) as {
      initiative: { supportingQuotes: { sourceId: string; quote: string }[] }
    }
    const visibleQuotes = observerA.initiative.supportingQuotes.filter(
      (quote) => quote.sourceId === control.sources[0].id
    )
    assert(visibleQuotes.length)
    const sourceCardText = await sourceCard.textContent()
    for (const quote of visibleQuotes) {
      assert(control.sources[0].text.includes(quote.quote))
      assert(sourceCardText?.includes(quote.quote))
    }
    await currentPage().screenshot({ path: join(directory, 'mini-briefing-a-source-720.png') })
    await keyboard(
      currentPage()
        .locator(`[data-briefing-action="${a.actionId}"]`)
        .getByRole('button', { name: 'Concept openen', exact: true })
    )
    await dialog().getByRole('heading', { name: title, exact: true }).waitFor()
    await currentPage().screenshot({ path: join(directory, 'mini-briefing-a-result-720.png') })
    await currentPage().setViewportSize({ width: 420, height: 850 })
    await currentPage().screenshot({ path: join(directory, 'mini-briefing-a-result-420.png') })
    await keyboard(dialog().getByRole('button', { name: 'Sluiten', exact: true }))
    await currentPage().setViewportSize({ width: 720, height: 900 })
    const beforeRestart = invariant()
    proof.a = {
      action: a,
      row: rowA,
      host: hostA,
      readback,
      frozenPacket: frozenA,
      native: beforeRestart,
      observedAt: Date.now(),
    }
    writeFileSync(join(directory, 'mini-briefing-a-result.md'), result.content)
    save()
    await quit('mini-quit-a')
    await start()
    const restoredA = await waitFor(async () => action(await state(), 0), 'A restored')
    assert.deepEqual(restoredA, a)
    assert.equal(row(0)?.result_json, rowA.result_json)
    assert.equal(row(0)?.terminal_received_at, rowA.terminal_received_at)
    assert.equal(inference().filter((entry) => entry.kind === 'start').length, 1)
    assert.equal(lines(join(directory, names.packets)).length, 1)
    proof.restartA = { action: restoredA, at: Date.now(), native: invariant() }
    const messageA = beforeRestart.resident.assistant_message.find((message) => message.id === a.messageId)
    assert(messageA)
    const earliestB = Number(messageA.created_at) + 61_000
    proof.attentionInterval = { earliestB, beganAt: Date.now() }
    while (Date.now() < earliestB) await delay(Math.min(1000, earliestB - Date.now()))
    emit(1)
    const beforeB = await waitFor(
      async () => {
        observerBoundary(1)
        const observed = await snapshot(1)
        if (observed && !['accepted', 'executing'].includes(observed.phase))
          throw Error(`B Stop race lost before control: ${observed.phase}`)
        return observed?.phase === 'executing' && observed.execution?.pid ? observed : null
      },
      'Observe B actual Mini executor invocation before Stop',
      60_000
    )
    const b = action(await state(), 1)
    assert(b)
    const observedAt = Date.now()
    assert.equal(beforeB.writeIntent, null)
    const controls = await currentPage().evaluate(
      async ({ a, b }) => {
        let historical: string | null = null
        let mismatch: string | null = null

        try {
          if (!window.remember.controlAssistantBriefing) throw Error('Native briefing control missing')
          await window.remember.controlAssistantBriefing({
            actionId: a.actionId,
            messageId: a.messageId,
            command: 'check',
          })
        } catch (error) {
          historical = String(error)
        }

        try {
          if (!window.remember.controlAssistantBriefing) throw Error('Native briefing control missing')
          await window.remember.controlAssistantBriefing({
            actionId: a.actionId,
            messageId: b.messageId,
            command: 'stop',
          })
        } catch (error) {
          mismatch = String(error)
        }

        return { historical, mismatch, at: Date.now() }
      },
      { a, b }
    )
    assert(controls.historical && controls.mismatch, 'Historical or mismatched A control must not control B')
    assert.match(controls.historical, /briefing-operation-busy/)
    assert.match(controls.mismatch, /briefing-binding-conflict/)
    const afterControls = await snapshot(1)
    assert(afterControls, 'B must remain observable after historical controls')
    assert.deepEqual(afterControls.descriptor, beforeB.descriptor)
    assert.equal(afterControls.sessionId, beforeB.sessionId)
    assert.equal(afterControls.execution?.invocationId, beforeB.execution?.invocationId)
    assert.equal(afterControls.execution?.pid, beforeB.execution?.pid)
    assert.equal(afterControls.execution?.exit, null)
    assert.equal(afterControls.phase, 'executing', 'B Stop race lost during historical controls')
    assert.equal(afterControls.writeIntent, null)
    assert.equal(afterControls.receipt, null)
    assert.equal(
      afterControls.events.filter((event) => ['stop-requested', 'stopped', 'write-intent'].includes(event.type)).length,
      0
    )
    const stop = currentPage()
      .locator(`[data-briefing-action="${b.actionId}"]`)
      .getByRole('button', { name: 'Stoppen', exact: true })
    await stop.focus()
    assert(await stop.evaluate((element) => document.activeElement === element))
    await currentPage().screenshot({ path: join(directory, 'mini-briefing-b-stop-focus-720.png') })
    const stopStartedAt = Date.now()
    await keyboard(stop)
    const stopped = await waitFor(
      async () => {
        const found = action(await state(), 1)
        if (found?.state === 'completed')
          throw Error('B Stop race lost: completed result must not be relabelled stopped')
        return found?.state === 'stopped' ? found : null
      },
      'B Stop must confirm actual execution exit before write',
      20_000
    )
    const afterB = await snapshot(1)
    assert(afterB?.execution?.exit)
    assert.equal(afterB.phase, 'stopped')
    assert.equal(afterB.execution.pid, beforeB.execution?.pid)
    assert.equal(afterB.writeIntent, null)
    assert.equal(afterB.receipt, null)
    assert.equal(afterB.events.filter((event) => event.type === 'write-intent').length, 0)
    await currentPage().screenshot({ path: join(directory, 'mini-briefing-b-stopped-720.png') })
    proof.b = {
      action: b,
      observedAt,
      before: beforeB,
      controls,
      afterControls,
      stopStartedAt,
      stopped,
      after: afterB,
      native: invariant(),
    }
    assert.equal(inference().filter((entry) => entry.kind === 'start').length, 2)
    assert.equal(lines(join(directory, names.packets)).length, 2)
    save()
    await quit('mini-quit-b')
    await start()
    const restored = await state()
    assert.deepEqual(action(restored, 0), a)
    assert.deepEqual(action(restored, 1), stopped)
    assert.equal(row(0)?.result_json, rowA.result_json)
    assert.equal(row(0)?.terminal_received_at, rowA.terminal_received_at)
    assert.equal(restored.briefingGrant?.remainingJobs, 0)
    assert.equal(inference().filter((entry) => entry.kind === 'start').length, 2)
    assert.equal(lines(join(directory, names.packets)).length, 2)
    assert.deepEqual(mediaFiles(profile), mediaBefore)
    const finalA = await snapshot(0),
      finalB = await snapshot(1)
    assert.equal(finalA?.phase, 'completed')
    assert.deepEqual(finalA?.receipt, hostA.receipt)
    assert.deepEqual(finalA?.execution, hostA.execution)
    assert.equal(finalB?.phase, 'stopped')
    assert.deepEqual(finalB?.execution, afterB.execution)
    assert.equal(finalB?.writeIntent, null)
    assert.equal(finalB?.receipt, null)
    proof.final = {
      restored,
      native: invariant(),
      hosts: [finalA, finalB],
      inference: inference(),
      at: Date.now(),
    }
    await currentPage().screenshot({ path: join(directory, 'mini-briefing-restarted-720.png') })
    await currentPage().evaluate(() =>
      window.remember.pauseCapture({ durationMs: null, sources: ['audio', 'capture'] })
    )
    await quit('mini-final-close')
    proof.status = 'native-transport-passed-pending-independent-readback-and-utility'
    proof.nativePids = pids.map((pid) => ({ pid, gone: gone(pid) }))
    proof.completedAt = Date.now()
    checks.push(
      'Mini native flow: visible grant, real observer A, verified TCP result, B actual invocation stopped before write, and two full quits preserve A/B and human Task rows; independent Mini filesystem readback and BP01 utility remain separate'
    )
    save()
  } catch (error) {
    proof.status = 'failed'
    proof.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
    try {
      proof.failureFacts = nativeFacts(profile)
      proof.failureHosts = [await snapshot(0), await snapshot(1)]
    } catch (failure) {
      proof.failureReadError = String(failure)
    }
    if (page) {
      try {
        await page.evaluate(() => window.remember.pauseCapture({ durationMs: null, sources: ['audio', 'capture'] }))
        proof.failureCapturePause = { at: Date.now(), completed: true }
      } catch (pauseError) {
        proof.failureCapturePause = { at: Date.now(), completed: false, error: String(pauseError) }
      }
    }
    save()
    throw error
  } finally {
    if (page) await close()
    for (const connection of connections) connection.close()
    for (const file of ['proactive-context.jsonl', 'proactive-inference.jsonl']) {
      const source = join(desktopDirectory, file)
      if (existsSync(source)) copyFileSync(source, join(directory, `mini-${file}`))
    }
  }
}
