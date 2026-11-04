import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import {
  type AssistantConversation,
  agentComputerExecutionKey,
  normalizeAgentComputer,
  type RememberBridge,
} from '@remember/shared'
import type { ElectronApplication, Page } from 'playwright-core'
import {
  type BriefingNativeManifest,
  briefingQaInstallationId,
  validateBriefingNativeManifest,
} from '../../src/main/briefingNativeCore'
import { DEFAULT_SETTINGS } from '../../src/main/settingsStore'
import { installProactiveAgentFixture } from './proactive-agent'

declare global {
  interface Window {
    remember: RememberBridge
  }
}

type Row = Record<string, unknown>
type Setup = {
  root: string
  manifestPath: string
  childPids: number[]
  sources: { id: string; text: string; topic: string }[]
}
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const json = (value: unknown) => JSON.stringify(value, null, 2)
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const chatQuestion = 'briefing-qa-chat: geef alleen de synthetische bevestiging.'
const chatAnswer = 'De gewone chat werkt terwijl Cedar bezig is.'
const record = (file: string, value: unknown) => appendFileSync(file, `${JSON.stringify(value)}\n`)
const lines = (file: string): Row[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []
async function waitFor<T>(read: () => Promise<T | null | false>, label: string, timeout = 30_000): Promise<T> {
  const deadline = Date.now() + timeout
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
function manifest() {
  const file = process.env.REMEMBER_QA_BRIEFING_MANIFEST
  assert(file && file.startsWith('/private/tmp/'), 'Own absolute briefing manifest required')
  return validateBriefingNativeManifest(JSON.parse(readFileSync(file, 'utf8')))
}
function readRows(filename: string, tables: string[]) {
  const db = new DatabaseSync(filename, { readOnly: true })
  try {
    return Object.fromEntries(
      tables.map((table) => [
        table,
        db
          .prepare(`SELECT * FROM ${table}`)
          .all()
          .map((row) => ({ ...row })),
      ])
    )
  } finally {
    db.close()
  }
}
function hostFacts(slot: BriefingNativeManifest['slots'][number]) {
  const rows = readRows(join(slot.directory, 'briefing.sqlite'), ['metadata', 'job', 'event', 'write_intent'])
  const job = rows.job[0]
  return {
    metadata: rows.metadata,
    job: rows.job,
    event: rows.event,
    write_intent: rows.write_intent,
    parsed: job
      ? {
          descriptor: JSON.parse(String(job.descriptor)),
          spec: JSON.parse(String(job.spec)),
          state: JSON.parse(String(job.state)),
        }
      : null,
  }
}
function nativeFacts(profile: string) {
  return {
    evidence: readRows(join(profile, 'daily-review/evidence.sqlite'), [
      'work_item',
      'audio_evidence',
      'context_evidence',
      'proactive_consumer',
      'proactive_event',
      'proactive_considered',
      'proactive_decision',
    ]),
    resident: readRows(join(profile, 'daily-review/assistant/conversation.sqlite'), [
      'assistant_message',
      'assistant_proactive_initiative',
      'assistant_standing_grant',
      'assistant_initiative_action',
    ]),
  }
}
function filesAt(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesAt(join(directory, entry.name)) : [join(directory, entry.name)]
  )
}
function archiveClosed(profile: string, target: string) {
  mkdirSync(target, { recursive: true })
  for (const [label, relative] of [
    ['evidence', 'daily-review/evidence.sqlite'],
    ['resident', 'daily-review/assistant/conversation.sqlite'],
  ]) {
    for (const suffix of ['', '-wal', '-shm']) {
      const source = join(profile, relative + suffix)
      if (existsSync(source)) copyFileSync(source, join(target, label + '.sqlite' + suffix))
    }
  }
}
async function rpc(socketPath: string, method: string, payload: Row = {}): Promise<Row> {
  return new Promise((accept, reject) => {
    const socket = createConnection(socketPath)
    let text = '',
      settled = false
    const finish = (error?: Error, value?: Row) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else {
        assert(value)
        accept(value)
      }
    }
    const timer = setTimeout(() => finish(Error(`Owned briefing ${method} timed out`)), 10_000)
    socket.once('error', (error) => finish(error))
    socket.once('connect', () => socket.write(JSON.stringify({ id: 1, method, payload }) + '\n'))
    socket.on('data', (chunk) => {
      text += chunk.toString()
      if (text.length > 65536) {
        finish(Error('Owned briefing frame bound'))
        return
      }
      if (!text.includes('\n')) return
      try {
        const response = JSON.parse(text.slice(0, text.indexOf('\n')))
        assert.equal(response.id, 1)
        finish(response.error ? Error(response.error.message) : undefined, response.result)
      } catch (error) {
        finish(error as Error)
      }
    })
  })
}

/** Own local hosts only. No Mini, shared provider, cloud, or model connection. */
export async function setupProactiveBriefingQa(runDirectory: string) {
  const nonce = randomUUID().slice(0, 8)
  const root = `/private/tmp/rpa3-native-${nonce}`
  mkdirSync(root, { mode: 0o700 })
  mkdirSync(join(runDirectory, 'profile'), { recursive: true, mode: 0o700 })
  const profilePath = realpathSync(join(runDirectory, 'profile'))
  const setup: Setup = {
    root,
    manifestPath: join(root, 'manifest.json'),
    childPids: [],
    sources: [
      {
        id: `brief-${nonce}-atlas`,
        topic: 'atlas-prijsreview',
        text: 'Atlas: over twintig minuten bespreken we de prijsvariant. De vaste prijs is nog niet gekozen; de review moet de ontbrekende invoer en drie gerichte vragen helder maken.',
      },
      {
        id: `brief-${nonce}-cedar`,
        topic: 'cedar-launch-review',
        text: 'Cedar: the launch review starts in twenty minutes. The rollout date is still undecided; we need the missing inputs and three focused questions for the review.',
      },
    ],
  }
  const value: BriefingNativeManifest = {
    version: 1,
    profilePath,
    installationId: briefingQaInstallationId(profilePath),
    targetId: `briefing-native-${nonce}`,
    targetEpoch: `epoch-${nonce}`,
    root,
    targetLabel: 'Lokale testcomputer',
    source: { spaceId: 'personal', slug: `projects/briefing-qa-${nonce}` },
    evidenceSourceIds: setup.sources.map((source) => source.id),
    model: 'gpt-6-astra',
    effort: 'low',
    maxDurationMs: 120_000,
    computerExecutionKey: agentComputerExecutionKey(
      normalizeAgentComputer({ kind: 'remote', endpoint: 'ws://127.0.0.1:47832/', workspace: root })
    ),
    slots: ['a', 'b'].map((name) => {
      const jobId = `briefing-${nonce}-${name}`,
        directory = join(root, 'jobs', hash(jobId).slice(0, 24))
      mkdirSync(join(directory, 'workspace'), { recursive: true, mode: 0o700 })
      return { jobId, directory, workspace: join(directory, 'workspace'), endpoint: '' }
    }),
  }
  const auth = join(root, 'fake-auth')
  mkdirSync(auth, { mode: 0o700 })
  writeFileSync(join(auth, 'auth.json'), '{}', { mode: 0o600 })
  const fixture = join(root, 'briefing-codex-fixture.cjs'),
    trace = join(root, 'host-sdk.jsonl')
  writeFileSync(trace, '')
  writeFileSync(
    fixture,
    `#!${process.execPath}
const fs=require('node:fs');const log=value=>fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({at:Date.now(),pid:process.pid,...value})+'\\n');const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
if(!process.argv.includes('exec'))throw Error('Only SDK exec expected');log({kind:'exec-start',argv:process.argv.slice(2)});
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
 log({kind:'exec-input',input});const prefix=fs.readFileSync(${JSON.stringify(join(repository, 'experiments/proactive-agent/briefing-models/prompt.v1.txt'))},'utf8');if(!input.startsWith(prefix+'\\n'))throw Error('Exact instruction prefix required');const packet=JSON.parse(input.slice(prefix.length+1));const source=packet.sources.find(s=>${JSON.stringify(setup.sources.map((source) => source.id))}.includes(s.sourceId));if(!source)throw Error('Selected synthetic source missing');const index=${JSON.stringify(setup.sources.map((source) => source.id))}.indexOf(source.sourceId);log({kind:'accepted',index,sourceId:source.sourceId,packet});send({type:'thread.started',thread_id:'briefing-native-'+process.pid});send({type:'turn.started'});
 if(index===1){log({kind:'held'});const timer=setInterval(()=>{},1000);for(const signal of ['SIGTERM','SIGINT','SIGHUP'])process.on(signal,()=>{log({kind:'cancelled',signal});clearInterval(timer);process.exit(0)});return}
 const personal=packet.sources.find(s=>s.kind==='personal-page');if(!personal)throw Error('Personal source missing');const q={sourceId:source.sourceId,quote:source.text};const p={sourceId:personal.sourceId,quote:'Atlas: de volumeschatting en acceptatiecriteria ontbreken.'};if(!personal.text.includes(p.quote))throw Error('Exact Personal quote missing');const line=(text,quote=q)=>({text,quotes:[quote]});
 const answer={version:1,kind:'private-briefing',reason:line('De prijsreview komt eraan en de keuze staat nog open.'),briefing:{title:'Atlas: voorbereiding prijsreview',decision:line('Bepaal welke invoer nodig is voordat de vaste prijs kan worden gekozen.'),facts:[line('De prijsvariant wordt tijdens de review besproken.'),line('De volumeschatting en acceptatiecriteria ontbreken.',p)],openPoints:[line('De vaste prijs is nog niet gekozen.')],questions:[line('Welke prijsvariant willen we toetsen?'),line('Wie brengt de volumeschatting mee?',p),line('Welke acceptatiecriteria zijn beslissend?',p)]}};
 log({kind:'answer',answer});send({type:'item.completed',item:{id:'briefing-answer',type:'agent_message',text:JSON.stringify(answer)}});send({type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:0,output_tokens:10}});log({kind:'completed'});
});
`,
    { mode: 0o700 }
  )
  const children: ChildProcess[] = [],
    servers: Server[] = [],
    sockets = new Set<Socket>()
  let cleaned = false
  const cleanup = async () => {
    if (cleaned) return
    cleaned = true
    const errors: string[] = [],
      proof: Row = { children: [], errors, startedAt: Date.now() }
    for (const [index, child] of children.entries()) {
      const slot = value.slots[index]
      try {
        if (child.exitCode === null && child.signalCode === null) {
          const before = hostFacts(slot)
          writeFileSync(join(root, `cleanup-${index}-before.json`), json(before))
          if (before.parsed && !['completed', 'stopped', 'unknown'].includes(before.parsed.state.phase)) {
            const d = before.parsed.descriptor
            const stopped = await rpc(join(slot.directory, 'briefing.sock'), 'stop', {
              actionId: d.actionId,
              jobId: d.jobId,
              inputHash: d.inputHash,
            })
            assert(['completed', 'stopped', 'unknown'].includes(String(stopped.phase)))
            writeFileSync(join(root, `cleanup-${index}-stop.json`), json(stopped))
          }
          child.kill('SIGTERM')
          await waitFor(
            async () => child.exitCode !== null || child.signalCode !== null,
            'Own briefing host must close',
            10_000
          )
        }
        assert.equal(child.exitCode, 0)
      } catch (error) {
        errors.push(`host-${index}: ${String(error)}`)
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }
      try {
        if (child.pid) await waitFor(async () => gone(child.pid!) || null, 'Own host PID must exit', 10_000)
      } catch (error) {
        errors.push(String(error))
      }
      const socket = join(slot.directory, 'briefing.sock')
      if (child.pid && gone(child.pid) && existsSync(socket)) unlinkSync(socket)
      ;(proof.children as Row[]).push({
        pid: child.pid,
        exitCode: child.exitCode,
        signalCode: child.signalCode,
        gone: child.pid ? gone(child.pid) : null,
        socket,
        socketAbsent: !existsSync(socket),
      })
    }
    for (const socket of sockets) socket.destroy()
    for (const server of servers) await new Promise<void>((done) => server.close(() => done()))
    proof.finishedAt = Date.now()
    proof.serversClosed = servers.every((server) => !server.listening)
    copyFileSync(trace, join(runDirectory, 'briefing-host-sdk-after-cleanup.jsonl'))
    writeFileSync(join(runDirectory, 'proactive-briefing-cleanup.json'), json(proof))
    assert.equal(errors.length, 0, `Own fixture cleanup failed: ${errors.join('; ')}`)
  }
  try {
    for (const [index, slot] of value.slots.entries()) {
      const config = join(root, `host-${index}.json`)
      writeFileSync(
        config,
        json({
          executable: fixture,
          slot: {
            version: 1,
            targetId: value.targetId,
            targetEpoch: value.targetEpoch,
            root,
            jobId: slot.jobId,
            directory: slot.directory,
            workspace: slot.workspace,
          },
        })
      )
      const child = spawn(
        process.execPath,
        [
          '--import',
          join(repository, 'apps/desktop/node_modules/tsx/dist/loader.mjs'),
          join(repository, 'apps/desktop/scripts/briefingHost.ts'),
          config,
        ],
        {
          cwd: join(repository, 'apps/desktop'),
          env: { ...process.env, CODEX_HOME: auth },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      )
      children.push(child)
      child.stderr?.on('data', (data) => appendFileSync(join(root, `host-${index}.stderr`), data))
      await new Promise<void>((accept, reject) => {
        const timer = setTimeout(() => reject(Error('Own briefing host readiness timeout')), 10_000)
        let output = ''
        child.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.once('exit', (code) => {
          clearTimeout(timer)
          reject(Error(`Own briefing host exited before readiness: ${code}`))
        })
        child.stdout?.on('data', (data) => {
          appendFileSync(join(root, `host-${index}.stdout`), data)
          output += data.toString()
          if (!output.includes('\n')) return
          try {
            const ready = JSON.parse(output.slice(0, output.indexOf('\n')))
            assert.equal(ready.type, 'ready')
            assert.equal(ready.pid, child.pid)
            assert.equal(ready.socketPath, join(slot.directory, 'briefing.sock'))
            clearTimeout(timer)
            accept()
          } catch (error) {
            clearTimeout(timer)
            reject(error)
          }
        })
      })
      assert(child.pid)
      setup.childPids.push(child.pid)
      const server = createServer((client) => {
        const upstream = createConnection(join(slot.directory, 'briefing.sock'))
        sockets.add(client)
        sockets.add(upstream)
        let buffer = ''
        client.on('data', (chunk) => {
          buffer += chunk.toString()
          while (buffer.includes('\n')) {
            const at = buffer.indexOf('\n')
            record(join(root, 'native-wire.jsonl'), { index, at: Date.now(), frame: JSON.parse(buffer.slice(0, at)) })
            buffer = buffer.slice(at + 1)
          }
        })
        client.on('close', () => {
          sockets.delete(client)
          upstream.destroy()
        })
        upstream.on('close', () => {
          sockets.delete(upstream)
          client.destroy()
        })
        client.on('error', () => upstream.destroy())
        upstream.on('error', () => client.destroy())
        client.pipe(upstream)
        upstream.pipe(client)
      })
      servers.push(server)
      await new Promise<void>((accept, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', accept)
      })
      const address = server.address()
      assert(address && typeof address !== 'string')
      slot.endpoint = `tcp://127.0.0.1:${address.port}`
    }
    validateBriefingNativeManifest(value)
    writeFileSync(setup.manifestPath, json(value), { mode: 0o600 })
    writeFileSync(join(runDirectory, 'proactive-briefing-setup.json'), json(setup))
    writeFileSync(join(runDirectory, 'proactive-briefing-manifest.json'), json(value))
    return { manifestPath: setup.manifestPath, cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}

export function seedProactiveBriefingProfile(profile: string) {
  const value = manifest()
  assert.equal(realpathSync(profile), value.profilePath)
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
      agentComputer: JSON.parse(value.computerExecutionKey),
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
}
function replaceOnce(file: string, pattern: RegExp, replacement: string) {
  const text = readFileSync(file, 'utf8')
  assert.equal([...text.matchAll(new RegExp(pattern, 'g'))].length, 1, `Exact snapshot boundary ${file}`)
  writeFileSync(file, text.replace(pattern, replacement))
}
export function installProactiveBriefingFixture(desktopDirectory: string) {
  assert(!desktopDirectory.endsWith('/apps/desktop'))
  const value = manifest(),
    runDirectory = dirname(value.profilePath)
  const setup = JSON.parse(readFileSync(join(runDirectory, 'proactive-briefing-setup.json'), 'utf8')) as Setup
  installProactiveAgentFixture(desktopDirectory, { skipCodexFixture: true })
  const runtime = join(desktopDirectory, 'src/main/residentAgentRuntime.ts')
  replaceOnce(
    runtime,
    / {2}const snapshot = async \(beforeMessageId\?: string\) => \{/,
    `  let qaBriefingOpenAction: string | null = null
  let qaBriefingHideResult = false
  let qaBriefingOpenHeld: { value: { title: string; content: string }; resolve: () => void } | null = null
  const qaBriefingOpenEvents: { event: string; at: number }[] = []
  Object.assign(globalThis, { qaBriefingOpenRace: {
    arm(actionId: string) {
      if (qaBriefingOpenHeld || qaBriefingOpenAction) throw new Error('qa-briefing-open-already-armed')
      qaBriefingOpenAction = actionId
      qaBriefingOpenEvents.push({ event: 'armed', at: Date.now() })
    },
    inspect() { return { pending: Boolean(qaBriefingOpenHeld), fetched: qaBriefingOpenHeld?.value ?? null, hidden: qaBriefingHideResult, events: qaBriefingOpenEvents } },
    hide() {
      if (!qaBriefingOpenHeld) throw new Error('qa-briefing-open-not-held')
      qaBriefingHideResult = true
      qaBriefingOpenEvents.push({ event: 'snapshot-result-removed', at: Date.now() })
      notifyConversation()
    },
    release() {
      const held = qaBriefingOpenHeld
      if (!held) throw new Error('qa-briefing-open-not-held')
      qaBriefingOpenHeld = null
      qaBriefingOpenEvents.push({ event: 'old-open-response-released', at: Date.now() })
      held.resolve()
    },
    clear() {
      if (qaBriefingOpenHeld) throw new Error('qa-briefing-open-still-held')
      qaBriefingOpenAction = null; qaBriefingHideResult = false; notifyConversation()
    }
  } })
  const snapshot = async (beforeMessageId?: string) => {`
  )
  replaceOnce(
    runtime,
    / {4}return briefings \? briefings\.enrichSnapshot\(conversation\) : conversation/,
    `    const result = briefings ? briefings.enrichSnapshot(conversation) : conversation
    if (!qaBriefingHideResult) return result
    return { ...result, messages: result.messages.map(message => message.briefingAction?.actionId === qaBriefingOpenAction
      ? { ...message, briefingAction: { ...message.briefingAction, result: undefined, state: 'withheld' as const } } : message) }`
  )
  replaceOnce(
    runtime,
    / {2}ipcMain\.handle\(CHANNELS\.openAssistantBriefing, \(event, input: unknown\) => briefing\(event\)\.openResult\(input\)\)/,
    `  ipcMain.handle(CHANNELS.openAssistantBriefing, async (event, input: unknown) => {
    const opened = await briefing(event).openResult(input)
    if (qaBriefingOpenAction && (input as { actionId?: string }).actionId === qaBriefingOpenAction) {
      qaBriefingOpenEvents.push({ event: 'real-open-result-fetched', at: Date.now() })
      await new Promise<void>(resolve => { qaBriefingOpenHeld = { value: structuredClone(opened), resolve } })
    }
    return opened
  })`
  )

  replaceOnce(
    join(desktopDirectory, 'src/main/dailyReview/index.ts'),
    /const context: DailyReviewContextMoment = \{ id: randomUUID\(\), bundleId, \.\.\.capturedContext \}/,
    `const context: DailyReviewContextMoment = { id: (${JSON.stringify(setup.sources)}).find(source => source.text === capturedContext.text)?.id ?? randomUUID(), bundleId, ...capturedContext }`
  )
  const executable = join(desktopDirectory, 'briefing-observer-fixture.cjs'),
    trace = join(value.root, 'observer-chat.jsonl')
  writeFileSync(trace, '')
  writeFileSync(
    executable,
    `#!${process.execPath}
const fs=require('node:fs');const log=value=>fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({at:Date.now(),pid:process.pid,...value})+'\\n');const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
if(process.argv.includes('--version')){console.log('codex-cli 0.0.0-briefing-qa');process.exit(0)}if(process.argv.includes('login')&&process.argv.includes('status')){console.log('Logged in using ChatGPT');process.exit(0)}if(!process.argv.includes('exec'))throw Error('Only tools-disabled exec expected');log({kind:'exec-start',argv:process.argv.slice(2)});
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
 log({kind:'exec-input',input});send({type:'thread.started',thread_id:'observer-chat-'+process.pid});let answer;
 if(input.startsWith("Interpret newly observed context for Remember's single ongoing chat")){
  const payload=JSON.parse(input.slice(input.lastIndexOf('\\n\\n')+2));const schemaAt=process.argv.indexOf('--output-schema');if(schemaAt<0||!JSON.parse(fs.readFileSync(process.argv[schemaAt+1],'utf8')).properties.initiative.properties.kind.enum.includes('private-briefing'))throw Error('Exact briefing nomination schema required');const evidence=payload.evidence.find(e=>${JSON.stringify(setup.sources)}.some(s=>s.id===e.evidenceId&&s.text===e.text));const source=evidence&&${JSON.stringify(setup.sources)}.find(s=>s.id===evidence.evidenceId);
  answer={consideredEvidenceIds:payload.evidence.map(e=>e.evidenceId),proposed:[],changes:[],initiative:source?{kind:'private-briefing',text:source.topic.startsWith('atlas')?'Ik bereid de prijsreview voor met de ontbrekende invoer en drie vragen.':'I will prepare the Cedar launch review with missing inputs and three questions.',topicKey:source.topic,sourceIds:[source.id],supportingQuotes:[{sourceId:source.id,quote:source.text}]}:{kind:'silent',text:'',topicKey:'',sourceIds:[],supportingQuotes:[]}};log({kind:'analysis',payload,answer});answer=JSON.stringify(answer);
 }else if(input.startsWith('You are Remember in a tools-disabled chat turn.')&&input.includes(${JSON.stringify(chatQuestion)})){answer=${JSON.stringify(chatAnswer)};log({kind:'chat'})}else throw Error('Unexpected SDK request');
 send({type:'item.completed',item:{id:'answer',type:'agent_message',text:answer}});send({type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1}});log({kind:'completed'});
});
`,
    { mode: 0o700 }
  )
  replaceOnce(
    join(desktopDirectory, 'src/main/codexRuntime.ts'),
    /export function bundledCodexExecutable\(\) \{[\s\S]*?\n\}/,
    `export function bundledCodexExecutable() { return ${JSON.stringify(executable)} }`
  )
}

export async function proactiveBriefingQa({
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
    setup = JSON.parse(readFileSync(join(directory, 'proactive-briefing-setup.json'), 'utf8')) as Setup
  const profile = value.profilePath,
    pids: number[] = []
  const proof: Row = {
    startedAt: Date.now(),
    setup,
    manifest: value,
    boundary:
      'Real isolated Electron/IPC/stores/SDK/local host processes and fixed file writer. Synthetic exact-ID AX ingress, deterministic observer/chat/briefing executables. No Mini, real model, cloud, physical capture, audio, release or production profile.',
  }
  const save = () => writeFileSync(join(directory, 'proactive-briefing-proof.json'), json(proof))
  let page: Page | null = null
  const state = async (target: Page) => target.evaluate(() => window.remember.getAssistantConversation())
  const action = (conversation: AssistantConversation, jobIndex: number) => {
    const row = nativeFacts(profile).resident.assistant_initiative_action.find(
      (entry) => entry.job_id === value.slots[jobIndex].jobId
    )
    return row
      ? (conversation.messages.find((message) => message.id === row.assistant_message_id)?.briefingAction ?? null)
      : null
  }
  const start = async () => {
    const target = await launch()
    target.setDefaultTimeout(20_000)
    target.setDefaultNavigationTimeout(90_000)
    await target.setViewportSize({ width: 720, height: 900 })
    assert.equal(await target.evaluate(() => window.innerWidth), 720)
    const pid = getElectron()?.process().pid
    assert(pid)
    pids.push(pid)
    await target.goto(`${new URL(target.url()).origin}/assistant/`)
    await waitFor(async () => (await state(target)).briefingsEnabled || null, 'Native briefing owner must be enabled')
    const settings = await target.evaluate(() => window.remember.getSettings())
    assert.equal(settings.audioCaptureEnabled, false)
    return target
  }
  const quit = async (label: string) => {
    const pid = pids.at(-1)
    assert(pid)
    await close()
    page = null
    await waitFor(async () => gone(pid) || null, 'Native PID must disappear after full quit', 15_000)
    archiveClosed(profile, join(directory, label))
    proof[label] = { pid, gone: true, at: Date.now() }
    save()
  }
  const exactRow = (index: number) => {
    const rows = nativeFacts(profile).resident.assistant_initiative_action.filter(
      (entry) => entry.job_id === value.slots[index].jobId
    )
    assert.equal(rows.length, 1)
    return rows[0]
  }
  const invariant = (baseline: ReturnType<typeof nativeFacts>) => {
    const current = nativeFacts(profile)
    assert.deepEqual(current.evidence.work_item, baseline.evidence.work_item)
    assert.deepEqual(current.evidence.audio_evidence, baseline.evidence.audio_evidence)
    assert.equal(
      current.resident.assistant_message.filter((message) => message.role === 'user').length,
      lines(join(setup.root, 'observer-chat.jsonl')).filter((entry) => entry.kind === 'chat').length
    )
    return current
  }
  const clickKeyboard = async (target: ReturnType<Page['getByRole']>) => {
    await target.waitFor({ state: 'visible' })
    await target.focus()
    assert(await target.evaluate((element) => document.activeElement === element))
    await target.press('Enter')
  }
  try {
    page = await start()
    const initial = nativeFacts(profile)
    assert.equal(initial.resident.assistant_message.length, 0)
    assert.equal(initial.resident.assistant_initiative_action.length, 0)
    proof.hostsBefore = value.slots.map(hostFacts)
    assert((proof.hostsBefore as ReturnType<typeof hostFacts>[]).every((host) => host.parsed === null))
    const slug = value.source.slug,
      title = 'Atlas en Cedar'
    const created = (
      await page.evaluate(
        ({ slug, title }) => window.remember.createWikiPage({ spaceId: 'personal', category: 'projects', slug, title }),
        { slug, title }
      )
    ).filter((entry) => entry.slug === slug)
    assert.equal(created.length, 1)
    assert(created[0].revision)
    const content =
      '# Atlas en Cedar\n\nAtlas: de volumeschatting en acceptatiecriteria ontbreken.\n\nCedar: the launch owner and rollback criteria are undecided.\n\nDit is uitsluitend synthetische QA-context.'
    const pages = await page.evaluate(
      ({ slug, title, content, revision }) =>
        window.remember.saveWikiPage({
          spaceId: 'personal',
          slug,
          title,
          content,
          expectedRevision: revision,
          strictRevision: true,
        }),
      { slug, title, content, revision: created[0].revision }
    )
    const personal = pages.find((entry) => entry.slug === slug)
    assert(personal?.revision)
    proof.personal = personal
    const sentinel = await page.evaluate(() =>
      window.remember.createWorkItem({
        title: 'Handmatige QA-controle blijft open',
        description: 'Deze taak wordt niet aan een initiatief gekoppeld.',
      })
    )
    proof.sentinel = sentinel
    const baseline = nativeFacts(profile)
    proof.baseline = baseline
    const mediaBefore = filesAt(profile).filter((file) => /\.(png|jpe?g|webp|wav|m4a|mp3|aiff)$/i.test(file))
    proof.mediaBefore = mediaBefore
    await page.evaluate(() =>
      window.remember.updateSettings({
        liveTaskUpdates: true,
        audioCaptureEnabled: false,
        capturePaused: false,
        captureSchedule: { enabled: false, weekdays: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00' },
      })
    )
    await page.evaluate(() => window.remember.resumeCapture())
    await waitFor(
      async () =>
        ((await page!.evaluate(() => window.remember.getState())).status === 'recording' &&
          nativeFacts(profile).evidence.proactive_consumer.some((row) => row.enabled === 1)) ||
        null,
      'Synthetic source writer and proactive consumer must start'
    )
    await clickKeyboard(page.getByRole('button', { name: 'Privévoorwerk toestaan', exact: true }))
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('heading', { name: 'Privévoorwerk toestaan', exact: true }).waitFor({ state: 'visible' })
    assert((await dialog.innerText()).includes(slug))
    assert((await dialog.innerText()).includes('Atlas en Cedar'))
    assert((await dialog.innerText()).includes(value.targetLabel))
    await clickKeyboard(dialog.getByRole('button', { name: 'Annuleren', exact: true }))
    assert.equal(nativeFacts(profile).resident.assistant_standing_grant.length, 0)
    assert(
      value.slots.every((slot) => hostFacts(slot).parsed === null && !existsSync(join(slot.workspace, 'briefing.md')))
    )
    proof.previewCancelledAt = Date.now()
    checks.push('Opening and cancelling the exact briefing scope creates no grant, action or host work')
    await clickKeyboard(page.getByRole('button', { name: 'Privévoorwerk toestaan', exact: true }))
    await page.setViewportSize({ width: 720, height: 900 })
    await dialog.getByRole('heading', { name: 'Privévoorwerk toestaan', exact: true }).waitFor({ state: 'visible' })
    await dialog.getByRole('button', { name: 'Toestaan', exact: true }).focus()
    await page.screenshot({ path: join(directory, 'briefing-grant-720.png') })
    await clickKeyboard(dialog.getByRole('button', { name: 'Toestaan', exact: true }))
    const granted = await waitFor(
      async () => (await state(page!)).briefingGrant ?? null,
      'Visible grant confirmation must persist'
    )
    assert.equal(granted.remainingJobs, 2)
    const firstGrantRow = nativeFacts(profile).resident.assistant_standing_grant.find((row) => row.id === granted.id)
    assert(firstGrantRow)
    assert.equal(firstGrantRow.enabled, 1)
    assert.equal(firstGrantRow.remaining_jobs, 2)
    proof.grant = granted
    proof.grantRow = firstGrantRow
    proof.sourceAAt = Date.now()
    writeFileSync(join(desktopDirectory, 'proactive-native-input.json'), json({ text: setup.sources[0].text }))
    const a = await waitFor(
      async () => {
        const found = action(await state(page!), 0)
        return found?.state === 'completed' && found.result ? found : null
      },
      'Fresh permitted A must produce a completed actual file without Send',
      60_000
    )
    writeFileSync(join(desktopDirectory, 'proactive-native-input.json'), json({ text: '' }))
    const rowA = exactRow(0),
      hostA = hostFacts(value.slots[0])
    assert(hostA.parsed)
    const result = JSON.parse(String(rowA.result_json)) as {
      content: string
      receipt: { contentHash: string; byteLength: number; resultId: string }
    }
    const file = join(value.slots[0].workspace, 'briefing.md'),
      bytes = readFileSync(file)
    assert.equal(hash(bytes), result.receipt.contentHash)
    assert.equal(bytes.byteLength, result.receipt.byteLength)
    assert.equal(bytes.toString('utf8'), result.content)
    assert.match(result.content, /Atlas/)
    assert.match(result.content, /volumeschatting/)
    assert.equal(a.result?.id, result.receipt.resultId)
    assert.equal(hostA.parsed.state.phase, 'completed')
    assert.equal(hostA.event.filter((event) => event.type === 'write-intent').length, 1)
    assert.equal(hostA.event.filter((event) => event.type === 'write-consumed').length, 1)
    assert.equal(hostA.event.filter((event) => event.type === 'completed').length, 1)
    assert.equal(hostA.write_intent.length, 1)
    assert.equal(hostA.parsed.state.execution.exit.code, 0)
    const sourceCard = page.locator(`[data-proactive-decision="${rowA.decision_id}"]`)
    await sourceCard.locator('summary').focus()
    await sourceCard.locator('summary').press('Enter')
    assert((await sourceCard.innerText()).includes(setup.sources[0].text))
    await page.screenshot({ path: join(directory, 'briefing-a-source-720.png') })
    const aCard = page.locator(`[data-briefing-action="${a.actionId}"]`)
    await clickKeyboard(aCard.getByRole('button', { name: 'Concept openen', exact: true }))
    await dialog.getByRole('heading', { name: title, exact: true }).waitFor({ state: 'visible' })
    assert((await dialog.innerText()).includes('volumeschatting'))
    await page.screenshot({ path: join(directory, 'briefing-a-result-720.png') })
    await clickKeyboard(dialog.getByRole('button', { name: 'Sluiten', exact: true }))
    const beforeRestart = invariant(baseline)
    assert.equal(beforeRestart.resident.assistant_message.filter((message) => message.role === 'user').length, 0)
    assert.equal(beforeRestart.resident.assistant_initiative_action.length, 1)
    proof.a = {
      action: a,
      row: rowA,
      host: hostA,
      file,
      sha256: hash(bytes),
      observedAt: Date.now(),
      native: beforeRestart,
    }
    checks.push(
      'A synthetic source reaches real native interpreter/standing-grant admission, one local SDK execution and one verified fixed file without Send'
    )

    await clickKeyboard(page.getByRole('button', { name: 'Voorwerk pauzeren', exact: true }))
    const paused = await waitFor(async () => {
      const current = await state(page!)
      return current.briefingGrant ? null : current
    }, 'Keyboard pause must remove the execution grant')
    const pausedA = action(paused, 0),
      pausedNative = invariant(baseline),
      pausedGrantRow = pausedNative.resident.assistant_standing_grant.find((row) => row.id === granted.id)
    assert.deepEqual(pausedA, a)
    assert(pausedGrantRow)
    assert.equal(pausedGrantRow.enabled, 0)
    assert.equal(pausedGrantRow.generation, Number(firstGrantRow.generation) + 1)
    assert.equal(pausedGrantRow.remaining_jobs, 1)
    assert.equal(exactRow(0).result_json, rowA.result_json)
    assert.equal(exactRow(0).terminal_received_at, rowA.terminal_received_at)
    assert.equal(hash(readFileSync(file)), hash(bytes))
    const pausedWireCount = lines(join(setup.root, 'native-wire.jsonl')).length
    await clickKeyboard(aCard.getByRole('button', { name: 'Concept openen', exact: true }))
    await dialog.getByRole('heading', { name: title, exact: true }).waitFor({ state: 'visible' })
    assert((await dialog.innerText()).includes('volumeschatting'))
    await page.screenshot({ path: join(directory, 'briefing-a-paused-result-720.png') })
    await clickKeyboard(dialog.getByRole('button', { name: 'Sluiten', exact: true }))
    assert.equal(lines(join(setup.root, 'native-wire.jsonl')).length, pausedWireCount)
    assert.equal(lines(join(setup.root, 'host-sdk.jsonl')).filter((entry) => entry.kind === 'exec-start').length, 1)
    proof.pauseA = {
      action: pausedA,
      at: Date.now(),
      grant: paused.briefingGrant ?? null,
      grantRow: pausedGrantRow,
      native: pausedNative,
      openHostRpcCount: 0,
      hostInvocationCount: 1,
    }
    save()
    await quit('briefing-quit-a')
    page = await start()
    const restartedA = await waitFor(async () => {
      const found = action(await state(page!), 0)
      return found?.state === 'completed' && found.result ? found : null
    }, 'A result must restore read-only')
    assert.deepEqual(restartedA, a)
    assert.equal(exactRow(0).result_json, rowA.result_json)
    assert.equal(exactRow(0).terminal_received_at, rowA.terminal_received_at)
    assert.equal(hash(readFileSync(file)), hash(bytes))
    assert.equal(lines(join(setup.root, 'host-sdk.jsonl')).filter((entry) => entry.kind === 'exec-start').length, 1)
    const pausedRestart = await state(page)
    assert.equal(pausedRestart.briefingGrant ?? null, null)
    const restartedDialog = page.getByRole('dialog'),
      restartedWireCount = lines(join(setup.root, 'native-wire.jsonl')).length
    await clickKeyboard(
      page
        .locator(`[data-briefing-action="${a.actionId}"]`)
        .getByRole('button', { name: 'Concept openen', exact: true })
    )
    await restartedDialog.getByRole('heading', { name: title, exact: true }).waitFor({ state: 'visible' })
    assert((await restartedDialog.innerText()).includes('volumeschatting'))
    await page.screenshot({ path: join(directory, 'briefing-a-paused-restarted-result-720.png') })
    await clickKeyboard(restartedDialog.getByRole('button', { name: 'Sluiten', exact: true }))
    assert.equal(lines(join(setup.root, 'native-wire.jsonl')).length, restartedWireCount)
    assert.equal(lines(join(setup.root, 'host-sdk.jsonl')).filter((entry) => entry.kind === 'exec-start').length, 1)
    assert.equal(exactRow(0).result_json, rowA.result_json)
    assert.equal(exactRow(0).terminal_received_at, rowA.terminal_received_at)
    assert.equal(hash(readFileSync(file)), hash(bytes))
    proof.restartA = {
      action: restartedA,
      at: Date.now(),
      grant: pausedRestart.briefingGrant ?? null,
      native: invariant(baseline),
      openedThroughUi: true,
      openHostRpcCount: 0,
      hostInvocationCount: 1,
    }
    checks.push(
      'Keyboard pause and full native restart preserve A result, time and file; the actual paused result opens without a host RPC or inference replay'
    )

    await clickKeyboard(page.getByRole('button', { name: 'Privévoorwerk toestaan', exact: true }))
    await restartedDialog
      .getByRole('heading', { name: 'Privévoorwerk toestaan', exact: true })
      .waitFor({ state: 'visible' })
    assert((await restartedDialog.innerText()).includes(slug))
    assert((await restartedDialog.innerText()).includes('Atlas en Cedar'))
    assert((await restartedDialog.innerText()).includes(value.targetLabel))
    await restartedDialog.getByRole('button', { name: 'Toestaan', exact: true }).focus()
    await page.screenshot({ path: join(directory, 'briefing-regrant-720.png') })
    await clickKeyboard(restartedDialog.getByRole('button', { name: 'Toestaan', exact: true }))
    const regranted = await waitFor(
      async () => (await state(page!)).briefingGrant ?? null,
      'Visible fresh grant confirmation must persist before B'
    )
    assert.equal(regranted.id, granted.id)
    assert.equal(regranted.remainingJobs, 2)
    const regrantedNative = invariant(baseline),
      regrantedRow = regrantedNative.resident.assistant_standing_grant.find((row) => row.id === regranted.id)
    assert(regrantedRow)
    assert.equal(regrantedRow.enabled, 1)
    assert.equal(regrantedRow.generation, Number(pausedGrantRow.generation) + 1)
    assert.equal(regrantedRow.remaining_jobs, 2)
    assert.deepEqual(action(await state(page), 0), a)
    assert.equal(exactRow(0).result_json, rowA.result_json)
    assert.equal(exactRow(0).terminal_received_at, rowA.terminal_received_at)
    assert.equal(hash(readFileSync(file)), hash(bytes))
    assert.equal(lines(join(setup.root, 'host-sdk.jsonl')).filter((entry) => entry.kind === 'exec-start').length, 1)
    assert.equal(regrantedNative.resident.assistant_initiative_action.length, 1)
    assert.equal(hostFacts(value.slots[1]).parsed, null)
    proof.regrantBeforeB = {
      visible: regranted,
      row: regrantedRow,
      at: Date.now(),
      native: regrantedNative,
      hostInvocationCount: 1,
    }
    save()
    const delivered = beforeRestart.resident.assistant_message.find((message) => message.id === a.messageId)
    assert(delivered)
    const earliestB = Number(delivered.created_at) + 61_000
    proof.attentionWait = { actualMessageCreatedAt: delivered.created_at, beganAt: Date.now(), earliestB }
    while (Date.now() < earliestB) await delay(Math.min(1000, earliestB - Date.now()))
    proof.sourceBAt = Date.now()
    assert(Number(proof.sourceBAt) >= earliestB)
    writeFileSync(join(desktopDirectory, 'proactive-native-input.json'), json({ text: setup.sources[1].text }))
    const b = await waitFor(
      async () => {
        const found = action(await state(page!), 1)
        return found && lines(join(setup.root, 'host-sdk.jsonl')).some((entry) => entry.kind === 'held') ? found : null
      },
      'Distinct Cedar source must start its own bounded invocation',
      60_000
    )
    writeFileSync(join(desktopDirectory, 'proactive-native-input.json'), json({ text: '' }))
    const rowB = exactRow(1),
      beforeB = hostFacts(value.slots[1])
    assert.equal(rowA.grant_generation, firstGrantRow.generation)
    assert.equal(rowB.grant_id, regranted.id)
    assert.equal(rowB.grant_generation, regrantedRow.generation)
    assert.notEqual(rowB.grant_generation, rowA.grant_generation)
    assert(beforeB.parsed)
    assert.equal(beforeB.parsed.state.phase, 'executing')
    assert.equal(beforeB.write_intent.length, 0)
    assert(!existsSync(join(value.slots[1].workspace, 'briefing.md')))
    await clickKeyboard(
      page
        .locator(`[data-briefing-action="${a.actionId}"]`)
        .getByRole('button', { name: 'Status controleren', exact: true })
    )
    assert.equal(hostFacts(value.slots[1]).parsed?.state.phase, 'executing')
    const historicalAlert = page.locator(`[data-briefing-action="${a.actionId}"]`).getByRole('alert')
    await historicalAlert.waitFor({ state: 'visible' })
    proof.historicalACheck = {
      rejectedWhileBBusy: true,
      alert: await historicalAlert.innerText(),
      bPhase: hostFacts(value.slots[1]).parsed?.state.phase,
    }
    const mismatch = await page.evaluate(
      async ({ actionId, messageId }) => {
        try {
          await window.remember.controlAssistantBriefing!({ actionId, messageId, command: 'stop' })
          return null
        } catch (error) {
          return String(error)
        }
      },
      { actionId: a.actionId, messageId: b.messageId }
    )
    assert(mismatch)
    assert.equal(hostFacts(value.slots[1]).parsed?.state.phase, 'executing')
    await page.locator('#assistant-message').fill(chatQuestion)
    await page.locator('#assistant-message').press('Enter')
    await waitFor(
      async () => (await state(page!)).messages.some((message) => message.text === chatAnswer) || null,
      'Ordinary tools-disabled chat must work while B executes'
    )
    assert.equal(hostFacts(value.slots[1]).parsed?.state.phase, 'executing')
    assert(!existsSync(join(value.slots[1].workspace, 'briefing.md')))
    await page.screenshot({ path: join(directory, 'briefing-b-chat-720.png') })
    const bCard = page.locator(`[data-briefing-action="${b.actionId}"]`),
      stop = bCard.getByRole('button', { name: 'Stoppen', exact: true })
    await stop.focus()
    await page.screenshot({ path: join(directory, 'briefing-b-stop-focus-720.png') })
    await clickKeyboard(stop)
    const stopped = await waitFor(
      async () => {
        const found = action(await state(page!), 1)
        return found?.state === 'stopped' ? found : null
      },
      'Exact B Stop must be confirmed',
      20_000
    )
    const afterB = hostFacts(value.slots[1])
    assert(afterB.parsed)
    assert.equal(afterB.parsed.state.phase, 'stopped')
    assert(afterB.parsed.state.execution.exit)
    assert(gone(afterB.parsed.state.execution.pid))
    assert.equal(afterB.write_intent.length, 0)
    assert(!existsSync(join(value.slots[1].workspace, 'briefing.md')))
    const d = afterB.parsed.descriptor
    await assert.rejects(
      rpc(join(value.slots[1].directory, 'briefing.sock'), 'authorize-write', {
        actionId: d.actionId,
        jobId: d.jobId,
        inputHash: d.inputHash,
        authorityHash: d.authorityHash,
        sessionId: afterB.parsed.state.sessionId ?? 'obsolete-session',
        requestId: 'late-request',
        nonce: 'late-nonce',
        contentHash: hash('forged'),
        decision: 'allow',
      }),
      /briefing-permission-mismatch/
    )
    proof.b = {
      action: b,
      row: rowB,
      before: beforeB,
      after: afterB,
      stopped,
      mismatchedControlError: mismatch,
      forgedLateIngress:
        'A made-up requestId/nonce after Stop is rejected; no permission was issued for B, so this is not replay of a genuine token.',
      native: invariant(baseline),
    }
    checks.push(
      'B uses distinct IDs; ordinary chat and historical A control refusal preserve B; exact B Stop observes CLI exit before any write intent or file'
    )
    const counts = {
      host: lines(join(setup.root, 'host-sdk.jsonl')).filter((entry) => entry.kind === 'exec-start').length,
      observer: lines(join(setup.root, 'observer-chat.jsonl')).filter((entry) => entry.kind === 'analysis').length,
    }
    assert.equal(counts.host, 2)
    assert.equal(counts.observer, 2)
    save()
    await quit('briefing-quit-b')
    page = await start()
    const restored = await waitFor(async () => {
      const current = await state(page!),
        first = action(current, 0),
        second = action(current, 1)
      return first?.state === 'completed' && first.result && second?.state === 'stopped'
        ? { first, second, current }
        : null
    }, 'Second restart restores A result and B stopped')
    assert.deepEqual(restored.first, a)
    assert.deepEqual(restored.second, stopped)
    assert.equal(exactRow(0).result_json, rowA.result_json)
    assert.equal(exactRow(0).terminal_received_at, rowA.terminal_received_at)
    assert.equal(hash(readFileSync(file)), hash(bytes))
    assert.equal(restored.current.briefingGrant?.id, regranted.id)
    assert.equal(restored.current.briefingGrant?.remainingJobs, 1)
    const finalGrantRow = nativeFacts(profile).resident.assistant_standing_grant.find((row) => row.id === regranted.id)
    assert(finalGrantRow)
    assert.equal(finalGrantRow.enabled, 1)
    assert.equal(finalGrantRow.generation, regrantedRow.generation)
    assert.equal(finalGrantRow.remaining_jobs, 1)
    assert.equal(
      lines(join(setup.root, 'host-sdk.jsonl')).filter((entry) => entry.kind === 'exec-start').length,
      counts.host
    )
    assert.equal(
      lines(join(setup.root, 'observer-chat.jsonl')).filter((entry) => entry.kind === 'analysis').length,
      counts.observer
    )
    const native = invariant(baseline)
    assert.equal(native.resident.assistant_initiative_action.length, 2)
    const mediaAfter = filesAt(profile).filter((name) => /\.(png|jpe?g|webp|wav|m4a|mp3|aiff)$/i.test(name))
    assert.deepEqual(mediaAfter, mediaBefore)
    const allExecutions = [
      ...lines(join(setup.root, 'host-sdk.jsonl')),
      ...lines(join(setup.root, 'observer-chat.jsonl')),
    ].filter((entry) => entry.kind === 'exec-start')
    assert.equal(allExecutions.length, 5)
    for (const entry of allExecutions) {
      const args = (entry.argv as string[]).join(' ')
      assert.match(args, /shell_tool=false/)
      assert.match(args, /network_access=false/)
      assert.match(args, /--sandbox read-only/)
    }
    await page.screenshot({ path: join(directory, 'briefing-restarted-720.png') })
    proof.final = {
      at: Date.now(),
      restored,
      native,
      hosts: value.slots.map(hostFacts),
      mediaAfter,
      counts,
      allExecutions,
    }
    const electron = getElectron()
    assert(electron)
    type RaceControl = {
      arm(id: string): void
      hide(): void
      release(): void
      clear(): void
      inspect(): {
        pending: boolean
        fetched: { title: string; content: string } | null
        hidden: boolean
        events: { event: string; at: number }[]
      }
    }
    const race = (command: 'arm' | 'hide' | 'release' | 'clear' | 'inspect') =>
      electron.evaluate(
        (_electron, input) => {
          const control = (globalThis as typeof globalThis & { qaBriefingOpenRace: RaceControl }).qaBriefingOpenRace
          if (input.command === 'arm') control.arm(input.actionId)
          else if (input.command !== 'inspect') control[input.command]()
          return control.inspect()
        },
        { command, actionId: a.actionId }
      )
    await race('arm')
    const finalACard = page.locator(`[data-briefing-action="${a.actionId}"]`)
    await clickKeyboard(finalACard.getByRole('button', { name: 'Concept openen', exact: true }))
    const heldOpen = await waitFor(async () => {
      const value = await race('inspect')
      return value.pending ? value : null
    }, 'Real opened result must be held before renderer delivery')
    assert.equal(heldOpen.fetched?.content, result.content)
    await race('hide')
    await finalACard.getByRole('button', { name: 'Concept openen', exact: true }).waitFor({ state: 'detached' })
    assert((await finalACard.getByRole('status').innerText()).includes('Resultaat nog niet beschikbaar'))
    await race('release')
    await waitFor(
      async () =>
        !(await finalACard.getByRole('button', { name: 'Status controleren', exact: true }).isDisabled()) || null,
      'Open finally must settle after stale response release'
    )
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    )
    assert.equal(await page.getByRole('dialog').count(), 0)
    assert(!(await page.locator('body').innerText()).includes('Welke acceptatiecriteria zijn beslissend?'))
    await page.screenshot({ path: join(directory, 'briefing-open-race-overlay-720.png') })
    proof.openResponseRace = {
      boundary:
        'Snapshot-only renderer lifetime contrast. Real IPC result was fetched and held; only displayed result identity was removed. No real revocation, source loss, host mutation or remote proof.',
      held: heldOpen,
      after: await race('inspect'),
      dialogs: 0,
      oldPrivateQuestionVisible: false,
    }
    assert.equal(exactRow(0).result_json, rowA.result_json)
    assert.equal(exactRow(0).terminal_received_at, rowA.terminal_received_at)
    assert.equal(
      lines(join(setup.root, 'host-sdk.jsonl')).filter((entry) => entry.kind === 'exec-start').length,
      counts.host
    )
    await race('clear')
    await finalACard.getByRole('button', { name: 'Concept openen', exact: true }).waitFor({ state: 'visible' })
    checks.push(
      'Separate snapshot-only held-open result race cannot reopen removed preview or display late private text'
    )
    await page.evaluate(() => window.remember.pauseCapture({ durationMs: null, sources: ['audio', 'capture'] }))
    const settings = await page.evaluate(() => window.remember.getSettings())
    assert.equal(settings.audioCaptureEnabled, false)
    assert.equal(settings.capturePaused, true)
    proof.finalSettings = { audioCaptureEnabled: settings.audioCaptureEnabled, capturePaused: settings.capturePaused }
    checks.push(
      'Two full native quits preserve exact A result/time and B Stop without inference replay; manual Task rows and audio remain unchanged'
    )
    await quit('briefing-final-close')
    proof.nativePids = pids.map((pid) => ({ pid, gone: gone(pid) }))
    assert((proof.nativePids as Row[]).every((entry) => entry.gone))
    proof.completedAt = Date.now()
    proof.status = 'passed'
    save()
  } catch (error) {
    proof.status = 'failed'
    proof.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
    try {
      proof.failureFacts = nativeFacts(profile)
      proof.failureHosts = value.slots.map(hostFacts)
    } catch (readError) {
      proof.readError = String(readError)
    }
    save()
    throw error
  } finally {
    if (page) {
      await close()
      page = null
    }
    for (const filename of ['observer-chat.jsonl', 'host-sdk.jsonl', 'native-wire.jsonl'])
      if (existsSync(join(setup.root, filename)))
        copyFileSync(join(setup.root, filename), join(directory, `briefing-${filename}`))
    for (const filename of ['proactive-context.jsonl', 'proactive-inference.jsonl'])
      if (existsSync(join(desktopDirectory, filename)))
        copyFileSync(join(desktopDirectory, filename), join(directory, `briefing-${filename}`))
  }
}
