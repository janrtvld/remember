import assert from 'node:assert/strict'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import {
  applyDayChanges,
  type DayChanges,
  type EdgeWidgetBridge,
  type RecordingAudioLevel,
  type RememberBridge,
} from '@remember/shared'
import { _electron, type Browser, chromium, type ElectronApplication, type Page } from 'playwright-core'
import { readConversationAudioManifestAt } from '../../src/main/dailyReview/conversationAudio'
import { EvidenceStore } from '../../src/main/dailyReview/evidenceStore'
import {
  manualMeetingEpisode,
  memoryWithFinishedManualMeetingConversation,
  memoryWithManualMeetingConversation,
} from '../../src/main/dailyReview/manualMeetingLifecycle'
import { readPcmWavInfo } from '../../src/main/dailyReview/pcmWav'
import { createQaAudioFixture } from '../../src/main/dailyReview/qaAudioFixture'
import { createPackagedWebServer } from '../../src/main/packagedWebServer'
import { agentDocumentsAfterRestartQa, agentDocumentsQa, installAgentDocumentsFixture } from './agentDocuments'
import { ambientLiveQa, useExistingQaCodexHome } from './ambientLive'
import { ambientTasksAfterRestartQa, ambientTasksQa, installAmbientTasksFixture } from './ambientTasks'
import { seedAudioProcessingRecovery, verifyAudioProcessingRecovery } from './audioProcessingRecovery'
import { codexWorkerQa, installCodexWorkerFixture } from './codexWorker'
import { continuityQa } from './continuity'
import { installDayPreparationQa, verifyDayPreparationQa } from './dayPreparation'
import { dictationQa, installDictationFixture } from './dictation'
import { edgeWidgetQa } from './edgeWidget'
import { edgeWidgetDockingQa } from './edgeWidgetDocking'
import { edgeWidgetMenuQa } from './edgeWidgetMenu'
import { inspectEvidence } from './evidence'
import { seedProfile, writeSystemAudioStimulus } from './fixture'
import {
  discardSpaceRecordingQa,
  livingSpacesQa,
  reopenSpaceRecordingQa,
  startSpaceRecordingQa,
  stopSpaceRecordingQa,
} from './livingSpaces'
import { installProactiveAgentFixture, proactiveAgentQa } from './proactive-agent'
import {
  installProactiveBriefingFixture,
  proactiveBriefingQa,
  seedProactiveBriefingProfile,
  setupProactiveBriefingQa,
} from './proactive-briefing'
import { installProactiveBriefingFollowupFixture, proactiveBriefingFollowupQa } from './proactive-briefing-followup'
import {
  installProactiveBriefingMiniFixture,
  proactiveBriefingMiniQa,
  seedProactiveBriefingMiniProfile,
  setupProactiveBriefingMiniQa,
} from './proactive-briefing-mini'
import { installProactiveNotesFixture, proactiveNotesQa, seedProactiveNotesProfile } from './proactive-notes'
import { residentAgentAfterRestartQa, residentAgentQa } from './residentAgent'
import { residentHostQa } from './residentHost'
import { installHostContextStopUiFixture, residentHostContextStopUiQa } from './residentHostContextStopUi'
import { installHostExpiryUiFixture, residentHostExpiryUiQa } from './residentHostExpiryUi'
import { residentHostFaultsQa } from './residentHostFaults'
import { readHostTaskQaManifest, residentHostTaskQa, seedHostTaskProfile } from './residentHostTask'
import { residentRecoveryQa } from './residentRecovery'
import { residentRemoteQa } from './residentRemote'
import { revinoteProcessingRecoveryQa } from './revinoteProcessing'
import { installSharedAgentChatFixture, setupSharedAgentQa, sharedAgentQa } from './shared-agent'
import {
  installSharedMicrophoneQa,
  ownedMicrophoneRenderers,
  sharedMicrophoneColdQa,
  sharedMicrophoneFixtureQa,
  sharedMicrophoneQa,
  sharedMicrophoneRecoveryQa,
  verifySharedMicrophoneIdle,
} from './sharedMicrophone'
import { seedStartupTravel, verifyStartupTravel } from './startupTravel'

declare global {
  interface Window {
    remember: RememberBridge
    rememberWidget?: EdgeWidgetBridge
  }
}

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const root = resolve(desktop, '../..')
const checkoutRuntime = join(root, '.qa')
const runtimeOverride = process.env.REMEMBER_QA_RUNTIME_DIR?.trim()
const runtime = runtimeOverride ? resolve(runtimeOverride) : checkoutRuntime
const mode = process.argv[2] ?? 'smoke'
const sharedAgent = process.argv.includes('--shared-agent')
const proactiveBriefing = process.argv.includes('--proactive-briefing')
const proactiveBriefingFollowup = process.argv.includes('--proactive-briefing-followup')
const proactiveNotes = process.argv.includes('--proactive-notes')
const proactiveBriefingMini = process.argv.includes('--proactive-briefing-mini')
const anyProactiveBriefing = proactiveBriefing || proactiveBriefingMini || proactiveBriefingFollowup
let proactiveBriefingSetup: Awaited<ReturnType<typeof setupProactiveBriefingQa>> | null = null
let sharedAgentSetup: Awaited<ReturnType<typeof setupSharedAgentQa>> | null = null
const timestamp = new Date().toISOString().replaceAll(':', '-')
const shortSocketProfile = process.argv.includes('--continuity') || process.argv.includes('--living-spaces')
const runId = shortSocketProfile ? timestamp.replaceAll('-', '') : timestamp
const runDirectory = join(runtime, 'runs', runId)
// macOS Unix sockets must fit in 104 bytes, including their terminating NUL.
const profile = join(runDirectory, shortSocketProfile ? 'p' : 'profile')
const learningSources = join(runDirectory, 'learning-sources')
const rendererDirectory = join(runDirectory, 'renderer')
const desktopDirectory = join(runDirectory, 'desktop')
const sharedDirectory = join(runDirectory, 'shared')
const locks = [...new Set([join(checkoutRuntime, 'run.lock'), join(runtime, 'run.lock')])]
const report: Record<string, unknown> = {
  runId,
  mode,
  status: 'running',
  checks: [],
  profile,
  runtimeDirectory: runtime,
  rendererBundler: runtimeOverride ? 'webpack' : 'turbopack',
}
const checks = report.checks as string[]
let electron: ElectronApplication | undefined
let recoveredBrowser: Browser | undefined
let web: ChildProcess | undefined
let exportedWeb: ReturnType<typeof createPackagedWebServer> | undefined
let stimulus: ChildProcess | undefined
let page: Page | undefined
let launchNumber = 0
let webUrl = ''
const rendererErrors: string[] = []
const abort = new AbortController()

function writeJson(name: string, value: unknown) {
  writeFileSync(join(runDirectory, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function command(command: string, args: string[], cwd = desktopDirectory) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 240_000 })
  appendFileSync(join(runDirectory, 'build.log'), `${result.stdout ?? ''}${result.stderr ?? ''}`)
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed. See build.log. ${result.error ?? ''}`)
  return result.stdout.trim()
}

function linkQaDependencies(source: string, destination: string) {
  mkdirSync(destination)
  for (const entry of readdirSync(source)) {
    if (entry !== '@remember') {
      symlinkSync(join(source, entry), join(destination, entry))
      continue
    }
    mkdirSync(join(destination, entry))
    for (const name of readdirSync(join(source, entry))) {
      symlinkSync(name === 'shared' ? sharedDirectory : join(source, entry, name), join(destination, entry, name))
    }
  }
}

function snapshotDesktop() {
  mkdirSync(desktopDirectory)
  command('/bin/cp', ['-cR', join(root, 'packages/shared'), sharedDirectory])
  const sharedConfig = JSON.parse(readFileSync(join(sharedDirectory, 'tsconfig.json'), 'utf8'))
  sharedConfig.extends = join(root, 'tsconfig.json')
  writeFileSync(join(sharedDirectory, 'tsconfig.json'), JSON.stringify(sharedConfig))
  for (const entry of ['src', 'scripts', 'resources', 'package.json', 'electron.vite.config.ts', 'tsconfig.json']) {
    command('/bin/cp', ['-cR', join(desktop, entry), join(desktopDirectory, entry)])
  }
  // These modules are copied with the owned runtime; relative imports must resolve within this run.
  const briefingResources = join(desktopDirectory, 'resources/experiments')
  for (const file of [
    'always-on-agent/briefing-protocol.mjs',
    'proactive-agent/briefing-models/validateOutput.mjs',
    'proactive-agent/briefing-models/schema.v1.json',
  ]) {
    const destination = join(briefingResources, file)
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
    copyFileSync(join(root, 'experiments', file), destination)
  }
  for (const name of [
    'briefingNative.ts',
    'briefingNativeCore.ts',
    'briefingActionService.ts',
    'briefingExecutor.ts',
    'hostInitiativeProtocol.ts',
    'hostInitiativeStore.ts',
  ]) {
    const file = join(desktopDirectory, 'src/main', name)
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replaceAll('../../../../experiments/', '../../resources/experiments/')
    )
  }
  if (mode === 'smoke') installDayPreparationQa(desktopDirectory)
  if (proactiveNotes) installProactiveNotesFixture(desktopDirectory)
  if (anyProactiveBriefing) {
    const destination = join(desktopDirectory, 'resources/briefing')
    mkdirSync(destination, { recursive: true, mode: 0o700 })
    copyFileSync(
      join(root, 'experiments/proactive-agent/briefing-models/prompt.v1.txt'),
      join(destination, 'prompt.v1.txt')
    )
    if (proactiveBriefingMini) installProactiveBriefingMiniFixture(desktopDirectory)
    else if (proactiveBriefingFollowup) installProactiveBriefingFollowupFixture(desktopDirectory)
    else installProactiveBriefingFixture(desktopDirectory)
  }
  if (process.argv.includes('--host-task') || sharedAgent) {
    readHostTaskQaManifest()
    const hostResources = join(desktopDirectory, 'resources/host-task')
    mkdirSync(hostResources, { recursive: true, mode: 0o700 })
    for (const file of ['task-service-transport.mjs', 'job-router-v2.mjs'])
      copyFileSync(join(root, 'experiments/always-on-agent', file), join(hostResources, file))
  }
  if (sharedAgent) installSharedAgentChatFixture(desktopDirectory)
  if (process.argv.includes('--codex-worker') || process.argv.includes('--agent-review-ui'))
    installCodexWorkerFixture(desktopDirectory)
  if (process.argv.includes('--agent-documents-ui')) installAgentDocumentsFixture(desktopDirectory)
  if (process.argv.includes('--host-expiry-ui')) installHostExpiryUiFixture(desktopDirectory)
  if (process.argv.includes('--host-context-ui')) installHostContextStopUiFixture(desktopDirectory)
  if (process.argv.includes('--ambient-tasks')) installAmbientTasksFixture(desktopDirectory)
  if (process.argv.includes('--proactive-agent')) {
    const live = process.argv.includes('--live')
    installProactiveAgentFixture(desktopDirectory, {
      skipCodexFixture: live,
      daySync: process.argv.includes('--day-sync') || process.argv.includes('--day-review'),
      dayReview: process.argv.includes('--day-review'),
    })
    if (live) {
      const providerHome = process.env.REMEMBER_QA_CODEX_HOME
      assert(providerHome, 'Live proactive QA requires REMEMBER_QA_CODEX_HOME')
      assert(
        providerHome?.startsWith('/') && existsSync(providerHome),
        'Live proactive QA needs an existing absolute REMEMBER_QA_CODEX_HOME; credentials are used in place'
      )
      useExistingQaCodexHome(desktopDirectory, providerHome)
    }
  }
  if (process.argv.includes('--ambient-live')) {
    const providerHome = process.env.REMEMBER_QA_CODEX_HOME
    assert(providerHome, '--ambient-live requires REMEMBER_QA_CODEX_HOME')
    assert(
      process.argv.includes('--live') && providerHome?.startsWith('/') && existsSync(providerHome),
      '--ambient-live requires --live and an existing absolute REMEMBER_QA_CODEX_HOME; credentials are used in place'
    )
    useExistingQaCodexHome(desktopDirectory, providerHome)
  }
  if (mode === 'dictation') {
    const sharedCapture = process.argv.includes('--shared-capture')
    installDictationFixture(desktopDirectory, sharedCapture)
    if (sharedCapture) installSharedMicrophoneQa(desktopDirectory, false)
  }
  if (mode === 'audio') installSharedMicrophoneQa(desktopDirectory)
  if (mode === 'audio' && process.argv.includes('--stop-boundary')) {
    const file = join(desktopDirectory, 'src/main/dailyReview/index.ts')
    const source = readFileSync(file, 'utf8')
    const point = '      return consumeTemporaryCaptureFile(audioPath, removeTemporaryCaptureFile, async () => {'
    assert.equal(source.split(point).length, 2)
    writeFileSync(
      file,
      source
        .replace(
          point,
          `      if (globalThis.qaStopBoundary.hold) {
        globalThis.qaStopBoundary.entered++
        await globalThis.qaStopBoundary.ready
      }
${point}`
        )
        .replace(
          '    .then(() => {\n      if (isDisposed) return\n      if (globalThis.qaStopBoundary',
          '    .then(async () => {\n      if (isDisposed) return\n      if (globalThis.qaStopBoundary'
        )
        .replace(
          'async function performAutomaticCapture(): Promise<void> {',
          'async function performAutomaticCaptureInner(): Promise<void> {'
        ) +
        `
const qaStopBoundary = { hold: true, entered: 0, ready: Promise.resolve(), release: () => {}, bootstrapEntered: false, bootstrapDone: false, bootstrapReady: Promise.resolve(), releaseBootstrap: () => {} }
qaStopBoundary.ready = new Promise<void>(resolve => { qaStopBoundary.release = () => { qaStopBoundary.hold = false; resolve() } })
qaStopBoundary.bootstrapReady = new Promise<void>(resolve => { qaStopBoundary.releaseBootstrap = resolve })
Object.assign(globalThis, { qaStopBoundary, qaPersistTranscriptionResult: persistTranscriptionResult })
async function performAutomaticCapture(): Promise<void> {
  qaStopBoundary.bootstrapEntered = true
  await qaStopBoundary.bootstrapReady
  try { await performAutomaticCaptureInner() }
  finally { qaStopBoundary.bootstrapDone = true }
}
`
    )
  }
  if (process.argv.includes('--update-quit')) {
    const updater = join(desktopDirectory, 'src/main/updater.ts')
    const source = readFileSync(updater, 'utf8')
    const handoff = 'autoUpdater.quitAndInstall(false, true)'
    assert.equal(source.split(handoff).length, 2)
    writeFileSync(
      updater,
      source.replace(
        handoff,
        `(() => {
      if (BrowserWindow.getAllWindows().some(window => window.getTitle() === 'Remember microphone capture')) {
        throw new Error('Microphone window survived updater handoff')
      }
      console.log('[qa] capture disposed before updater handoff')
      app.quit()
    })()`
      ) +
        `
Object.assign(globalThis, { qaQuitForUpdate: () => {
  state = { ...state, status: 'downloaded' }
  restartToUpdate()
} })
`
    )
  }
  if (mode === 'widget' && process.argv.includes('--menu')) {
    // Menu navigation and pause persistence do not need physical audio access.
    const setup = join(desktopDirectory, 'src/main/edgeWidgetSetup.ts')
    const source = readFileSync(setup, 'utf8')
    const permissionGate = "(state.microphonePermission === 'granted' && state.systemAudioCheckStatus === 'ready')"
    assert.equal(source.split(permissionGate).length, 2)
    writeFileSync(setup, source.replace(permissionGate, 'true'))
  }

  const cliSetup = join(desktopDirectory, 'src/main/cliSetup.ts')
  const cliSource = readFileSync(cliSetup, 'utf8')
  const productionPaths = 'resolveCliSetupPaths(homedir(), resourceRoot)'
  assert.equal(cliSource.split(productionPaths).length, 2, 'QA must isolate exactly the CLI setup home resolver')
  writeFileSync(
    cliSetup,
    cliSource.replace(productionPaths, "resolveCliSetupPaths(app.getPath('userData'), resourceRoot)")
  )
  // The source tsconfig extends the workspace root; the snapshot lives at a different depth.
  const config = JSON.parse(readFileSync(join(desktopDirectory, 'tsconfig.json'), 'utf8'))
  config.extends = join(root, 'tsconfig.json')
  writeFileSync(join(desktopDirectory, 'tsconfig.json'), JSON.stringify(config))
  mkdirSync(join(desktopDirectory, 'native'))
  for (const entry of readdirSync(join(desktop, 'native'))) {
    if (!/\.(swift|m|plist|sh)$/.test(entry)) continue
    command('/bin/cp', ['-c', join(desktop, 'native', entry), join(desktopDirectory, 'native', entry)])
  }
  linkQaDependencies(join(desktop, 'node_modules'), join(desktopDirectory, 'node_modules'))
  if (mode === 'learning') {
    const entry = join(desktopDirectory, 'src/main/agentLearning.ts')
    const source = readFileSync(entry, 'utf8')
    const productionImport =
      "import { generateAgentKnowledgeUpdates, generateKnowledgeOrganizationUpdates } from './dailyReview/analyzer'"
    assert.equal(
      source.split(productionImport).length,
      2,
      'QA must replace exactly the inference import in its owned snapshot'
    )
    writeFileSync(
      entry,
      source.replace(
        productionImport,
        "import { generateAgentKnowledgeUpdates, generateKnowledgeOrganizationUpdates } from '../../scripts/qa/agentLearningFixture'"
      )
    )
    report.inference =
      'Agent learning uses deterministic inference in the owned source snapshot; no model credentials for that stage'
  }
}

async function availablePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}

async function startRenderer() {
  mkdirSync(rendererDirectory)
  for (const entry of readdirSync(join(root, 'apps/web'))) {
    if (['node_modules', '.next', '.next-qa', 'out', '.turbo', '.DS_Store'].includes(entry) || entry.startsWith('.env'))
      continue
    command('/bin/cp', ['-cR', join(root, 'apps/web', entry), join(rendererDirectory, entry)])
  }
  const rendererConfig = join(rendererDirectory, 'next.config.ts')
  // The development badge otherwise covers Remember's native account control.
  appendFileSync(rendererConfig, '\nconfig.devIndicators = false\n')
  linkQaDependencies(join(root, 'apps/web/node_modules'), join(rendererDirectory, 'node_modules'))
  const port = await availablePort()
  webUrl = `http://127.0.0.1:${port}`
  const webLog = openSync(join(runDirectory, 'renderer.log'), 'a', 0o600)
  const webRequire = createRequire(join(root, 'apps/web/package.json'))
  if (process.argv.includes('--packaged-renderer')) {
    command(process.execPath, [webRequire.resolve('next/dist/bin/next'), 'build', '--webpack'], rendererDirectory)
    exportedWeb = createPackagedWebServer(join(rendererDirectory, 'out'))
    exportedWeb.listen(port, '127.0.0.1')
    await once(exportedWeb, 'listening')
    closeSync(webLog)
    report.rendererBundler = 'production static export'
    return
  }
  web = spawn(
    process.execPath,
    [
      webRequire.resolve('next/dist/bin/next'),
      'dev',
      ...(runtimeOverride ? ['--webpack'] : []),
      '--hostname',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    {
      cwd: rendererDirectory,
      detached: true,
      env: { ...process.env },
      stdio: ['ignore', webLog, webLog],
    }
  )
  closeSync(webLog)
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    abort.signal.throwIfAborted()
    if (web.exitCode !== null) throw new Error('QA renderer exited. See renderer.log.')
    try {
      const response = await fetch(webUrl, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return
    } catch {}
    await delay(250)
  }
  throw new Error('QA renderer did not become ready within 90 seconds. See renderer.log.')
}

function developmentExecutable() {
  const require = createRequire(join(desktop, 'package.json'))
  const electronPackage = require.resolve('electron/package.json')
  const version = JSON.parse(readFileSync(electronPackage, 'utf8')).version
  const app = join(runtime, `electron-${version}`, 'Remember QA.app')
  if (!existsSync(app)) {
    mkdirSync(dirname(app), { recursive: true })
    command('/bin/cp', ['-cR', join(dirname(electronPackage), 'dist/Electron.app'), app])
    for (const [key, value] of Object.entries({
      CFBundleIdentifier: 'computer.remember.qa',
      CFBundleName: 'Remember QA',
      CFBundleDisplayName: 'Remember QA',
    }))
      command('/usr/bin/plutil', ['-replace', key, '-string', value, join(app, 'Contents/Info.plist')])
  }
  return join(app, 'Contents/MacOS/Electron')
}

async function launch(launchProfile = profile) {
  abort.signal.throwIfAborted()
  launchNumber += 1
  const agentSources = mode === 'learning' ? learningSources : launchProfile
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
  delete env.ELECTRON_RUN_AS_NODE
  delete env.REMOTE_DEBUGGING_PORT
  electron = await _electron.launch({
    executablePath: developmentExecutable(),
    args: [
      desktopDirectory,
      ...(mode === 'dictation'
        ? [
            '--disable-features=AudioServiceSandbox',
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            `--use-file-for-fake-audio-capture=${process.argv[process.argv.indexOf('--dictation-wav') + 1]}%noloop`,
          ]
        : []),
    ],
    cwd: desktopDirectory,
    timeout: 45_000,
    env: {
      ...env,
      ...(process.argv.includes('--error-reporting')
        ? { REMEMBER_SENTRY_ENABLE_DEV: '0', REMEMBER_SENTRY_DSN: 'http://qa@127.0.0.1:9/1' }
        : {}),
      ...(process.argv.includes('--startup-travel') ? { TZ: 'America/Los_Angeles' } : {}),
      CODEX_HOME: join(agentSources, 'codex'),
      ...(mode === 'learning' ? { CLAUDE_CONFIG_DIR: join(agentSources, 'claude') } : {}),
      REMEMBER_USER_DATA_DIR: launchProfile,
      REMEMBER_WEB_URL: [
        '--host-job',
        '--host-faults',
        '--host-review',
        '--agent-review-ui',
        '--agent-documents-ui',
        '--host-expiry-ui',
        '--host-context-ui',
        '--host-task',
        '--proactive-agent',
        '--shared-agent',
        '--proactive-briefing',
        '--proactive-briefing-mini',
        '--proactive-briefing-followup',
        '--proactive-notes',
      ].some((flag) => process.argv.includes(flag))
        ? `${webUrl}/assistant/`
        : webUrl,
      REMEMBER_QA_SYNTHETIC_AUDIO: '0',
      REMEMBER_QA_PROACTIVE_AGENT:
        process.argv.includes('--proactive-agent') || anyProactiveBriefing || proactiveNotes ? '1' : '0',
      REMEMBER_QA_PROACTIVE_DAY_SYNC:
        process.argv.includes('--day-sync') || process.argv.includes('--day-review') ? '1' : '0',
      REMEMBER_QA_BRIEFING_ENABLED: anyProactiveBriefing ? '1' : '0',
      REMEMBER_QA_BRIEFING_MANIFEST: anyProactiveBriefing ? (process.env.REMEMBER_QA_BRIEFING_MANIFEST ?? '') : '',
      REMEMBER_QA_HOST_TASK_ENABLED: process.argv.includes('--host-task') || sharedAgent ? '1' : '0',
      REMEMBER_QA_HOST_TASK_MANIFEST:
        process.argv.includes('--host-task') || sharedAgent ? (process.env.REMEMBER_QA_HOST_TASK_MANIFEST ?? '') : '',
      REMEMBER_QA_HOST_JOB_ENABLED: [
        '--host-job',
        '--host-faults',
        '--host-review',
        '--host-expiry-ui',
        '--host-context-ui',
      ].some((flag) => process.argv.includes(flag))
        ? '1'
        : '0',
    },
  })
  const current = electron
  current.process().stdout?.on('data', (data) => appendFileSync(join(runDirectory, 'main.log'), data))
  current.process().stderr?.on('data', (data) => appendFileSync(join(runDirectory, 'main.log'), data))
  await current.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
  await current.firstWindow()
  const identity = await current.evaluate(({ app }) => ({
    pid: process.pid,
    userData: app.getPath('userData'),
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    electron: process.versions.electron,
  }))
  assert.equal(identity.userData, launchProfile, "Electron must use this run's profile")
  assert.equal(identity.appPath, desktopDirectory, "Electron must run this run's source snapshot")
  assert.equal(identity.isPackaged, false)
  writeJson(`identity-${launchNumber}.json`, identity)
  page = undefined
  for (let attempt = 0; !page && attempt < 100; attempt++) {
    for (const candidate of current.windows()) {
      const window = await current.browserWindow(candidate)
      if (await window.evaluate((window) => window.getTitle() === 'Remember')) {
        page = candidate
        break
      }
    }
    if (!page) await delay(50)
  }
  assert(page, 'QA must select the main Remember window, not an overlay')
  page.on('pageerror', (error) => rendererErrors.push(error.message))
  page.on('console', (message) =>
    appendFileSync(join(runDirectory, 'console.log'), `[${message.type()}] ${message.text()}\n`)
  )
  await page.waitForURL(`${webUrl}/**`, {
    timeout: process.argv.includes('--agent-documents-ui') ? 120_000 : 45_000,
  })
  await page.waitForFunction(() => typeof window.remember?.listDays === 'function')
  await page.evaluate(() => window.remember.getState())
  if (process.argv.includes('--agent-review-ui') || process.argv.includes('--agent-documents-ui')) {
    const window = await current.browserWindow(page)
    await window.evaluate((window) => {
      window.show()
      window.focus()
    })
  }
  return page
}

async function checkpoint(name: string) {
  if (electron) writeJson(`${name}-processes.json`, await electron.evaluate(({ app }) => app.getAppMetrics()))
  if (page && !page.isClosed()) {
    writeJson(`${name}-capture.json`, await page.evaluate(() => window.remember.getState()))
    writeJson(`${name}-days.json`, await page.evaluate(() => window.remember.listDays()))
    await page.screenshot({ path: join(runDirectory, `${name}.png`) })
  }
  const evidence = inspectEvidence(profile)
  writeJson(`${name}-evidence.json`, evidence)
  assert.deepEqual(
    evidence.integrity.map((row) => row.quick_check),
    ['ok']
  )
  assert.deepEqual(evidence.foreignKeyViolations, [])
  return evidence
}

async function closeElectron() {
  const current = electron
  electron = undefined
  page = undefined
  if (!current) return
  try {
    await recoveredBrowser?.close()
    recoveredBrowser = undefined
    await current.context().tracing.stop({ path: join(runDirectory, `trace-${launchNumber}.zip`) })
  } finally {
    if (process.argv.includes('--update-quit')) {
      const exited = once(current.process(), 'exit')
      await current.evaluate(() => {
        setTimeout(() => (globalThis as unknown as { qaQuitForUpdate: () => void }).qaQuitForUpdate(), 0)
      })
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error('Update shutdown did not exit within 20 seconds')), 20_000)
          }),
        ])
        checks.push('Update shutdown disposes microphone before installer handoff and exits within 20 seconds')
      } finally {
        if (timeout) clearTimeout(timeout)
        await current.close()
      }
    } else await current.close()
  }
}

async function playback(target: Page, dayId: string, episodeId: string) {
  const result = await target.evaluate(
    async ({ dayId, episodeId }) => {
      const url = await window.remember.getConversationAudioUrl(dayId, episodeId)
      if (!url) throw new Error('No persisted conversation audio URL')
      const audio = new Audio(url)
      audio.muted = true
      const timeout = setTimeout(() => audio.dispatchEvent(new Event('error')), 10_000)
      try {
        await new Promise<void>((resolve, reject) => {
          audio.onerror = () =>
            reject(new Error(`Conversation audio could not play: ${audio.error?.message ?? 'timeout'}`))
          audio.ontimeupdate = () => {
            if (audio.currentTime > 0.1) resolve()
          }
          audio.play().catch(reject)
        })
        return { duration: audio.duration }
      } finally {
        clearTimeout(timeout)
        audio.pause()
        audio.removeAttribute('src')
        audio.load()
      }
    },
    { dayId, episodeId }
  )
  assert(Number.isFinite(result.duration) && result.duration > 0, 'Audio must have a finite positive duration')
  return result
}

async function saveConversationAudio(target: Page, dayId: string, reference: string, destination: string | null) {
  assert(electron)
  const originalDialog = await electron.evaluateHandle(({ dialog }) => dialog.showSaveDialog)
  try {
    await electron.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: filePath === null, filePath: filePath ?? '' })
    }, destination)
    return await target.evaluate(({ dayId, reference }) => window.remember.saveConversationAudio(dayId, reference), {
      dayId,
      reference,
    })
  } finally {
    await electron.evaluate(({ dialog }, original) => {
      dialog.showSaveDialog = original
    }, originalDialog)
    await originalDialog.dispose()
  }
}

async function verifyMainControlHitAreas(target: Page) {
  await target.goto(`${webUrl}/conversations/`)
  const tab = target.getByRole('tab', { name: 'All', exact: true })
  await tab.waitFor()
  const search = target.getByRole('button', { name: 'Search', exact: true })
  const controls = []
  for (const control of [search, tab]) {
    const proof = await control.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return {
        before: getComputedStyle(element, '::before').getPropertyValue('-webkit-app-region'),
        after: getComputedStyle(element, '::after').getPropertyValue('-webkit-app-region'),
        samples: [
          [2, 2],
          [rect.width / 2, rect.height / 2],
          [rect.width - 2, rect.height - 2],
        ].map(([x, y]) => {
          const node = document.elementFromPoint(rect.left + x, rect.top + y)
          return {
            inside: !!node && element.contains(node),
            cursor: node ? getComputedStyle(node).cursor : null,
            region: node ? getComputedStyle(node).getPropertyValue('-webkit-app-region') : null,
          }
        }),
      }
    })
    assert(proof.samples.every((sample) => sample.inside && sample.cursor === 'pointer' && sample.region === 'no-drag'))
    assert.equal(proof.before, 'no-drag')
    assert.equal(proof.after, 'no-drag')
    controls.push(proof)
  }
  await search.click({ position: { x: 2, y: 2 } })
  const searchInput = target.getByRole('dialog', { name: 'Search Remember', exact: true }).getByRole('textbox', {
    name: 'Search',
    exact: true,
  })
  await searchInput.waitFor()
  await searchInput.press('Escape')
  await tab.click({ position: { x: 2, y: 2 } })
  assert.equal(await tab.getAttribute('aria-selected'), 'true')
  writeJson('interactive-hit-areas.json', controls)
  checks.push(
    'Native icon and tab padding, text, icons and enlarged hit areas remain clickable with one pointer cursor outside window drag regions'
  )
}

async function smoke(fixture: ReturnType<typeof seedProfile>) {
  if (process.argv.includes('--inbox-list')) {
    report.scope =
      'Large synthetic completed Inbox, native renderer/IPC, selection and Agent draft handoff; no model execution or capture'
    const store = new EvidenceStore(join(profile, 'daily-review/evidence.sqlite'))
    const closedIds: string[] = []
    for (let index = 0; index < 2_000; index++) {
      const item = store.createWorkItem(`QA completed ${index}`, 'Disposable completed-task archive fixture')
      store.setWorkItemLifecycle(item.id, 'completed')
      closedIds.push(item.id)
    }
    const open = store.createWorkItem('QA Agent handoff', 'Keep this exact task context when opening Agent.')
    store.close()
    const target = await launch()
    await target.goto(`${webUrl}/inbox/?item=${open.id}`)
    await target.getByRole('textbox', { name: 'Action point title', exact: true }).waitFor()
    const startedAt = performance.now()
    await target.getByRole('button', { name: 'Show all tasks', exact: true }).click()
    const rows = target.locator('section[aria-label="Inbox"] ol > li')
    await rows.first().waitFor()
    const toggleMs = performance.now() - startedAt
    const total = Number(await rows.first().getAttribute('aria-setsize'))
    const mounted = await rows.count()
    assert(
      total >= 2_000 && mounted < 50,
      `Completed archive must stay available without mounting ${total} rows: ${mounted}`
    )
    assert(toggleMs < 4_000, `Completed toggle must remain responsive: ${toggleMs}ms`)
    await target.locator('section[aria-label="Inbox"] a').first().press('End')
    await target.waitForFunction(
      (total) =>
        Number(
          document.querySelector('section[aria-label="Inbox"] ol > li:last-child')?.getAttribute('aria-posinset')
        ) === total,
      total
    )
    await target.locator('section[aria-label="Inbox"] a').last().press('ControlOrMeta+a')
    await target.locator('section[aria-label="Inbox"] a').last().press('Home')
    await target.waitForFunction(
      () => document.querySelector('section[aria-label="Inbox"] ol > li')?.getAttribute('aria-posinset') === '1'
    )
    assert.equal(await target.locator('section[aria-label="Inbox"] a[aria-description]').count(), await rows.count())
    await target.locator('section[aria-label="Inbox"] a').first().press('Escape')
    await target.goto(`${webUrl}/inbox/?item=${closedIds[0]}`)
    await target.getByRole('textbox', { name: 'Action point title', exact: true }).waitFor()
    assert.equal(
      await target.getByRole('textbox', { name: 'Action point title', exact: true }).inputValue(),
      'QA completed 0'
    )
    await target.locator('section[aria-label="Inbox"] a[aria-current="true"]').waitFor({ state: 'visible' })
    await target.goto(`${webUrl}/inbox/?item=${open.id}`)
    await target.getByRole('textbox', { name: 'Action point title', exact: true }).fill('QA edited handoff title')
    await target.getByRole('button', { name: 'Delegate to Agent', exact: true }).click()
    await target.waitForURL((url) => url.pathname === '/assistant/')
    await target.waitForFunction(() =>
      document.querySelector<HTMLTextAreaElement>('textarea')?.value.includes('QA edited handoff title')
    )
    assert.equal(await target.getByRole('button', { name: 'Pick up task', exact: true }).count(), 0)
    const items = await target.evaluate(() => window.remember.listWorkItems())
    const updated = items.find((item) => item.id === open.id)
    assert.equal(updated?.title, 'QA edited handoff title')
    assert.equal(updated.agentSessions.length, 0, 'Opening Agent must not launch a legacy task worker')
    writeJson('inbox-list-proof.json', {
      total,
      mounted,
      toggleMs,
      handoffTaskId: open.id,
      savedTitle: updated.title,
      legacyWorkerSessions: updated.agentSessions.length,
    })
    await target.screenshot({ path: join(runDirectory, 'inbox-agent-handoff.png') })
    await closeElectron()
    const restarted = await launch()
    const retained = (await restarted.evaluate(() => window.remember.listWorkItems())).find(
      (item) => item.id === open.id
    )
    assert.equal(retained?.title, updated.title)
    assert.equal(retained.agentSessions.length, 0)
    checks.push(
      'Completed archive mounts fewer than50 rows; end scrolling, cross-viewport select-all and closed-task deep links remain available'
    )
    checks.push(
      'Delegate saves the latest task title, opens an editable Agent draft without a legacy worker, and preserves task edits through full Electron restart'
    )
    return
  }
  if (process.argv.includes('--conversation-deletion')) {
    report.scope = 'Synthetic manual recordings, real deletion IPC and full Electron restart; no capture or model'
    const store = new EvidenceStore(join(profile, 'daily-review/evidence.sqlite'))
    const day = store.readSessions().find((candidate) => candidate.id === fixture.dayId)
    assert(day)
    const meetingIds: string[] = []
    for (const offset of [120_000, 240_000]) {
      const meeting = store.createManualMeeting(
        day.id,
        'QA failed recording',
        day.startedAt + offset,
        day.startedAt + offset,
        day.startedAt + offset,
        false
      )
      store.updateManualMeetingDetails(
        meeting.id,
        meeting.title,
        'Keep unrelated recordings and delete only this disposable fixture.'
      )
      const finished = store.finishManualMeeting(meeting.id, day.startedAt + offset + 60_000, true)
      const episode = manualMeetingEpisode(finished, [])
      store.upsertManualMeetingEpisode(episode)
      const linked = store.setManualMeetingEpisode(meeting.id, episode.id)
      store.completeManualMeeting(meeting.id)
      day.memory = memoryWithFinishedManualMeetingConversation(
        memoryWithManualMeetingConversation(day, linked),
        meeting.id,
        'revinote'
      )
      store.upsertSession(day)
      meetingIds.push(meeting.id)
    }
    const remoteMeeting = store.createManualMeeting(
      day.id,
      'QA removed remote recording',
      day.startedAt + 360_000,
      day.startedAt + 360_000,
      day.startedAt + 360_000,
      false
    )
    const remoteFinished = store.finishManualMeeting(remoteMeeting.id, day.startedAt + 420_000, true)
    const remoteEpisode = manualMeetingEpisode(remoteFinished, [])
    store.upsertManualMeetingEpisode(remoteEpisode)
    const remoteLinked = store.setManualMeetingEpisode(remoteMeeting.id, remoteEpisode.id)
    store.completeManualMeeting(remoteMeeting.id)
    day.memory = memoryWithManualMeetingConversation(day, remoteLinked)
    store.upsertSession(day)
    const remoteDirectory = join(profile, 'integrations', 'revinote')
    mkdirSync(remoteDirectory, { recursive: true })
    writeFileSync(
      join(remoteDirectory, 'post-processing.json'),
      JSON.stringify({
        version: 1,
        submissions: {
          [remoteEpisode.id]: {
            meetingId: 'qa-server-removed',
            submittedAt: day.startedAt + 420_000,
            settledAt: day.startedAt + 480_000,
          },
        },
        pending: {},
        failures: {},
      })
    )
    store.close()
    const target = await launch()
    const before = await target.evaluate(() => window.remember.listDays())
    assert.equal(
      before
        .find((candidate) => candidate.id === fixture.dayId)
        ?.memory?.conversations.some((conversation) => conversation.episodeId === remoteEpisode.id),
      false
    )
    const conversations = before
      .find((candidate) => candidate.id === fixture.dayId)
      ?.memory?.conversations.filter((conversation) => meetingIds.includes(conversation.manualMeetingId ?? ''))
    assert.equal(conversations?.length, 2)
    const timings = []
    for (const conversation of conversations ?? []) {
      assert(conversation.episodeId)
      await target.goto(
        `${webUrl}/conversations/conversation/?id=${day.id}&conversation=${encodeURIComponent(`episode:${conversation.episodeId}`)}`
      )
      await target.getByRole('heading', { name: conversation.title, exact: true }).waitFor()
      await target.getByText('Couldn’t create a summary', { exact: true }).waitFor()
      await target.getByRole('button', { name: `More options for ${conversation.title}`, exact: true }).click()
      const openedAt = performance.now()
      await target.getByRole('menuitem', { name: 'Delete conversation', exact: true }).click()
      const dialog = target.getByRole('dialog', { name: 'Delete conversation?', exact: true })
      await dialog.getByRole('heading').waitFor({ state: 'visible', timeout: 3_000 })
      const openMs = performance.now() - openedAt
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await dialog.waitFor({ state: 'hidden' })
      await target.getByRole('button', { name: `More options for ${conversation.title}`, exact: true }).click()
      await target.getByRole('menuitem', { name: 'Delete conversation', exact: true }).click()
      const deletedAt = performance.now()
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
      await target.waitForURL((url) => url.pathname === '/conversations/', { timeout: 15_000 })
      timings.push({ episodeId: conversation.episodeId, openMs, deleteMs: performance.now() - deletedAt })
    }
    writeJson('conversation-deletion-timings.json', timings)
    await target.screenshot({ path: join(runDirectory, 'conversation-deletion-finished.png') })
    await closeElectron()
    const restarted = await launch()
    const after = await restarted.evaluate(() => window.remember.listDays())
    const restored = after.find((candidate) => candidate.id === fixture.dayId)
    assert(restored?.memory)
    assert.equal(
      restored.memory.conversations.some((conversation) => meetingIds.includes(conversation.manualMeetingId ?? '')),
      false
    )
    assert(restored.memory.conversations.some((conversation) => conversation.episodeId === fixture.episodeId))
    assert.equal(
      restored.memory.conversations.some((conversation) => conversation.episodeId === remoteEpisode.id),
      false
    )
    assert(restored.memory.deletedConversationWindows?.some((deleted) => deleted.episodeId === remoteEpisode.id))
    writeJson('conversation-deletion-proof.json', {
      meetingIds,
      deleted: conversations,
      after: restored.memory.conversations,
    })
    checks.push(
      'Local deletions and a completed remote record removal survive full Electron restart; unrelated conversation remains'
    )
    return
  }

  const integrationDirectory = join(profile, 'integrations', 'revinote')
  mkdirSync(integrationDirectory, { recursive: true })
  const importedMeeting = {
    id: 'qa-revinote-finished',
    title: 'QA Revinote meeting',
    status: 'finished',
    date: '2020-01-01T12:00:00.000Z',
    updatedAt: '2020-01-01T13:00:00.000Z',
    participants: [],
    summary: 'Imported fixture',
    actionItems: [],
    durationSeconds: 600,
    transcript: null,
  }
  writeFileSync(
    join(integrationDirectory, 'meetings.json'),
    JSON.stringify({
      version: 1,
      cursor: 'qa-cursor',
      lastSyncedAt: Date.now(),
      meetings: {
        [importedMeeting.id]: importedMeeting,
        'qa-revinote-processed': { ...importedMeeting, id: 'qa-revinote-processed', status: 'processed' },
      },
    })
  )
  let target = await launch()
  if (process.argv.includes('--revinote-processing')) {
    assert(electron)
    await revinoteProcessingRecoveryQa({ getElectron: () => electron, profile, checks, close: closeElectron, launch })
    return
  }
  if (process.argv.includes('--codex-worker')) {
    report.scope = 'Codex Worker native approvals, cancellation and session persistence with a synthetic App Server'
    await codexWorkerQa(target, webUrl, runDirectory)
    await residentAgentQa(target, webUrl, runDirectory)
    checks.push(
      'Codex Worker approval, result persistence after reload, cancellation and projectless session identity cross real Electron IPC'
    )
    await closeElectron()
    target = await launch()
    const restored = await target.evaluate(async () =>
      (await window.remember.listWorkItems()).find((item) => item.title === 'Codex Worker QA')
    )
    assert.equal(
      restored?.agentSessions.find((session) => session.id === 'qa-approve')?.response,
      'Synthetic Worker result verified.'
    )
    assert.equal(restored?.agentSessions.find((session) => session.id === 'qa-cancel')?.status, 'cancelled')
    checks.push('Worker result and cancellation survive full Electron restart')
    await residentAgentAfterRestartQa(target, webUrl, runDirectory)
    checks.push(
      'Persistent assistant draft, approvals, cancel/retry, consent revocation and messages survive real IPC, renderer reload and full Electron restart; deterministic provider fixture'
    )
    return
  }

  const settings = await target.evaluate(() => window.remember.getSettings())
  assert(settings.offlineMode && settings.capturePaused)
  assert(electron)
  const days = await target.evaluate(() => window.remember.listDays())
  const importedConversations = days
    .flatMap((day) => day.memory?.conversations ?? [])
    .filter((conversation) => conversation.source === 'revinote')
  assert.deepEqual(
    importedConversations.map((conversation) => conversation.externalId),
    [importedMeeting.id]
  )
  checks.push('Cached processed Revinote meetings are excluded during native startup')
  await target.goto(`${webUrl}/conversations/`)
  await target.getByRole('button', { name: /Conversation preferences|Gespreksvoorkeuren/i }).click()
  const preferencesTitle = target.getByRole('heading', { name: /Conversation preferences|Gespreksvoorkeuren/i })
  await preferencesTitle.waitFor()
  const callbackUrl = target.url()
  assert(electron)
  await electron.evaluate(({ app }) => {
    app.emit('open-url', { preventDefault() {} }, 'remember://revinote/callback?code=qa-code&state=qa-state')
  })
  // Offline mode rejects the callback, exercising the shared completion/finally path.
  await delay(500)
  assert.equal(target.url(), callbackUrl)
  assert.equal(await preferencesTitle.isVisible(), true)
  checks.push('OAuth callback completion preserves Conversations and its open preferences modal')
  const disconnected = await target.evaluate(() => window.remember.disconnectRevinote())
  assert.equal(disconnected.state, 'disconnected')
  assert.equal(disconnected.importedCount, 0)
  assert.equal(existsSync(join(integrationDirectory, 'meetings.json')), false)
  assert.equal(
    (await target.evaluate(() => window.remember.listDays())).some((day) =>
      day.memory?.conversations.some((conversation) => conversation.source === 'revinote')
    ),
    false
  )
  checks.push('Disconnect removes imported meetings through real IPC and deletes their persisted snapshot')
  const day = days.find((day) => day.id === fixture.dayId)
  assert.equal(day?.contextMoments[0]?.id, 'qa-context')
  assert.equal(day?.moments[0]?.id, 'qa-audio')
  assert(day?.contextMoments[0] && !('text' in day.contextMoments[0]), 'Day navigation must not hydrate source text')
  for (const query of ['example.test/verification', 'Known input value']) {
    const matches = await target.evaluate((query) => window.remember.searchDays(query, 'en-US'), query)
    assert(
      matches.timeline.some((result) => result.day.id === fixture.dayId),
      `Original context must remain searchable: ${query}`
    )
  }
  assert.deepEqual(day?.memory?.timeline[0]?.sourceRefs?.map((ref) => `${ref.kind}:${ref.id}`).sort(), [
    'app:qa-focus',
    'audio:qa-audio',
    'context:qa-context',
  ])
  checks.push('Fixture evidence hydrated through real preload and IPC')
  const agentProvider = await target.evaluate(async () => {
    const before = await window.remember.getSettings()
    const agent = await window.remember.checkAgent('claude')
    const after = await window.remember.getSettings()
    return { provider: agent.provider, before: before.defaultAgentProvider, after: after.defaultAgentProvider }
  })
  assert.equal(agentProvider.provider, 'claude')
  assert.equal(agentProvider.before, agentProvider.after)
  checks.push('Provider-specific agent check crosses real IPC without changing the default agent')
  const initialUsage = await target.evaluate(() => window.remember.getAgentUsage())
  assert.equal(initialUsage.firstRecordedAt, null)
  const usageRecordedAt = Date.now()
  writeFileSync(
    join(profile, 'daily-review', 'agent-usage.ndjson'),
    `${JSON.stringify({ id: 'qa-usage', provider: 'codex', model: 'qa-fixture', recordedAt: usageRecordedAt, inputTokens: 840, outputTokens: 60, cachedInputTokens: 500 })}\n`,
    { mode: 0o600 }
  )
  const recordedUsage = await target.evaluate(() => window.remember.getAgentUsage())
  assert.equal(recordedUsage.firstRecordedAt, usageRecordedAt)
  assert.deepEqual(recordedUsage.providers[0].today, { inputTokens: 840, outputTokens: 60, cachedInputTokens: 500 })
  const offlineAccountUsage = await target.evaluate(() => window.remember.getAgentAccountUsage('codex'))
  assert.deepEqual(offlineAccountUsage.windows, [])
  await target.goto(`${webUrl}/agent/`)
  await target.getByText('900 tokens', { exact: true }).waitFor({ timeout: 30_000 })
  await target.screenshot({ path: join(runDirectory, 'agent-usage.png') })
  checks.push(
    'Agent usage crosses real preload/IPC, renders recorded tokens, and keeps unavailable account limits unknown offline'
  )

  const title = 'Timeline edit survives Electron restart'
  const dayTransport = await target.evaluate(
    async ({ dayId, timelineId, title }) => {
      const before = await window.remember.listDaySnapshot()
      const changes: DayChanges[] = []
      let received!: () => void
      let timeout: ReturnType<typeof setTimeout> | undefined
      const edited = new Promise<void>((resolve, reject) => {
        received = resolve
        timeout = setTimeout(() => reject(new Error('Timeline edit did not publish a day patch')), 10_000)
      })
      const unsubscribe = window.remember.onDays((change) => {
        changes.push(change)
        if (
          change.changes.some(
            (entry) =>
              entry.day.id === dayId &&
              entry.day.memory?.timeline.some((item) => item.id === timelineId && item.title === title)
          )
        ) {
          received()
        }
      })
      try {
        await window.remember.updateTimelineItem(dayId, timelineId, {
          title,
          description: 'Updated through the production IPC handler',
        })
        await edited
        return { before, after: await window.remember.listDaySnapshot(), changes }
      } finally {
        clearTimeout(timeout)
        unsubscribe()
      }
    },
    { ...fixture, title }
  )
  const editedDayChanges = dayTransport.changes.flatMap((change) =>
    change.changes.filter((entry) => entry.day.id === fixture.dayId)
  )
  assert(editedDayChanges.length > 0)
  for (const change of editedDayChanges) {
    assert.equal('contextMoments' in change.day, false)
    assert.equal('appActivity' in change.day, false)
    assert.equal('moments' in change.day, false)
    assert.equal(change.contextMoments, undefined, 'A Timeline edit must not resend full context history')
    assert.equal(change.appActivity, undefined, 'A Timeline edit must not resend unchanged app history')
    assert.equal(change.moments, undefined, 'A Timeline edit must not resend unchanged audio history')
  }
  let reconstructed = dayTransport.before
  for (const change of dayTransport.changes) {
    const next = applyDayChanges(reconstructed, change)
    assert(next, 'Native day patches must apply to their preceding revision without a snapshot repair')
    reconstructed = next
  }
  assert.deepEqual(reconstructed, dayTransport.after)
  writeJson('day-transport-proof.json', {
    beforeRevision: dayTransport.before.revision,
    afterRevision: dayTransport.after.revision,
    patchCount: dayTransport.changes.length,
    patchBytes: Buffer.byteLength(JSON.stringify(dayTransport.changes)),
    snapshotBytes: Buffer.byteLength(JSON.stringify(dayTransport.before)),
    unchangedHistoryOmitted: true,
    replayMatchesSnapshot: true,
  })
  checks.push('Native Timeline edits publish revisioned day patches without retransmitting unchanged capture history')
  const sound = await playback(target, fixture.dayId, fixture.episodeId)
  assert.equal(sound.duration, 2)
  checks.push('Persisted WAV played muted through the real remember-audio media protocol')
  const retainedBytes = readFileSync(fixture.audioPath)
  const audioExport = join(runDirectory, 'conversation-download.wav')
  assert.equal(await saveConversationAudio(target, fixture.dayId, fixture.episodeId, null), false)
  assert.equal(existsSync(audioExport), false)
  assert.equal(await saveConversationAudio(target, fixture.dayId, fixture.episodeId, audioExport), true)
  assert.deepEqual(readFileSync(audioExport), retainedBytes)
  assert.deepEqual(readFileSync(fixture.audioPath), retainedBytes)
  assert.deepEqual(await playback(target, fixture.dayId, fixture.episodeId), sound)
  checks.push('Native audio export preserves retained WAV bytes; cancellation is quiet and playback remains available')
  await target.goto(`${webUrl}/day/timeline/?id=${fixture.dayId}`)
  await target.getByText(title, { exact: true }).first().waitFor({ state: 'visible', timeout: 30_000 })
  target = await rendererRecoveryQa(target, fixture, title)
  const reloadedSnapshot = await target.evaluate(() => window.remember.listDaySnapshot())
  assert(reloadedSnapshot.revision >= dayTransport.after.revision)
  assert.deepEqual(
    reloadedSnapshot.days.find((candidate) => candidate.id === fixture.dayId),
    reconstructed.days.find((candidate) => candidate.id === fixture.dayId)
  )
  checks.push('A fresh day snapshot restores the full edited day and capture history after renderer reload')
  const inboxArtifact = await target.evaluate(async () => {
    const item = await window.remember.createWorkItem({
      title: 'Prepare QA discussion',
      description: 'Prepare options for a human decision.',
    })
    const sessionId = 'qa-inbox-worker'
    await window.remember.startWorkItemAgentSession(item.id, {
      sessionId,
      provider: 'codex',
      prompt: 'Prepare the discussion.',
      message: 'Pick up task',
      startedAt: Date.now(),
    })
    const input = {
      response:
        '## Briefing\nTwo options and their evidence.\n\n```remember-task-update\n{"summary":"Prepared the briefing","remaining":"Human decision","nextStep":"Discuss the options","needsUser":true}\n```',
      durationMs: 100,
      steps: [],
    }
    const saved = await window.remember.finishWorkItemAgentSession(item.id, sessionId, input)
    const repeated = await window.remember.finishWorkItemAgentSession(item.id, sessionId, input)
    return { saved, repeated }
  })
  const inboxTasks = await target.evaluate(() => window.remember.listWorkItems())
  const aiTask = inboxTasks.find((item) => item.title === 'Make a QA PDF')
  const personalTask = inboxTasks.find((item) => item.title === 'Swap suitcase with Tom')
  assert.ok(aiTask)
  assert.ok(personalTask)
  assert.equal(aiTask.aiSuggestion, 'Want me to make a PDF with the answers?')
  assert.equal(personalTask.aiSuggestion, null)
  checks.push('Explicit AI offer and personal task distinction cross real Inbox IPC')
  assert.deepEqual(inboxArtifact.saved, inboxArtifact.repeated)
  assert.equal(inboxArtifact.saved.lifecycle, 'open')
  assert.equal(inboxArtifact.saved.attention, 'waiting_on_user')
  assert.equal(inboxArtifact.saved.agentSessions[0]?.response, '## Briefing\nTwo options and their evidence.')
  checks.push('Inbox artifact and worker update cross real IPC idempotently without completing the human commitment')
  const before = await checkpoint('before-restart')
  await target.evaluate(({ dayId, timelineId }) => window.remember.hideTimelineItem(dayId, timelineId), fixture)
  await closeElectron()
  const restarted = await launch()
  const restoredInboxArtifact = (await restarted.evaluate(() => window.remember.listWorkItems())).find(
    (item) => item.id === inboxArtifact.saved.id
  )
  assert.deepEqual(restoredInboxArtifact, inboxArtifact.saved)
  const restoredTasks = await restarted.evaluate(() => window.remember.listWorkItems())
  assert.equal(restoredTasks.find((item) => item.id === aiTask.id)?.aiSuggestion, aiTask.aiSuggestion)
  assert.equal(restoredTasks.find((item) => item.id === personalTask.id)?.aiSuggestion, null)
  checks.push('Optional AI offers and personal tasks survive full Electron restart')
  checks.push('Inbox artifact, evidence, next step and waiting-on-user state survive full Electron restart')
  const restartedDays = await restarted.evaluate(() => window.remember.listDays())
  const restartedSnapshot = await restarted.evaluate(() => window.remember.listDaySnapshot())
  assert.deepEqual(restartedSnapshot.days, restartedDays)
  assert(Number.isInteger(restartedSnapshot.revision) && restartedSnapshot.revision >= 0)
  assert.deepEqual(await restarted.evaluate(() => window.remember.getAgentUsage()), recordedUsage)
  checks.push('Recorded AI token usage survives full Electron restart without backfilling unrecorded history')

  assert.equal(
    restartedDays.some((day) => day.memory?.conversations.some((conversation) => conversation.source === 'revinote')),
    false
  )
  checks.push('Disconnected Revinote meetings remain absent after full process restart')
  const restored = restartedDays.find((day) => day.id === fixture.dayId)
  assert.equal(restored?.memory?.timeline.find((item) => item.id === fixture.timelineId)?.title, title)
  assert.equal(restored?.contextMoments[0]?.id, 'qa-context')
  assert.deepEqual(restored?.contextMoments, day.contextMoments)
  assert.deepEqual(restored?.appActivity, day.appActivity)
  assert.deepEqual(restored?.memory?.timeline[0]?.sourceRefs, day.memory?.timeline[0]?.sourceRefs)
  assert(restored?.memory?.hiddenTimelineItemIds?.includes(fixture.timelineId))
  assert.deepEqual(await playback(restarted, fixture.dayId, fixture.episodeId), sound)
  await restarted.goto(`${webUrl}/day/timeline/?id=${fixture.dayId}`)
  await restarted
    .getByRole('heading', { name: /September|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/ })
    .first()
    .waitFor()
  assert.equal(await restarted.getByText(title, { exact: true }).count(), 0)
  await restarted.evaluate((dayId) => window.remember.showHiddenTimelineItems(dayId), fixture.dayId)
  await restarted.getByText(title, { exact: true }).first().waitFor({ state: 'visible', timeout: 30_000 })
  checks.push('Updated Timeline item rendered visibly before and after restart')
  checks.push('Context URL, focused input, app focus and audio provenance survived hide/restart/restore')
  const after = await checkpoint('after-restart')
  assert.deepEqual(after.wavs, before.wavs)
  assert.deepEqual(after.audio, before.audio)
  checks.push('Timeline edit, context evidence, audio rows and WAV hashes survive full process restart')
  assert.deepEqual(rendererErrors, [], 'Unexpected renderer exceptions')
  checks.push('SQLite integrity and foreign keys valid; no renderer exceptions')
  assert(electron)
  await verifyDayPreparationQa(electron, fixture.dayId, checks)
  await verifyMainControlHitAreas(restarted)
  await revinoteCompletion(restarted, fixture)
  assert(electron)
  const processingRestarted = await revinoteProcessingRecoveryQa({
    getElectron: () => electron,
    profile,
    checks,
    close: closeElectron,
    launch,
  })
  assert(electron)
  await edgeWidgetQa(electron, processingRestarted, runDirectory, checks)
  await closeElectron()
  const widgetRestarted = await launch()
  assert.equal((await widgetRestarted.evaluate(() => window.remember.getSettings())).edgeWidgetEnabled, false)
  assert.equal(
    electron?.windows().some((window) => window.url().includes('/edge-widget/')),
    false
  )
  assert(electron)
  const widgetCreated = electron.waitForEvent('window')
  await widgetRestarted.evaluate(() => window.remember.updateSettings({ edgeWidgetEnabled: true }))
  const restoredWidget = await widgetCreated
  await restoredWidget.waitForURL('**/edge-widget/')
  await widgetRestarted.evaluate(() => window.remember.updateSettings({ edgeWidgetEnabled: false }))
  checks.push('Widget opt-out survives Electron restart and re-enabling recreates the native window')
}

async function reconnectRecoveredRenderer(url: string) {
  await recoveredBrowser?.close()
  // Playwright permanently marks the old CDP target as crashed. Attach afresh to
  // this run's renderer without navigating, recreating a window or restarting main.
  const [port, endpoint] = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').trim().split('\n')
  assert(port && /^\d+$/.test(port) && endpoint?.startsWith('/devtools/browser/'))
  recoveredBrowser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}${endpoint}`, { noDefaults: true })
  const target = recoveredBrowser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url() === url)
  assert(target, 'Recovered native renderer must remain at its original route')
  page = target
  target.on('pageerror', (error) => rendererErrors.push(error.message))
  target.on('console', (message) =>
    appendFileSync(join(runDirectory, 'console.log'), `[${message.type()}] ${message.text()}\n`)
  )
  return target
}

async function rendererRecoveryQa(target: Page, fixture: ReturnType<typeof seedProfile>, title: string) {
  assert(electron)
  const originalUrl = target.url()
  const beforeSettings = await target.evaluate(() => window.remember.getSettings())
  const beforeDay = await target.evaluate(
    async (dayId) => (await window.remember.listDays()).find((day) => day.id === dayId),
    fixture.dayId
  )
  const beforeEvidence = inspectEvidence(profile)
  const recovered = await electron.evaluate(async ({ BrowserWindow }, url) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL() === url)
    if (!window) throw new Error('QA renderer window missing')
    const originalWindowIds = BrowserWindow.getAllWindows()
      .map((candidate) => candidate.id)
      .sort()
    const mainPid = process.pid
    const rendererPid = window.webContents.getOSProcessId()
    let reason = ''
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Renderer did not recover after crash')), 30_000)
      window.webContents.once('did-finish-load', () => {
        clearTimeout(timeout)
        resolve()
      })
      window.webContents.once('render-process-gone', (_event, details) => {
        reason = details.reason
        // Closing while recovery is queued must leave the menu-bar app hidden.
        window.close()
      })
      window.webContents.forcefullyCrashRenderer()
    })
    return {
      mainPid,
      recoveredMainPid: process.pid,
      rendererPid,
      recoveredRendererPid: window.webContents.getOSProcessId(),
      windowId: window.id,
      originalWindowIds,
      windowIds: BrowserWindow.getAllWindows()
        .map((candidate) => candidate.id)
        .sort(),
      visible: window.isVisible(),
      crashed: window.webContents.isCrashed(),
      url: window.webContents.getURL(),
      bridgeAvailable: await window.webContents.executeJavaScript('typeof window.remember?.listDays === "function"'),
      reason,
    }
  }, originalUrl)
  writeJson('renderer-recovery.json', { recovered })
  assert.equal(recovered.mainPid, recovered.recoveredMainPid)
  assert.notEqual(recovered.rendererPid, recovered.recoveredRendererPid)
  assert.deepEqual(recovered.windowIds, recovered.originalWindowIds)
  assert.equal(recovered.visible, false)
  assert.equal(recovered.crashed, false)
  assert.equal(recovered.url, originalUrl)
  assert.equal(recovered.bridgeAvailable, true, 'Preload bridge must be restored in the real renderer')
  assert(['crashed', 'killed'].includes(recovered.reason))
  target = await reconnectRecoveredRenderer(originalUrl)
  await target.waitForFunction(() => typeof window.remember?.listDays === 'function')
  assert.deepEqual(await target.evaluate(() => window.remember.getSettings()), beforeSettings)
  assert.deepEqual(
    await target.evaluate(
      async (dayId) => (await window.remember.listDays()).find((day) => day.id === dayId),
      fixture.dayId
    ),
    beforeDay
  )
  const afterEvidence = inspectEvidence(profile)
  assert.deepEqual(afterEvidence.audio, beforeEvidence.audio)
  assert.deepEqual(afterEvidence.wavs, beforeEvidence.wavs)
  await electron.evaluate(({ app, BrowserWindow }, id) => {
    app.show()
    BrowserWindow.fromId(id)?.show()
  }, recovered.windowId)
  await target.getByText(title, { exact: true }).first().waitFor({ state: 'visible', timeout: 30_000 })
  await target.screenshot({ path: join(runDirectory, 'renderer-recovered.png') })
  checks.push(
    'Renderer crash recovers the same route, IPC, settings and evidence without restarting main or reopening a hidden window'
  )

  const repeated = await electron.evaluate(async ({ BrowserWindow }, id) => {
    const window = BrowserWindow.fromId(id)
    if (!window) throw new Error('QA renderer window missing')
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Second renderer crash was not observed')), 10_000)
      window.webContents.once('render-process-gone', () => {
        clearTimeout(timeout)
        resolve()
      })
      window.webContents.forcefullyCrashRenderer()
    })
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    return { mainPid: process.pid, crashed: window.webContents.isCrashed(), windowId: window.id }
  }, recovered.windowId)
  assert.equal(repeated.mainPid, recovered.mainPid)
  assert.equal(repeated.crashed, true)
  writeJson('renderer-recovery.json', { recovered, repeated })
  checks.push('A second renderer crash within five minutes does not start an automatic reload loop')
  // Resume the test explicitly after verifying that automatic recovery stopped.
  await electron.evaluate(
    async ({ BrowserWindow }, { id, url }) => {
      await BrowserWindow.fromId(id)?.loadURL(url)
    },
    { id: recovered.windowId, url: originalUrl }
  )
  target = await reconnectRecoveredRenderer(originalUrl)
  await target.waitForFunction(() => typeof window.remember?.listDays === 'function')
  await target.getByText(title, { exact: true }).first().waitFor({ state: 'visible', timeout: 30_000 })
  return target
}

async function revinoteCompletion(target: Page, fixture: ReturnType<typeof seedProfile>) {
  const days = await target.evaluate(() => window.remember.listDays())
  const day = days.find((candidate) => candidate.id === fixture.dayId)
  assert(day)
  const originalAudio = await playback(target, fixture.dayId, fixture.episodeId)
  const meetingId = 'qa-post-processed'
  const remoteMeetingId = 'qa-remote-recorded'
  const hostedAudio = createQaAudioFixture(3_000)
  let hostedAudioAvailable = true
  let audioRequests = 0
  let storageRequests = 0
  let submitted = false
  let polls = 0
  let baseUrl = ''
  let refreshStarted = false
  let releaseRefresh: (() => void) | undefined
  const server = createHttpServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json')
    if (request.url === '/upload') {
      for await (const _chunk of request) {
        /* Consume only the synthetic tone. */
      }
      response.end('{}')
    } else if (request.url === '/api/v1/recordings/presign') {
      response.end(JSON.stringify({ key: 'qa-upload', uploadUrl: `${baseUrl}/upload` }))
    } else if (request.url === '/api/v1/recordings/complete') {
      submitted = true
      response.end(JSON.stringify({ meetingId }))
    } else if (request.url === '/oauth/token') {
      refreshStarted = true
      await new Promise<void>((resolve) => {
        releaseRefresh = () => {
          releaseRefresh = undefined
          response.end(
            JSON.stringify({ access_token: 'refreshed-qa-token', refresh_token: 'qa-refresh', expires_in: 3600 })
          )
          resolve()
        }
      })
    } else if (
      request.url === `/api/v1/meetings/${meetingId}/audio` ||
      request.url === `/api/v1/meetings/${remoteMeetingId}/audio`
    ) {
      audioRequests += 1
      assert.equal(request.headers.authorization, 'Bearer qa-only')
      if (!hostedAudioAvailable) {
        response.statusCode = 410
        response.end('{}')
      } else {
        response.writeHead(302, { Location: `${baseUrl}/storage-audio` })
        response.end()
      }
    } else if (request.url === '/storage-audio') {
      storageRequests += 1
      assert.equal(request.headers.authorization, undefined, 'Storage must not receive connector credentials')
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
      const start = range ? Number(range[1]) : 0
      const end = range?.[2] ? Math.min(Number(range[2]), hostedAudio.length - 1) : hostedAudio.length - 1
      response.setHeader('Content-Type', 'audio/wav')
      response.setHeader('Accept-Ranges', 'bytes')
      if (start >= hostedAudio.length || end < start) {
        response.writeHead(416, { 'Content-Range': `bytes */${hostedAudio.length}` })
        response.end()
      } else {
        response.statusCode = range ? 206 : 200
        if (range) response.setHeader('Content-Range', `bytes ${start}-${end}/${hostedAudio.length}`)
        response.setHeader('Content-Length', end - start + 1)
        response.end(hostedAudio.subarray(start, end + 1))
      }
    } else if (request.url?.startsWith('/api/v1/meetings/sync')) {
      if (submitted) polls += 1
      response.end(
        JSON.stringify({
          meetings: [
            {
              id: remoteMeetingId,
              title: 'QA recorded in Revinote',
              status: 'finished',
              date: new Date(day.startedAt + 60 * 60_000).toISOString(),
              updatedAt: new Date().toISOString(),
              participants: [],
              summary: 'Synthetic remote-only recording',
              actionItems: [],
              durationSeconds: 3,
              transcript: null,
            },
            ...(submitted
              ? [
                  {
                    id: meetingId,
                    title: 'QA automatically completed',
                    status: polls >= 2 ? 'finished' : 'processing',
                    date: new Date(day.startedAt).toISOString(),
                    updatedAt: new Date().toISOString(),
                    participants: [],
                    summary: 'Synthetic completion',
                    actionItems: [],
                    durationSeconds: 2,
                    transcript: null,
                  },
                ]
              : []),
          ],
          nextCursor: `qa-${polls}`,
          hasMore: false,
        })
      )
    } else {
      response.statusCode = 404
      response.end('{}')
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')
  baseUrl = `http://127.0.0.1:${address.port}`
  const directory = join(profile, 'integrations', 'revinote')
  mkdirSync(directory, { recursive: true })
  assert(electron)
  const encrypted = await electron.evaluate(
    ({ safeStorage }, url) =>
      safeStorage
        .encryptString(JSON.stringify({ method: 'api-key', apiKey: 'qa-only', baseUrl: url }))
        .toString('base64'),
    baseUrl
  )
  writeFileSync(join(directory, 'credentials.json'), JSON.stringify({ version: 1, encrypted }), { mode: 0o600 })
  try {
    await target.evaluate(() => window.remember.updateSettings({ offlineMode: false }))
    // Prime the normal two-minute throttle before uploading, then use only automatic polling.
    await target.evaluate(() => window.remember.syncRevinote())
    const result = await target.evaluate(
      ({ dayId, episodeId }) => window.remember.postProcessConversationWithRevinote(dayId, `episode:${episodeId}`),
      fixture
    )
    assert.equal(result.meetingId, meetingId)
    const deadline = Date.now() + 35_000
    let completed = false
    while (Date.now() < deadline && !completed) {
      const current = await target.evaluate(() => window.remember.listDays())
      completed = current.some((candidate) =>
        candidate.memory?.conversations.some(
          (conversation) =>
            conversation.externalId === meetingId && conversation.source === 'revinote' && !conversation.processing
        )
      )
      if (!completed) await delay(250)
    }
    assert(completed, 'Revinote completion must reach the native conversation list without manual resync')
    assert.equal((await playback(target, fixture.dayId, fixture.episodeId)).duration, 3)
    assert.notEqual(originalAudio.duration, 3, 'Hosted and retained recordings must be distinguishable')
    const importedDays = await target.evaluate(() => window.remember.listDays())
    const remoteDay = importedDays.find((candidate) =>
      candidate.memory?.conversations.some((conversation) => conversation.externalId === remoteMeetingId)
    )
    assert(remoteDay)
    const remoteConversation = remoteDay.memory?.conversations.find(
      (conversation) => conversation.externalId === remoteMeetingId
    )
    assert.equal(remoteConversation?.episodeId, undefined)
    assert.equal((await playback(target, remoteDay.id, `external:${remoteMeetingId}`)).duration, 3)
    assert(audioRequests >= 2 && storageRequests >= 2, 'Playback must retrieve authenticated hosted audio')
    const remoteExport = join(runDirectory, 'revinote-conversation-download.wav')
    assert.equal(await saveConversationAudio(target, remoteDay.id, `external:${remoteMeetingId}`, remoteExport), true)
    assert.deepEqual(readFileSync(remoteExport), hostedAudio)
    checks.push(
      'Native audio export saves authenticated Revinote audio for conversations without a retained local file'
    )
    hostedAudioAvailable = false
    assert.deepEqual(await playback(target, fixture.dayId, fixture.episodeId), originalAudio)
    assert.equal(
      await target.evaluate(
        ({ dayId, conversationReference }) => window.remember.getConversationAudioUrl(dayId, conversationReference),
        { dayId: remoteDay.id, conversationReference: `external:${remoteMeetingId}` }
      ),
      null,
      'An expired remote-only recording must not resolve unrelated local audio'
    )
    assert.equal(
      await target.evaluate(
        ({ dayId, episodeId }) => window.remember.getConversationAudioUrl(`${dayId}-unknown`, episodeId),
        fixture
      ),
      null,
      'Revinote playback must remain scoped to the original local day'
    )
    await target.goto(`${webUrl}/conversations/`)
    await target.getByText('QA automatically completed', { exact: true }).waitFor({ state: 'visible' })
    assert.equal(polls, 2)
    const store = JSON.parse(readFileSync(join(directory, 'post-processing.json'), 'utf8'))
    assert(store.submissions[fixture.episodeId].settledAt)
    await delay(11_000)
    assert.equal(polls, 2, 'Fast polling must stop after the submitted meeting completes')
    checks.push('Real IPC uploads synthetic audio and imports completion within 35 seconds without manual resync')
    checks.push('Revinote hosted audio is preferred after processing and plays for imports without a local episode')
    checks.push(
      'Signed storage requests carry seeking ranges but no connector bearer; expired audio falls back locally'
    )
    checks.push('Pending Revinote polling bypasses normal throttling and stops after completion')
    const expiringCredential = await electron.evaluate(
      ({ safeStorage }, url) =>
        safeStorage
          .encryptString(
            JSON.stringify({
              method: 'oauth',
              clientId: 'qa-client',
              accessToken: 'qa-expired',
              refreshToken: 'qa-refresh',
              expiresAt: 0,
              tokenEndpoint: `${url}/oauth/token`,
              baseUrl: url,
              scopes: ['meetings:read'],
            })
          )
          .toString('base64'),
      baseUrl
    )
    writeFileSync(join(directory, 'credentials.json'), JSON.stringify({ version: 1, encrypted: expiringCredential }), {
      mode: 0o600,
    })
    const pendingAudio = target.evaluate(
      ({ dayId, episodeId }) => window.remember.getConversationAudioUrl(dayId, episodeId),
      fixture
    )
    const refreshDeadline = Date.now() + 5_000
    while (!refreshStarted && Date.now() < refreshDeadline) await delay(25)
    assert(refreshStarted, 'Audio access must reach the delayed OAuth refresh fixture')
    await target.evaluate(() => window.remember.disconnectRevinote())
    releaseRefresh?.()
    await pendingAudio
    assert.equal(
      existsSync(join(directory, 'credentials.json')),
      false,
      'A disconnected audio refresh must not restore credentials'
    )
    assert.equal((await target.evaluate(() => window.remember.getRevinoteConnectionStatus())).state, 'disconnected')
    checks.push(
      'Disconnect cancels pending audio authentication and prevents stale refreshes from restoring credentials'
    )
  } finally {
    releaseRefresh?.()
    await target.evaluate(() => window.remember.updateSettings({ offlineMode: true }))
    await target.evaluate(() => window.remember.disconnectRevinote())
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}

async function recoveryReset() {
  const archive = join(profile, 'daily-review', 'evidence.sqlite')
  const database = new DatabaseSync(archive)
  database.exec('PRAGMA user_version = 999')
  database.close()
  const original = readFileSync(archive)
  const target = await launch()
  await target.waitForURL(`${webUrl}/startup-error/data-version/`)
  const reset = target.getByRole('button', { name: /Reset all data|Reset alle gegevens/ })
  await reset.waitFor()
  await target.screenshot({ path: join(runDirectory, 'recovery-reset.png') })
  await target.setViewportSize({ width: 375, height: 700 })
  await reset.hover()
  await target.screenshot({ path: join(runDirectory, 'recovery-reset-narrow.png') })
  assert(electron)
  await electron.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => {
      throw new Error('QA confirmation unavailable')
    }
  })
  await reset.click()
  await target.getByRole('alert').waitFor()
  assert(await reset.isEnabled())
  checks.push('Confirmation failure shows a retryable error')
  await electron.evaluate(({ dialog }) => {
    dialog.showMessageBox = async (
      windowOrOptions: Electron.BaseWindow | Electron.MessageBoxOptions,
      suppliedOptions?: Electron.MessageBoxOptions
    ) => {
      const options = suppliedOptions ?? (windowOrOptions as Electron.MessageBoxOptions)
      if (options?.cancelId !== 0 || options?.defaultId !== 0) throw new Error('Reset must default to cancel')
      return { response: 0, checkboxChecked: false }
    }
  })
  await reset.click()
  await target.waitForFunction(() => !document.querySelector<HTMLButtonElement>('button.bg-danger-700')?.disabled)
  assert.deepEqual(readFileSync(archive), original)
  checks.push('Unsupported schema shows reset; cancelling native confirmation preserves the archive')
  await electron.evaluate(({ app, dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
    // The runner owns the next launch, preserving its process and profile isolation.
    app.relaunch = () => {}
  })
  const exited = once(electron.process(), 'exit')
  await reset.click()
  await exited
  electron = undefined
  page = undefined
  assert(!existsSync(archive))
  assert(!existsSync(join(profile, 'models')))
  assert(!existsSync(join(profile, 'settings.json')))
  checks.push('Confirmed reset removes incompatible archive, settings and model assets through production IPC')
  const restarted = await launch()
  const days = await restarted.evaluate(() => window.remember.listDays())
  assert(!days.some((day) => day.id === 'qa-day'))
  assert(days.every((day) => !day.moments.some((moment) => moment.id === 'qa-audio')))
  assert.equal((await restarted.evaluate(() => window.remember.getSettings())).dayAnalysisOnboardingCompleted, false)
  await checkpoint('reset-bootstrap')
  await restarted.locator('#current-setup-step').waitFor({ timeout: 30_000 })
  await restarted.locator('#setup-content').waitFor({ state: 'visible', timeout: 15_000 })
  const state = await restarted.evaluate(() => window.remember.getState())
  assert.equal(state.permissionsResolved, true)
  assert.equal(state.modelDownloaded, false)
  assert.notEqual(state.status, 'recording')
  await restarted.screenshot({ path: join(runDirectory, 'reset-restarted.png') })
  checks.push('Fresh Electron launch resolves permissions and visibly opens onboarding without models or recording')
  assert.deepEqual(rendererErrors, [], 'Unexpected renderer exceptions')
}

async function learning() {
  async function waitForLearningStatus(
    target: Page,
    ready: (status: Awaited<ReturnType<RememberBridge['getAgentLearningStatus']>>) => boolean
  ) {
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline) {
      const status = await target.evaluate(() => window.remember.getAgentLearningStatus())
      if (ready(status)) return status
      await delay(250)
    }
    throw new Error('Background agent learning did not reach the expected state within 45 seconds')
  }

  const source = join(learningSources, 'codex', 'sessions', 'qa-learning.jsonl')
  mkdirSync(dirname(source), { recursive: true })
  mkdirSync(join(learningSources, 'claude', 'projects'), { recursive: true })
  const learningDayId = 'qa-learning-day'
  const dayStart = new Date()
  dayStart.setHours(0, 0, 0, 0)
  const store = new EvidenceStore(join(profile, 'daily-review', 'evidence.sqlite'))
  try {
    store.upsertSession({
      id: learningDayId,
      startedAt: dayStart.getTime(),
      endedAt: dayStart.getTime() + 60_000,
      activeDurationMs: 0,
      moments: [],
      appActivity: [],
      contextMoments: [],
      memory: null,
      refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
    })
  } finally {
    store.close()
  }
  const target = await launch()
  const teamId = await target.evaluate(async () => {
    const created = await window.remember.createLocalWikiSpace({
      name: 'QA review space',
      description: 'Isolated proposal persistence fixture.',
    })
    const team = created.spaces.find((space) => space.name === 'QA review space')
    if (!team) throw new Error('QA review space missing')
    await window.remember.updateWikiSpace({ spaceId: team.id, maintenanceMode: 'suggest' })
    await window.remember.createWikiPage({ spaceId: team.id, category: 'research', title: 'QA team' })
    await window.remember.updateSettings({
      agentLearningEnabled: true,
      cloudAnalysisConsent: true,
      offlineMode: true,
      frequentDayRefresh: false,
      audioCaptureEnabled: false,
      capturePaused: true,
      capturePauseSources: ['audio'],
      captureSchedule: { enabled: true, weekdays: [], startTime: '09:00', endTime: '19:00' },
      appCaptureMode: 'include',
      includedAppBundleIds: ['com.openai.codex'],
      agentContextBindings: [],
    })
    return team.id
  })
  await waitForLearningStatus(target, (status) => status.lastCheckedAt !== null)
  const timestamp = new Date().toISOString()
  const personal = 'Use pnpm for my projects.'
  const finding = 'Keep transcription sources so colleagues can inspect a finding.'
  const records = [
    { type: 'session_meta', timestamp, payload: { id: 'qa-learning-session' } },
    {
      type: 'response_item',
      timestamp,
      payload: {
        type: 'message',
        id: 'qa-user-preference',
        role: 'user',
        content: [{ type: 'input_text', text: personal }],
      },
    },
    {
      type: 'event_msg',
      timestamp,
      payload: {
        type: 'item_completed',
        item: { type: 'UserMessage', id: 'qa-user-preference', content: [{ type: 'text', text: personal }] },
      },
    },
    {
      type: 'response_item',
      timestamp,
      payload: {
        type: 'message',
        id: 'qa-user-finding',
        role: 'user',
        content: [{ type: 'input_text', text: finding }],
      },
    },
    {
      type: 'response_item',
      timestamp,
      payload: {
        type: 'message',
        id: 'qa-agent-proposal',
        role: 'assistant',
        phase: 'final_answer',
        content: [
          { type: 'output_text', text: 'I propose switching all projects to npm, but you have not adopted this.' },
        ],
      },
    },
  ]
  writeFileSync(source, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, { mode: 0o600 })
  const pending = await waitForLearningStatus(target, (status) => status.pendingCount === 3)
  assert.equal(pending.status, 'offline')
  assert.equal(pending.pendingCount, 3, 'Current Codex user forms deduplicate; the assistant remains a separate role')
  assert.equal((await target.evaluate(() => window.remember.getWikiOverview())).suggestions.length, 0)
  assert(
    !(await target.evaluate(() => window.remember.listWikiPages('personal'))).some(
      (entry) => entry.slug === 'processes/qa-work-preferences'
    )
  )
  writeJson('learning-offline.json', pending)
  const offlineTrace = (await target.evaluate(() => window.remember.listAgentTrace())).filter(
    (event) => event.action === 'agent-learning'
  )
  assert(offlineTrace.some((event) => event.logs.some((entry) => entry.message.includes('offline-modus'))))
  writeJson('learning-offline-trace.json', offlineTrace)
  checks.push(
    'Background scanning journals agent-only current-schema work while offline and records the wait in Agent trace; alternate user representations do not duplicate it'
  )

  await target.evaluate(() => window.remember.updateSettings({ offlineMode: false }))
  const processed = await waitForLearningStatus(
    target,
    (status) => status.pendingCount === 0 && status.lastProcessedAt !== null && status.status !== 'learning'
  )
  assert.equal(processed.pendingCount, 0)
  assert.notEqual(processed.status, 'failed')
  const settings = await target.evaluate(() => window.remember.getSettings())
  assert.equal(settings.frequentDayRefresh, false)
  assert.equal(settings.audioCaptureEnabled, false)
  const personalPage = (await target.evaluate(() => window.remember.listWikiPages('personal'))).find(
    (entry) => entry.slug === 'processes/qa-work-preferences'
  )
  assert(personalPage)
  assert(personalPage.content.includes(personal))
  assert(!personalPage.content.includes('switching all projects'))
  const history = await target.evaluate(() =>
    window.remember.getWikiPageHistory({ spaceId: 'personal', slug: 'processes/qa-work-preferences' })
  )
  assert.equal(history.revisions[0]?.evidence?.[0]?.role, 'user')
  assert.equal(history.revisions[0]?.evidence?.[0]?.documentSourceId, 'qa-learning-session')
  const overview = await target.evaluate(() => window.remember.getWikiOverview())
  const proposal = overview.suggestions.find((entry) => entry.suggestedSpaceId === teamId)
  assert(proposal)
  assert.equal(proposal.dayId, learningDayId)
  assert.equal(proposal.status, 'pending')
  assert.equal(proposal.evidence?.[0]?.role, 'user')
  assert.equal(proposal.evidence?.[0]?.quote, finding)
  const personalChange = overview.personalChanges.find((entry) =>
    entry.changes.some((change) => change.slug === personalPage.slug)
  )
  assert(personalChange)
  assert.equal(personalChange.dayId, learningDayId)
  assert(personalChange.sourceId.startsWith('agent-learning://'))
  assert(!(await target.evaluate((id) => window.remember.listWikiPages(id), teamId))[0]?.content.includes(finding))
  const trace = await target.evaluate(() => window.remember.listAgentTrace())
  const completedTrace = trace.find(
    (event) =>
      event.action === 'agent-learning' &&
      event.logs.some((entry) => entry.message.includes('Wiki-wijzigingen opgeslagen'))
  )
  assert(completedTrace)
  assert.equal(completedTrace.status, 'completed')
  assert(completedTrace.logs.some((entry) => entry.message === 'Nieuwe agentgesprekken verwerken.'))
  assert(completedTrace.logs.some((entry) => entry.message.startsWith('1 Wiki-wijzigingen opgeslagen; 0 ')))
  writeJson('learning-processed.json', { processed, history, proposal, trace })
  checks.push(
    'Background worker commits Personal Auto knowledge and a separate Suggest proposal without a manual processing trigger while Day/audio analysis is off'
  )
  await target.goto(`${webUrl}/wiki/page/?space=personal&slug=${encodeURIComponent(personalPage.slug)}`)
  await target
    .getByRole('textbox', { name: 'Page content', exact: true })
    .getByText(personal, { exact: true })
    .waitFor()
  await target.screenshot({ path: join(runDirectory, 'learning-personal-page.png') })
  await target.goto(`${webUrl}/wiki/suggestions/?space=${encodeURIComponent(teamId)}`)
  await target.getByRole('region', { name: 'Suggestions', exact: true }).getByText(proposal.title).waitFor()
  await target.getByRole('button', { name: 'Dismiss', exact: true }).waitFor({ state: 'visible' })
  await target.screenshot({ path: join(runDirectory, 'learning-space-proposal.png') })
  checks.push('Spaces render the learned Personal page and the separate reviewable knowledge proposal')
  await target.goto(`${webUrl}/agent/`)
  const traceRow = target
    .locator('#agent-trace-events > li')
    .nth(trace.findIndex((event) => event.id === completedTrace.id))
  await traceRow.getByText('Learn from agents', { exact: true }).waitFor()
  await traceRow.getByRole('button', { name: 'More options for Learn from agents' }).click()
  await target.getByRole('menuitem', { name: 'View details' }).click()
  const traceDialog = target.getByRole('dialog', { name: 'Learn from agents' })
  await traceDialog.getByText(/1 Wiki/).waitFor()
  assert((await traceDialog.locator('ol > li').count()) >= completedTrace.logs.length + 2)
  writeJson('learning-rendered-trace.json', { id: completedTrace.id, text: await traceDialog.innerText() })
  await target.screenshot({ path: join(runDirectory, 'learning-processed.png') })
  await traceDialog.getByRole('button', { name: 'Close trace log' }).click()
  assert.equal(await target.getByRole('button', { name: 'Check now', exact: true }).count(), 0)
  checks.push(
    'Real IPC exposes the completed learning trace and its processing logs in the native Agent activity details'
  )

  await closeElectron()
  const restartedAt = Date.now()
  const restarted = await launch()
  const replayed = await waitForLearningStatus(restarted, (status) => (status.lastCheckedAt ?? 0) >= restartedAt)
  assert.equal(replayed.pendingCount, 0)
  assert.deepEqual(
    (await restarted.evaluate(() => window.remember.listAgentTrace())).find((event) => event.id === completedTrace.id),
    completedTrace
  )
  const after = await restarted.evaluate(() => window.remember.getWikiOverview())
  assert.deepEqual(
    after.personalChanges.find((entry) => entry.id === personalChange.id),
    personalChange
  )
  assert.equal(after.suggestions.filter((entry) => entry.suggestedSpaceId === teamId).length, 1)
  assert.deepEqual(
    after.suggestions.find((entry) => entry.id === proposal.id),
    proposal
  )
  const restored = await restarted.evaluate(() =>
    window.remember.getWikiPageHistory({ spaceId: 'personal', slug: 'processes/qa-work-preferences' })
  )
  assert.deepEqual(restored, history)
  checks.push(
    'Full Electron restart preserves source cursor, automatic revision evidence, one unchanged pending proposal, and the completed Agent trace with all logs'
  )
  await restarted.evaluate((id) => window.remember.applyKnowledgeSuggestion({ suggestionId: id }), proposal.id)
  const appliedHistory = await restarted.evaluate(
    (spaceId) => window.remember.getWikiPageHistory({ spaceId, slug: 'research/qa-team' }),
    teamId
  )
  assert.deepEqual(appliedHistory.revisions[0]?.evidence, proposal.evidence)
  await closeElectron()
  const final = await launch()
  const finalProposal = (await final.evaluate(() => window.remember.getWikiOverview())).suggestions.find(
    (entry) => entry.id === proposal.id
  )
  assert.equal(finalProposal?.status, 'applied')
  assert.deepEqual(
    (
      await final.evaluate(
        (spaceId) => window.remember.getWikiPageHistory({ spaceId, slug: 'research/qa-team' }),
        teamId
      )
    ).revisions[0]?.evidence,
    proposal.evidence
  )
  writeJson('learning-restarted.json', { replayed, appliedHistory, finalProposal })
  checks.push(
    'Accepting the reviewed contribution retains its supporting evidence on the committed revision after another restart'
  )
  const learnedRevision = appliedHistory.revisions[0]
  assert(learnedRevision)
  const undoInput = {
    spaceId: teamId,
    slug: 'research/qa-team',
    revisionId: learnedRevision.id,
    expectedRevision: learnedRevision.id,
  }
  await assert.rejects(
    final.evaluate((input) => window.remember.undoWikiLearning(input), {
      ...undoInput,
      expectedRevision: 'stale-revision',
    }),
    /wiki-page-conflict/
  )
  assert.equal(
    (
      await final.evaluate(
        (spaceId) => window.remember.getWikiPageHistory({ spaceId, slug: 'research/qa-team' }),
        teamId
      )
    ).headRevisionId,
    learnedRevision.id
  )
  await final.evaluate((input) => window.remember.undoWikiLearning(input), undoInput)
  assert(
    !(await final.evaluate((id) => window.remember.listWikiPages(id), teamId))
      .find((entry) => entry.slug === 'research/qa-team')
      ?.content.includes(finding)
  )
  const personalRevision = history.revisions[0]
  assert(personalRevision)
  await final.evaluate(
    (revisionId) =>
      window.remember.undoWikiLearning({
        spaceId: 'personal',
        slug: 'processes/qa-work-preferences',
        revisionId,
        expectedRevision: revisionId,
      }),
    personalRevision.id
  )
  assert(
    !(await final.evaluate(() => window.remember.listWikiPages('personal'))).some(
      (entry) => entry.slug === 'processes/qa-work-preferences'
    )
  )
  checks.push(
    'Undo rejects a stale revision, restores an existing page, and removes a newly learned leaf without deleting unrelated content'
  )
  await closeElectron()
  // Re-enqueue only this fixture's committed events, simulating a crash/retry
  // after an inference result. This tests the final write guard independently
  // from the source reader's normal duplicate suppression.
  const journal = new DatabaseSync(join(profile, 'daily-review', 'agent-activity.sqlite'))
  journal
    .prepare(
      "UPDATE activity_span SET status = 'pending', completed_at = NULL, available_at = 0 WHERE event_id IN (SELECT id FROM activity_event WHERE session_id = ?)"
    )
    .run('qa-learning-session')
  journal.close()
  const replayStartedAt = Date.now()
  const replay = await launch()
  const replayStatus = await waitForLearningStatus(
    replay,
    (status) =>
      status.pendingCount === 0 && (status.lastProcessedAt ?? 0) >= replayStartedAt && status.status !== 'learning'
  )
  assert.equal(replayStatus.pendingCount, 0)
  assert.notEqual(replayStatus.status, 'failed')
  assert(
    !(await replay.evaluate(() => window.remember.listWikiPages('personal'))).some(
      (entry) => entry.slug === 'processes/qa-work-preferences'
    )
  )
  assert(
    !(await replay.evaluate((id) => window.remember.listWikiPages(id), teamId))
      .find((entry) => entry.slug === 'research/qa-team')
      ?.content.includes(finding)
  )
  assert.equal(
    (await replay.evaluate(() => window.remember.getWikiOverview())).suggestions.filter(
      (entry) => entry.suggestedSpaceId === teamId
    ).length,
    1
  )
  writeJson('learning-rejected-replay.json', replayStatus)
  checks.push(
    'Replaying the original journal after restart cannot recreate undone personal knowledge or a rejected project contribution'
  )
  await closeElectron()
  const writeFindingSession = (sessionId: string, observedAt: string) => {
    const entries = [
      { type: 'session_meta', timestamp: observedAt, payload: { id: sessionId } },
      {
        type: 'response_item',
        timestamp: observedAt,
        payload: {
          type: 'message',
          id: `${sessionId}-user`,
          role: 'user',
          content: [{ type: 'input_text', text: finding }],
        },
      },
    ]
    writeFileSync(
      join(learningSources, 'codex', 'sessions', `${sessionId}.jsonl`),
      `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
      { mode: 0o600 }
    )
  }
  const reaffirmedAt = new Date().toISOString()
  writeFindingSession('qa-learning-reaffirmed', reaffirmedAt)
  const reviewStartedAt = Date.now()
  const review = await launch()
  await waitForLearningStatus(
    review,
    (status) =>
      status.pendingCount === 0 && (status.lastProcessedAt ?? 0) >= reviewStartedAt && status.status !== 'learning'
  )
  const reviewProposal = (await review.evaluate(() => window.remember.getWikiOverview())).suggestions.find(
    (entry) => entry.suggestedSpaceId === teamId && entry.status === 'pending'
  )
  assert(reviewProposal, 'A later original user statement may propose previously rejected knowledge again')
  await review.goto(`${webUrl}/wiki/suggestions/?space=${encodeURIComponent(teamId)}`)
  const dismiss = review.getByRole('button', { name: 'Dismiss', exact: true })
  await dismiss.waitFor({ state: 'visible' })
  await review.screenshot({ path: join(runDirectory, 'learning-before-dismiss.png') })
  await dismiss.click()
  await dismiss.waitFor({ state: 'detached' })
  const dismissed = (await review.evaluate(() => window.remember.getWikiOverview())).suggestions.find(
    (entry) => entry.id === reviewProposal.id
  )
  assert.equal(dismissed?.status, 'dismissed')
  await review.screenshot({ path: join(runDirectory, 'learning-after-dismiss.png') })
  await review.evaluate((spaceId) => window.remember.updateWikiSpace({ spaceId, maintenanceMode: 'auto' }), teamId)
  await closeElectron()

  // A distinct original event before dismissal must reach inference rather than
  // disappearing through the reader's same-origin deduplication.
  writeFindingSession('qa-learning-old-copy', new Date(Date.parse(reaffirmedAt) + 1).toISOString())
  const copyStartedAt = Date.now()
  const copied = await launch()
  await waitForLearningStatus(
    copied,
    (status) =>
      status.pendingCount === 0 && (status.lastProcessedAt ?? 0) >= copyStartedAt && status.status !== 'learning'
  )
  const copiedJournal = new DatabaseSync(join(profile, 'daily-review', 'agent-activity.sqlite'), { readOnly: true })
  try {
    const spans = copiedJournal
      .prepare('SELECT s.status FROM activity_span s JOIN activity_event e ON e.id = s.event_id WHERE e.session_id = ?')
      .all('qa-learning-old-copy')
    assert.equal(spans.length, 1, 'The distinct copied-source event must reach the learning worker')
    assert.equal(spans[0]?.status, 'processed')
  } finally {
    copiedJournal.close()
  }
  assert(
    !(await copied.evaluate((spaceId) => window.remember.listWikiPages(spaceId), teamId))
      .find((entry) => entry.slug === 'research/qa-team')
      ?.content.includes(finding),
    'A copied old statement cannot bypass dismissal after switching the Space to Auto'
  )
  const afterCopy = (await copied.evaluate(() => window.remember.getWikiOverview())).suggestions.filter(
    (entry) => entry.suggestedSpaceId === teamId
  )
  assert.equal(afterCopy.length, 2, 'Replaying old evidence must not accumulate another suggestion')
  assert.equal(afterCopy.find((entry) => entry.id === reviewProposal.id)?.status, 'dismissed')
  checks.push(
    'Dismissing a visible knowledge suggestion survives restart and blocks a copied old statement under a new source ID, including after switching the Space to Auto'
  )
  await closeElectron()

  writeFindingSession('qa-learning-explicit-correction', new Date().toISOString())
  const correctionStartedAt = Date.now()
  const corrected = await launch()
  await waitForLearningStatus(
    corrected,
    (status) =>
      status.pendingCount === 0 && (status.lastProcessedAt ?? 0) >= correctionStartedAt && status.status !== 'learning'
  )
  const correctedHistory = await corrected.evaluate(
    (spaceId) => window.remember.getWikiPageHistory({ spaceId, slug: 'research/qa-team' }),
    teamId
  )
  assert(correctedHistory.revisions[0]?.content.includes(finding))
  assert.equal(correctedHistory.revisions[0]?.evidence?.[0]?.documentSourceId, 'qa-learning-explicit-correction')
  writeJson('learning-dismissed-replay.json', { dismissed, afterCopy, correctedHistory })
  checks.push('A genuinely later original user statement can reinstate dismissed knowledge with its new source')
  assert.deepEqual(rendererErrors, [], 'Unexpected renderer exceptions')
}

async function contextLoadingQa(fixture: ReturnType<typeof seedProfile>) {
  const target = await launch()
  const days = await target.evaluate(() => window.remember.listDays())
  const day = days.find((day) => day.id === fixture.dayId)
  assert(day)
  assert(day.contextMoments.some((moment) => moment.id === 'qa-context'))
  assert(day.contextMoments.every((moment) => !('text' in moment) && !('focusedElement' in moment)))
  const query = 'Known input value'
  const matches = await target.evaluate((query) => window.remember.searchDays(query, 'en-US'), query)
  assert(matches.timeline.some((result) => result.day.id === fixture.dayId))
  assert(
    matches.timeline.every((result) => !('contextMoments' in result.day)),
    'Search must return compact results'
  )
  await target.getByRole('button', { name: 'Search', exact: true }).click()
  await target.locator('#remember-search-query').fill(query)
  await target.getByRole('button').filter({ hasText: 'QA timeline fixture' }).waitFor()
  await checkpoint('context-search')
  await closeElectron()
  const restarted = await launch()
  assert.deepEqual(await restarted.evaluate((query) => window.remember.searchDays(query, 'en-US'), query), matches)
  await restarted.getByRole('button', { name: 'Search', exact: true }).click()
  await restarted.locator('#remember-search-query').fill(query)
  await restarted.getByRole('button').filter({ hasText: 'QA timeline fixture' }).waitFor()
  const interrupted = await restarted.evaluate(async (cutoff) => {
    const pending = window.remember.searchDays('Known input value', 'en-US').then(
      () => 'completed',
      (error) => String(error)
    )
    await window.remember.clearRecentCapture(cutoff)
    return pending
  }, day.startedAt)
  // The result must either precede deletion or be rejected; a fresh query must never retain removed text.
  assert(interrupted === 'completed' || interrupted.includes('day-search-interrupted'))
  const removed = await restarted.evaluate((query) => window.remember.searchDays(query, 'en-US'), query)
  assert.equal(removed.timeline.length, 0)
  await restarted.getByRole('button').filter({ hasText: 'QA timeline fixture' }).waitFor({ state: 'hidden' })
  await checkpoint('context-deleted')
  checks.push(
    'Day snapshots contain only context references; original focused input remains searchable through native IPC and UI after restart, compact results never contain source archives, and deleted source text is not returned'
  )
}

async function liveAudio() {
  const target = await launch()
  if (process.argv.includes('--stop-boundary')) {
    await target.evaluate(() => {
      if (!window.remember.onRecordingAudioLevel) throw new Error('Native recording meter subscription missing')
      const samples: RecordingAudioLevel[] = []
      const unsubscribe = window.remember.onRecordingAudioLevel((sample) => samples.push(sample))
      Reflect.set(window, '__qaRecordingLevels', { samples, unsubscribe })
    })
  }
  const tonePath = join(runDirectory, 'system-stimulus.wav')
  writeSystemAudioStimulus(tonePath)
  stimulus = spawn('/usr/bin/afplay', ['--volume', '0.3', tonePath], { stdio: 'ignore' })
  report.stimulus = 'Quiet 220 Hz tone played by afplay through the real system output'
  if (process.argv.includes('--stop-boundary')) {
    assert(electron)
    try {
      const ownedElectron = electron
      const gate = () =>
        ownedElectron.evaluate(
          () => (globalThis as unknown as { qaStopBoundary: { hold: boolean; entered: number } }).qaStopBoundary
        )
      const recordings: Array<{ id: string; episodeId: string; dayId: string; notes: string; elapsedMs: number }> = []
      let discardedRecording: { meetingId: string; momentIds: string[] } | undefined
      await target.evaluate(() => Reflect.set(window, '__qaRecordingDocument', 'retained'))
      for (let index = 0; index < 2; index++) {
        await target.locator('a[title="Conversations"]').click()
        await target.getByRole('button', { name: 'Start conversation', exact: true }).click()
        await target.getByRole('button', { name: /^(Stop opname|Stop recording)$/, exact: true }).waitFor()
        await target
          .locator(
            'button[aria-label="Stop recording"]:not(:disabled), button[aria-label="Stop opname"]:not(:disabled)'
          )
          .waitFor()
        const state = await target.evaluate(() => window.remember.getState())
        assert(state.manualMeeting)
        const activeMeeting = state.manualMeeting
        assert(state.activeSessionId)
        if (index === 0) {
          const bootstrap = await ownedElectron.evaluate(async () => {
            const gate = (
              globalThis as unknown as {
                qaStopBoundary: {
                  bootstrapEntered: boolean
                  bootstrapDone: boolean
                  releaseBootstrap: () => void
                }
              }
            ).qaStopBoundary
            const entered = gate.bootstrapEntered
            gate.releaseBootstrap()
            const deadline = Date.now() + 5000
            while (!gate.bootstrapDone && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
            return { entered, done: gate.bootstrapDone }
          })
          assert(
            bootstrap.entered && bootstrap.done,
            'A held automatic startup must finish while manual capture stays active'
          )
          const current = await target.evaluate(() => window.remember.getState())
          assert.equal(current.manualMeeting?.id, activeMeeting.id)
          assert.equal(current.manualMeeting?.status, 'recording')
          checks.push(
            'Status reads and manual Start work while automatic startup is held; late startup cannot replace the active recording'
          )
        }
        const notes = `Final note for queued recording ${index + 1}`
        if (index === 1) {
          const assertControls = async () => {
            const geometry = await target.locator('[data-recording-controller] aside').evaluate((element) => {
              const bounds = element.getBoundingClientRect()
              const footerElement = document.getElementById('dashboard-page-footer')
              if (!footerElement) throw new Error('Missing recording footer')
              const footer = footerElement.getBoundingClientRect()
              return {
                center: bounds.x + bounds.width / 2,
                expected: footer.x + footerElement.clientWidth / 2,
                background: getComputedStyle(element).backgroundColor,
              }
            })
            assert(
              Math.abs(geometry.center - geometry.expected) < 2,
              `Recording controls must be centered in the content pane: ${JSON.stringify(geometry)}`
            )
            assert(
              ['rgb(255, 255, 255)', 'oklch(1 0 0)'].includes(geometry.background),
              'Recording controls must use the white surface'
            )
            assert.equal(await target.getByRole('region', { name: 'Meeluisteren', exact: true }).count(), 0)
          }
          await assertControls()
          await target.screenshot({ path: join(runDirectory, 'recording-controls-live.png') })
          await target.locator('a[title="Tasks"]').click()
          await target.waitForURL('**/inbox/')
          await target.locator('#inbox-task-title').waitFor()
          await assertControls()
          await target.getByRole('button', { name: 'Opnameopties', exact: true }).click()
          assert.equal(await target.getByRole('menuitem', { name: /^(Opname stoppen|Stop recording)$/ }).count(), 0)
          assert.match(await target.getByRole('menu').locator('time').innerText(), /^\d+:\d{2}(?::\d{2})?$/)
          await target.screenshot({ path: join(runDirectory, 'recording-controls-overlay.png') })
          await target.getByRole('menuitem', { name: /^(Opname pauzeren|Pause recording)$/ }).click()
          await target.locator('button[aria-label="Stop recording"]:not(:disabled)').waitFor()
          assert((await target.evaluate(() => window.remember.getState())).manualMeeting?.pausedAt)
          await target.getByRole('button', { name: 'Stop recording', exact: true }).waitFor({ state: 'visible' })
          await target.getByRole('button', { name: 'Opnameopties', exact: true }).click()
          await target.getByRole('menuitem', { name: /^(Opname hervatten|Resume recording)$/ }).click()
          await target.getByRole('button', { name: 'Opnameopties', exact: true }).click()
          await target.getByRole('menuitem', { name: /^(Open gesprek|Open conversation)$/ }).click()
          await target.getByRole('textbox', { name: 'Gespreksnotities', exact: true }).waitFor()
          await target.setViewportSize({ width: 720, height: 800 })
          await assertControls()
          await target.screenshot({ path: join(runDirectory, 'recording-controls-narrow.png') })
          await target.setViewportSize({ width: 1220, height: 740 })
          checks.push(
            'Shared light recording controls stay centered on the live page, Tasks and narrow windows; menu has only time, pause/resume, open and discard, with one separate Stop'
          )
        }
        await delay(4_000)
        if (index === 0) {
          const levels = await target.evaluate(
            () => (Reflect.get(window, '__qaRecordingLevels') as { samples: RecordingAudioLevel[] }).samples
          )
          assert(
            levels.some((sample) => sample.source === 'microphone'),
            'Real microphone PCM must emit meter events'
          )
          assert(
            levels.some((sample) => sample.source === 'system' && sample.level > 0),
            'Real system tone must emit a nonzero meter event'
          )
          assert(
            levels.every(
              (sample) =>
                Number.isFinite(sample.level) && sample.level >= 0 && sample.level <= 1 && Number.isFinite(sample.at)
            ),
            'Native recording meter events must contain finite bounded numeric levels'
          )
          assert(stimulus && stimulus.exitCode === null, 'Owned system tone must still be running')
          const stopped = once(stimulus, 'exit')
          stimulus.kill('SIGTERM')
          await stopped
          const quietAt = Date.now()
          await delay(1_200)
          const quiet = await target.evaluate(
            (after) =>
              (Reflect.get(window, '__qaRecordingLevels') as { samples: RecordingAudioLevel[] }).samples.filter(
                (sample) => sample.source === 'system' && sample.at >= after
              ),
            quietAt + 200
          )
          assert(quiet.length >= 2, 'The real system meter must keep reporting after the stimulus stops')
          const summary = {
            sources: (['microphone', 'system'] as const).map((source) => {
              const samples = levels.filter((sample) => sample.source === source)
              return {
                source,
                count: samples.length,
                min: Math.min(...samples.map((sample) => sample.level)),
                max: Math.max(...samples.map((sample) => sample.level)),
              }
            }),
            systemAfterOwnedToneStopped: {
              count: quiet.length,
              min: Math.min(...quiet.map((sample) => sample.level)),
              max: Math.max(...quiet.map((sample) => sample.level)),
              zeroCount: quiet.filter((sample) => sample.level === 0).length,
            },
            microphoneSilenceAssumed: false,
          }
          writeJson('recording-audio-meter.json', summary)
          checks.push(
            'Actual microphone PCM and the physical system tone emit bounded numeric meter events through native IPC; no raw audio is included in meter payloads'
          )
          if (summary.systemAfterOwnedToneStopped.zeroCount > 0)
            checks.push(
              'The real system meter reaches zero after the owned tone stops while conversation capture remains active'
            )
          stimulus = spawn('/usr/bin/afplay', ['--volume', '0.3', tonePath], { stdio: 'ignore' })
        }
        // Do not give the autosave debounce time to persist this last edit.
        await target.getByRole('textbox', { name: 'Gespreksnotities', exact: true }).fill(notes)
        const stopAt = performance.now()
        await target.getByRole('button', { name: /^(Stop opname|Stop recording)$/, exact: true }).click()
        await target.waitForURL('**/conversations/conversation/**', { timeout: 10_000 })
        await target.getByText(notes, { exact: true }).waitFor()
        const elapsedMs = performance.now() - stopAt
        assert(elapsedMs < 5_000, `Stop must not wait for held transcription: ${elapsedMs}ms`)
        assert.equal(await target.evaluate(() => Reflect.get(window, '__qaRecordingDocument')), 'retained')
        assert.equal((await target.evaluate(() => window.remember.getState())).manualMeeting, null)
        assert.equal((await gate()).hold, true)
        const evidence = await checkpoint(`stop-boundary-${index + 1}`)
        const meeting = evidence.meetings.find((row) => row.id === activeMeeting.id)
        assert.equal(meeting?.notes, notes)
        assert(meeting && typeof meeting.episode_id === 'string')
        assert(
          evidence.audio.some((row) => Number(row.started_at) >= activeMeeting.startedAt),
          'Raw audio must be durable before Stop returns'
        )
        recordings.push({
          id: activeMeeting.id,
          episodeId: meeting.episode_id,
          dayId: state.activeSessionId,
          notes,
          elapsedMs,
        })
      }
      if (process.argv.includes('--discard-boundary')) {
        await target.locator('a[title="Conversations"]').click()
        await target.getByRole('button', { name: 'Start conversation', exact: true }).click()
        await target.getByRole('button', { name: /^(Stop opname|Stop recording)$/, exact: true }).waitFor()
        await target
          .locator(
            'button[aria-label="Stop recording"]:not(:disabled), button[aria-label="Stop opname"]:not(:disabled)'
          )
          .waitFor()
        const active = (await target.evaluate(() => window.remember.getState())).manualMeeting
        assert(active)
        await target
          .getByRole('textbox', { name: 'Gespreksnotities', exact: true })
          .fill('Disposable discard regression')
        await delay(3_000)
        await target.getByRole('button', { name: 'Opnameopties', exact: true }).click()
        const openAt = performance.now()
        await target.getByRole('menuitem', { name: 'Gesprek weggooien…', exact: true }).click()
        const dialog = target.getByRole('dialog', { name: 'Gesprek weggooien?', exact: true })
        await dialog.getByRole('heading').waitFor({ state: 'visible', timeout: 3_000 })
        const dialogMs = performance.now() - openAt
        await dialog.getByRole('button', { name: /^(Annuleren|Cancel)$/, exact: true }).click()
        await dialog.waitFor({ state: 'hidden' })
        assert.equal((await target.evaluate(() => window.remember.getState())).manualMeeting?.id, active.id)
        await target.getByRole('button', { name: 'Opnameopties', exact: true }).click()
        await target.getByRole('menuitem', { name: 'Gesprek weggooien…', exact: true }).click()
        const beforeDiscard = await checkpoint('discard-boundary-active')
        discardedRecording = {
          meetingId: active.id,
          momentIds: beforeDiscard.audio
            .filter((row) => Number(row.started_at) >= active.startedAt)
            .map((row) => String(row.id)),
        }
        assert(discardedRecording.momentIds.length > 0, 'Discard must include real retained audio')
        const discardAt = performance.now()
        await dialog.getByRole('button', { name: 'Weggooien', exact: true }).click()
        await target.waitForURL((url) => url.pathname === '/conversations/', { timeout: 5_000 })
        const discardMs = performance.now() - discardAt
        assert.equal((await target.evaluate(() => window.remember.getState())).manualMeeting, null)
        assert.equal((await gate()).hold, true, 'Discard must not wait for ASR')
        const discarded = await checkpoint('discard-boundary-immediate')
        assert(!discarded.meetings.some((row) => row.id === active.id))
        // A recognizer that was already running can resolve after the durable deletion.
        await ownedElectron.evaluate(
          (_electron, { dayId, chunkIds, startedAt }) => {
            const lateResult = {
              text: 'Deleted speech must not return',
              language: 'en',
              speechDurationMs: 1000,
              segments: [
                {
                  chunkId: chunkIds[0],
                  chunkIds,
                  startedAt,
                  endedAt: startedAt + 1000,
                  vadStartedAt: startedAt,
                  vadEndedAt: startedAt + 1000,
                  asrWindowIndex: 0,
                  asrWindowCount: 1,
                  transcriptionOutcome: 'transcribed',
                  text: 'Deleted speech must not return',
                  detectedLanguage: 'en',
                  acceptedLanguage: 'en',
                  rejectionReason: null,
                },
              ],
              resolvedChunkIds: chunkIds,
              promotedLanguages: ['en'],
              hasPendingSpeech: false,
            }
            Reflect.get(globalThis, 'qaPersistTranscriptionResult')(
              dayId,
              'microphone',
              lateResult,
              startedAt + 1000,
              0
            )
          },
          { dayId: active.workdayId, chunkIds: discardedRecording.momentIds, startedAt: active.startedAt }
        )
        writeJson('discard-boundary-timings.json', {
          meetingId: active.id,
          startedAt: active.startedAt,
          dialogMs,
          discardMs,
        })
        await target.screenshot({ path: join(runDirectory, 'discard-boundary-saved.png') })
        checks.push(
          'Discard dialog opens/cancels; confirmed discard returns to Conversations with ASR held and removes its meeting'
        )
      }
      assert((await gate()).entered > 0, 'ASR must actually reach the held boundary')
      assert.notEqual(recordings[0].episodeId, recordings[1].episodeId)
      const sounds = []
      for (const recording of recordings) {
        const sound = await playback(target, recording.dayId, recording.episodeId)
        assert.equal((await gate()).hold, true, 'Playback must not wait for local transcription')
        assert(
          sound.duration > 1 && sound.duration < 15,
          'Each assembled file must contain only its own short recording'
        )
        sounds.push(sound)
      }
      await electron.evaluate(() =>
        (globalThis as unknown as { qaStopBoundary: { release: () => void } }).qaStopBoundary.release()
      )
      const archive = new DatabaseSync(join(profile, 'daily-review/evidence.sqlite'), { readOnly: true })
      try {
        const pending = archive.prepare("SELECT count(*) AS n FROM audio_evidence WHERE status = 'transcribing'")
        const deadline = Date.now() + 30_000
        while (Number(pending.get()?.n) > 0 && Date.now() < deadline) await delay(50)
        assert.equal(pending.get()?.n, 0, 'Released transcription must settle before the restart identity comparison')
      } finally {
        archive.close()
      }
      const before = await checkpoint('stop-boundary-prepared')
      if (discardedRecording) {
        assert(!before.meetings.some((row) => row.id === discardedRecording.meetingId))
        assert(!before.audio.some((row) => discardedRecording.momentIds.includes(String(row.id))))
        const database = new DatabaseSync(join(profile, 'daily-review/evidence.sqlite'), { readOnly: true })
        try {
          const chunkIds = discardedRecording.momentIds
          const segments = database.prepare('SELECT chunk_id, chunk_ids_json FROM speech_segment').all()
          assert(
            !segments.some(
              (row) =>
                chunkIds.includes(String(row.chunk_id)) ||
                JSON.parse(String(row.chunk_ids_json ?? '[]')).some((id: string) => chunkIds.includes(id))
            ),
            'Late ASR must not restore discarded speech'
          )
        } finally {
          database.close()
        }
      }
      for (const recording of recordings) {
        const meeting = before.meetings.find((row) => row.id === recording.id)
        assert(meeting)
        const prefix = `${meeting.started_at}-${meeting.ended_at}-`
        const wav = before.wavs.find((file) => basename(file.path).startsWith(prefix))
        assert(wav, 'Each recording must have its own assembled WAV')
        const manifest = readConversationAudioManifestAt(join(profile, 'daily-review', wav.path))
        assert(manifest)
        for (const range of manifest.ranges) {
          assert(range.sourceStartedAt >= Number(meeting.started_at), 'Audio must not include the previous recording')
          assert(range.sourceEndedAt <= Number(meeting.ended_at), 'Audio must not include the next recording')
        }
        assert(wav.durationMs <= Number(meeting.ended_at) - Number(meeting.started_at) + 1)
      }
      await closeElectron()
      const restarted = await launch()
      for (const [index, recording] of recordings.entries()) {
        assert.deepEqual(await playback(restarted, recording.dayId, recording.episodeId), sounds[index])
      }
      const after = await checkpoint('stop-boundary-restarted')
      assert.deepEqual(after.audio, before.audio)
      assert.deepEqual(after.wavs, before.wavs)
      writeJson('stop-boundary-timings.json', recordings)
      checks.push(
        'Two real recordings stop and play with durable final notes while ASR is held; immediate next recording, pause/resume, exact audio windows and WAV identity survive restart'
      )
      return
    } finally {
      if (electron)
        await electron.evaluate(() =>
          (globalThis as unknown as { qaStopBoundary: { release: () => void } }).qaStopBoundary.release()
        )
    }
  }
  if (process.argv.includes('--update-quit')) {
    assert(electron)
    report.scope =
      'Real microphone capture and active meeting shutdown through a simulated installer handoff; no update is installed'
    await target.evaluate(() => window.remember.startManualMeeting())
    await target.evaluate(() => window.rememberDictation?.toggle())
    const deadline = Date.now() + 10_000
    while (!(await electron.evaluate(() => globalThis.qaSharedMicrophone.snapshot())).capture?.running) {
      assert(Date.now() < deadline, 'Microphone must be active before update shutdown')
      await delay(50)
    }
    writeJson(
      'update-quit-active-capture.json',
      await electron.evaluate(() => globalThis.qaSharedMicrophone.snapshot())
    )
    checks.push('Update requested with an active physical microphone and an unfinished manual meeting')
    const renderers = await ownedMicrophoneRenderers(electron)
    await closeElectron()
    for (const { pid } of renderers) {
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    }
    checks.push('Owned microphone renderers terminate after update shutdown')
    return
  }
  if (process.argv.includes('--cold-starts')) {
    assert(electron)
    report.scope =
      'Five new physical microphone streams with background capture off in the isolated app; other apps and hardware ownership remain unchanged'
    await sharedMicrophoneColdQa({ target, electron, runDirectory, checks })

    return
  }
  if (process.argv.includes('--background-conversation')) {
    await target.evaluate(() =>
      window.remember.updateSettings({ audioCaptureEnabled: true, capturePaused: false, capturePauseSources: [] })
    )
    try {
      await delay(12_000, undefined, { signal: abort.signal })
      await target.getByRole('link', { name: 'Conversations', exact: true }).click()
      await target.getByRole('button', { name: 'Start conversation', exact: true }).click()
      await target.getByRole('button', { name: /^(Stop opname|Stop recording)$/, exact: true }).waitFor()
      await target
        .locator('button[aria-label="Stop recording"]:not(:disabled), button[aria-label="Stop opname"]:not(:disabled)')
        .waitFor()
      const active = await target.evaluate(() => window.remember.getState())
      assert.equal(active.manualMeeting?.status, 'recording')
      await delay(4_500, undefined, { signal: abort.signal })
      await target.getByRole('button', { name: /^(Stop opname|Stop recording)$/, exact: true }).click()
      const deadline = Date.now() + 60_000
      while ((await target.evaluate(() => window.remember.getState())).manualMeeting != null) {
        assert(Date.now() < deadline, 'Explicit conversation must finish while background capture is enabled')
        await delay(100, undefined, { signal: abort.signal })
      }
      const stoppedAt = Date.now()
      await delay(12_000, undefined, { signal: abort.signal })
      const background = await checkpoint('audio-background-after-conversation')
      assert(
        background.audio.some((row) => row.source === 'system' && Number(row.started_at) >= stoppedAt - 1_000),
        'Background capture must retain fresh system audio after the explicit conversation ends'
      )
      const state = await target.evaluate(() => window.remember.getState())
      assert.equal(state.manualMeeting, null)
      assert.equal(state.status, 'recording')
      checks.push(
        'The same Start conversation UI works with background capture enabled; stopping the conversation restores background audio without another start'
      )
    } finally {
      await target.evaluate(() => window.remember.updateSettings({ audioCaptureEnabled: false }))
    }
    return
  }
  const spaceRecording = process.argv.includes('--living-spaces')
    ? await startSpaceRecordingQa({ target, runDirectory, checks })
    : null
  if (!spaceRecording) {
    await target.getByRole('link', { name: 'Conversations', exact: true }).click()
    await target.evaluate(() => Reflect.set(window, '__qaRecordingDocument', 'retained'))
    const startRequestedAt = performance.now()
    await target.getByRole('button', { name: 'Start conversation', exact: true }).click()
    await target.getByRole('button', { name: /^(Stop opname|Stop recording)$/, exact: true }).waitFor()
    await target
      .locator('button[aria-label="Stop recording"]:not(:disabled), button[aria-label="Stop opname"]:not(:disabled)')
      .waitFor()
    assert.equal(
      await target.evaluate(() => Reflect.get(window, '__qaRecordingDocument')),
      'retained',
      'Starting a conversation must preserve the renderer document and global application state'
    )
    writeJson('recording-navigation.json', {
      startToControlsMs: performance.now() - startRequestedAt,
      documentRetained: true,
    })
    checks.push('Start conversation preserves the same renderer document instead of reloading the application')
  }
  const started = spaceRecording?.started ?? (await target.evaluate(() => window.remember.getState()))
  if (spaceRecording) {
    report.scope =
      'Real Space UI recording, native microphone and system audio, pause/resume, playback, discard and restart'
  }
  writeJson('audio-start.json', started)
  assert(
    started.manualMeeting?.status === 'recording',
    `Native recording did not start: ${started.error ?? started.status}`
  )
  const meetingId = started.manualMeeting.id
  if (!spaceRecording) {
    assert(!started.manualMeeting.title.includes('·'), 'New recording titles must use a readable date and time')
    await target
      .getByRole('textbox', { name: 'Gespreksnotities', exact: true })
      .fill('Native recording flow verification.')
    await target.screenshot({ path: join(runDirectory, 'recording-active.png') })
  }
  assert(electron)
  // Wait for real samples, since startManualMeeting may return during input acquisition.
  for (let attempt = 0; ; attempt++) {
    const capture = await target.evaluate(() => window.remember.getState())
    if (capture.microphoneName) break
    assert(attempt < 100, 'Microphone must become ready before recovery QA')
    await delay(100, undefined, { signal: abort.signal })
  }
  await sharedMicrophoneRecoveryQa({ target, electron, runDirectory, checks })
  let dictationIntervals: Array<{ startedAt: number; endedAt: number }> = []
  console.log('Recording system output across 65 seconds and shared dictation lifecycle checks with a quiet test tone.')
  for (let sample = 0; sample < 13; sample += 1) {
    await delay(5_000, undefined, { signal: abort.signal })
    if (sample === 3) {
      assert(electron)
      dictationIntervals = await sharedMicrophoneQa({ target, electron, runDirectory, checks })
    }
    writeJson(`audio-state-${sample}.json`, await target.evaluate(() => window.remember.getState()))
  }
  if (spaceRecording) await stopSpaceRecordingQa({ target, runDirectory, checks, recording: spaceRecording })
  else {
    const stopRequestedAt = performance.now()
    await target.getByRole('button', { name: /^(Stop opname|Stop recording)$/, exact: true }).click()
    const stopDeadline = Date.now() + 60_000
    while ((await target.evaluate(() => window.remember.getState())).manualMeeting != null) {
      assert(Date.now() < stopDeadline, 'Stopping must close native inputs within 60 seconds')
      await delay(100, undefined, { signal: abort.signal })
    }
    await target.waitForURL('**/conversations/conversation/**', { timeout: 15_000 })
    await target.getByText('Native recording flow verification.', { exact: true }).waitFor()
    assert.equal(
      await target.evaluate(() => Reflect.get(window, '__qaRecordingDocument')),
      'retained',
      'Stopping must preserve the renderer document through the saved conversation'
    )
    writeJson('recording-stop-navigation.json', {
      stopToConversationMs: performance.now() - stopRequestedAt,
      documentRetained: true,
      notesRetained: true,
    })
    checks.push('Stop opens the saved conversation without a document reload and retains the final typed notes')
  }
  assert(electron)
  await verifySharedMicrophoneIdle(electron, runDirectory, checks)
  stimulus.kill('SIGTERM')
  const before = await checkpoint('audio-stopped')
  const meeting = before.meetings.find((meeting) => meeting.id === meetingId)
  assert(meeting?.episode_id && typeof meeting.episode_id === 'string', 'Recording must persist a conversation episode')
  const audioRows = before.audio.filter((row) => row.workday_id === started.activeSessionId)
  const microphoneRows = audioRows.filter((row) => row.source === 'microphone')
  assert(microphoneRows.length > 0, 'Conversation microphone PCM must be persisted')
  for (const interval of dictationIntervals) {
    for (const row of microphoneRows) {
      const start = Number(row.started_at)
      const end = start + Number(row.duration_ms)
      const overlap = Math.min(end, interval.endedAt) - Math.max(start, interval.startedAt)
      // Both endpoints now use the AudioWorklet sample clock, not command time.
      // Persisted millisecond timestamps may round by at most one millisecond.
      assert(overlap <= 1, `Voice note audio leaked into conversation capture for ${overlap} ms`)
    }
  }
  writeJson('dictation-conversation-exclusion.json', { dictationIntervals, microphoneRows })
  checks.push(
    'Persisted conversation microphone ranges exclude Voice note intervals while system capture crosses the 60-second boundary'
  )
  const inputs = Object.fromEntries(
    ['system'].map((source) => {
      const chunks = audioRows.filter((row) => row.source === source)
      const durationMs = chunks.reduce((sum, row) => sum + Number(row.duration_ms), 0)
      const failedChunks = chunks.filter((row) => row.status === 'failed' || row.capture_outcome === 'failed').length
      const signalDetected = chunks.some((row) => Number(row.average_level) > 0.0001)
      const passed = durationMs >= 60_000 && failedChunks === 0 && signalDetected
      if (passed) checks.push(`${source}: ${durationMs}ms persisted across the 60-second transport boundary`)
      return [source, { durationMs, chunkCount: chunks.length, failedChunks, signalDetected, passed }]
    })
  )
  report.nativeInputs = inputs
  const sound = await playback(target, started.activeSessionId as string, meeting.episode_id)
  assert(sound.duration >= 60, 'Assembled native audio must cross the 60-second boundary')
  const prepared = await checkpoint('audio-prepared')
  const ownedRenderers = await ownedMicrophoneRenderers(electron)
  await closeElectron()
  for (const renderer of ownedRenderers) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const status = spawnSync('/bin/ps', ['-p', String(renderer.pid), '-o', 'stat='], { encoding: 'utf8' })
      if (status.status !== 0 || status.stdout.trim().startsWith('Z')) break
      assert(attempt < 49, `Owned microphone renderer ${renderer.pid} outlived the QA app`)
      await delay(20)
    }
  }
  checks.push('Closing the isolated Electron app terminates every microphone renderer it owned')
  const restarted = await launch()
  assert.deepEqual(await playback(restarted, started.activeSessionId as string, meeting.episode_id), sound)
  const after = await checkpoint('audio-restarted')
  assert.deepEqual(after.audio, prepared.audio)
  assert.deepEqual(after.wavs, prepared.wavs)
  checks.push('Native audio rows and WAV hashes survived restart; assembled recording played in Electron')
  if (!spaceRecording) {
    await restarted.getByRole('link', { name: 'Conversations', exact: true }).click()
    const recordingLink = restarted
      .getByRole('main')
      .locator(`a[href*="conversation=${encodeURIComponent(`episode:${meeting.episode_id}`)}"]`)
    await recordingLink.click()
    await restarted.waitForURL((url) => url.pathname === '/conversations/conversation/')
    await restarted.screenshot({ path: join(runDirectory, 'conversation-found-after-restart.png') })
    checks.push(
      'Conversations navigation, Start conversation and Stop recording work through the UI; the same retained recording is found and opened after restart'
    )
  }
  if (spaceRecording) {
    await reopenSpaceRecordingQa({ target: restarted, runDirectory, checks, recording: spaceRecording })
    await shortSpaceSpeech(restarted, spaceRecording)
  }
  const missing = Object.entries(inputs)
    .filter(([, value]) => !value.passed)
    .map(([source]) => source)
  assert.equal(
    missing.length,
    0,
    `Native input checks failed: ${missing.join(', ')}. See nativeInputs and audio-state files.`
  )
}

async function shortSpaceSpeech(target: Page, space: { spaceId: string; spaceName: string }) {
  const speechPath = join(runDirectory, 'space-speech.aiff')
  const speechText =
    'Dit is een korte opname voor Remember. De paarse fiets staat naast de bakker. Morgen bespreken we de planning en bewaren we dit gesprek in onze ruimte.'
  command('/usr/bin/say', ['-v', 'Xander', '-r', '170', '-o', speechPath, speechText])
  report.speechStimulus = { text: speechText, source: 'macOS Xander through real system output; no transcript fixture' }

  // Keep the recording wholly inside one minute: the old detail filter lost this transcript.
  const second = new Date().getSeconds()
  if (second > 20) await delay((60 - second) * 1_000, undefined, { signal: abort.signal })
  const recording = await startSpaceRecordingQa({ target, runDirectory, checks, space })
  stimulus = spawn('/usr/bin/afplay', ['--volume', '0.5', speechPath], { stdio: 'ignore' })
  const [code] = await once(stimulus, 'exit')
  assert.equal(code, 0, 'The known speech must play through the real system output')
  await delay(1_500, undefined, { signal: abort.signal })
  await stopSpaceRecordingQa({ target, runDirectory, checks, recording, pauseResume: false })
  const evidence = await checkpoint('space-short-speech')
  const meeting = evidence.meetings.find((item) => item.id === recording.meetingId)
  assert(meeting?.episode_id && typeof meeting.episode_id === 'string')
  assert.equal(
    Math.floor(Number(meeting.started_at) / 60_000),
    Math.floor(Number(meeting.ended_at) / 60_000),
    'The short recording must exercise the same-minute transcript regression'
  )
  const expectedTranscriptText = /paarse fiets/i
  const spokenSource = await reopenSpaceRecordingQa({
    target,
    runDirectory,
    checks,
    recording,
    expectedTranscriptText,
    phase: 'before-restart',
  })
  assert(
    spokenSource.conversation.recordingSource?.segments.some(
      (segment) => segment.source === 'system' && expectedTranscriptText.test(segment.text)
    ),
    'The known speech must be transcribed from native system audio, not only microphone loopback'
  )
  const sound = await playback(target, recording.started.activeSessionId as string, meeting.episode_id)
  assert(sound.duration > 5 && sound.duration < 60, 'Known short speech must have playable retained audio')
  await closeElectron()
  const restarted = await launch()
  await reopenSpaceRecordingQa({ target: restarted, runDirectory, checks, recording, expectedTranscriptText })
  assert.deepEqual(await playback(restarted, recording.started.activeSessionId as string, meeting.episode_id), sound)
  checks.push(
    'Known speech in a same-minute Space recording is transcribed locally, visible and playable before and after restart'
  )
  await discardSpaceRecordingQa({ target: restarted, runDirectory, checks, ...space })
  assert(electron)
  await verifySharedMicrophoneIdle(electron, runDirectory, checks, 'space-discard-plain-idle')
  await discardSpaceRecordingQa({
    target: restarted,
    runDirectory,
    checks,
    ...space,
    ownNotes: 'Keep this human note after discarding the test recording.',
  })
  await verifySharedMicrophoneIdle(electron, runDirectory, checks, 'space-discard-notes-idle')
  await reopenSpaceRecordingQa({
    target: restarted,
    runDirectory,
    checks,
    recording,
    expectedTranscriptText,
    phase: 'after-discard',
  })
  assert.deepEqual(await playback(restarted, recording.started.activeSessionId as string, meeting.episode_id), sound)
  assert.doesNotMatch(
    readFileSync(join(runDirectory, 'main.log'), 'utf8'),
    /ENOENT:[^\n]*temporary-capture/,
    'Discard must not remove a temporary capture file still owned by an audio or context writer'
  )
  checks.push('Both discard paths leave the microphone idle and preserve the earlier recording audio and transcript')
  assert.deepEqual(rendererErrors, [], 'Unexpected renderer exceptions in Space recording flow')
}

async function errorReportingSettingsQa() {
  let target = await launch()
  const reportingName = 'Technical error reports'
  const readPreference = () => target.evaluate(() => window.remember.getSettings())
  const verify = async (enabled: boolean, offlineMode: boolean) => {
    await target.waitForFunction(
      async ({ enabled, offlineMode }) => {
        const settings = await window.remember.getSettings()
        return settings.errorReportingEnabled === enabled && settings.offlineMode === offlineMode
      },
      { enabled, offlineMode }
    )
    const toggle = target.getByRole('switch', {
      name: reportingName,
      exact: true,
      checked: enabled,
      disabled: offlineMode,
    })
    await toggle.waitFor({ state: 'visible' })
    assert.equal(await toggle.isDisabled(), offlineMode)
    const persisted = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'))
    assert.equal(persisted.errorReportingEnabled, enabled)
    assert.equal(persisted.offlineMode, offlineMode)
  }
  await target.goto(`${webUrl}/settings/`)
  await verify(true, true)
  await target.getByRole('switch', { name: 'Offline mode', exact: true }).click()
  await verify(true, false)
  await target.getByRole('switch', { name: reportingName, exact: true }).click()
  await verify(false, false)
  await target.screenshot({ path: join(runDirectory, 'error-reporting-disabled.png') })
  checks.push('Native Settings switch saves disabled reporting through IPC and to settings.json')

  await target.getByRole('switch', { name: reportingName, exact: true }).click()
  await verify(true, false)
  checks.push('Reporting preference can be enabled again in the same native session')
  await target.getByRole('switch', { name: 'Offline mode', exact: true }).click()
  await verify(true, true)
  await target.getByText('Paused while Offline mode is on.', { exact: true }).first().waitFor()
  await target.screenshot({ path: join(runDirectory, 'error-reporting-offline.png') })
  await target.getByRole('switch', { name: 'Offline mode', exact: true }).click()
  await verify(true, false)
  checks.push('Offline mode disables the reporting control while retaining its saved preference')

  await target.getByRole('switch', { name: reportingName, exact: true }).click()
  await verify(false, false)
  const beforeRestart = await readPreference()
  await closeElectron()
  target = await launch()
  await target.goto(`${webUrl}/settings/`)
  await verify(false, false)
  assert.equal((await readPreference()).cloudAnalysisConsent, false)
  await target.screenshot({ path: join(runDirectory, 'error-reporting-restarted.png') })
  writeJson('error-reporting-proof.json', {
    boundary:
      'Real Electron Settings UI, IPC and restart persistence; development Sentry disabled, no event delivery tested.',
    beforeRestart: { enabled: beforeRestart.errorReportingEnabled, offlineMode: beforeRestart.offlineMode },
    afterRestart: { enabled: (await readPreference()).errorReportingEnabled, offlineMode: false },
  })
  checks.push('Disabled reporting preference survives a complete Electron restart and renders correctly')
  assert.deepEqual(rendererErrors, [], 'Unexpected renderer exceptions in error reporting Settings')
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log(
      'pnpm qa:electron [smoke|widget|audio|dictation|learning|recovery-reset --models /absolute/models]\nEach run builds current code, owns its processes, and writes .qa/runs/<timestamp>/report.json.\nwidget checks docking and restart persistence; --menu checks its context menu. smoke uses seeded evidence. audio captures real inputs across 65 seconds. dictation uses --dictation-wav /absolute/16khz.wav; add --shared-capture for the shared stream. learning uses isolated agent records and deterministic inference.'
    )
    return
  }
  assert.equal(process.platform, 'darwin', 'Native QA currently requires macOS')
  assert(
    ['smoke', 'widget', 'audio', 'learning', 'recovery-reset', 'dictation'].includes(mode),
    `Unknown QA scenario: ${mode}`
  )
  assert(!runtimeOverride || isAbsolute(runtimeOverride), 'REMEMBER_QA_RUNTIME_DIR must be an absolute QA directory')
  if (shortSocketProfile) {
    const socketBytes = Buffer.byteLength(join(profile, 'daily-review', 'remember-agent.sock')) + 1
    assert(
      socketBytes <= 104,
      `QA agent socket needs ${socketBytes} bytes; macOS allows 104. Set REMEMBER_QA_RUNTIME_DIR to a shorter owned directory.`
    )
  }
  mkdirSync(runDirectory, { recursive: true, mode: 0o700 })
  const acquiredLocks: string[] = []
  try {
    for (const lock of locks) {
      mkdirSync(dirname(lock), { recursive: true, mode: 0o700 })
      try {
        mkdirSync(lock)
      } catch {
        throw new Error(`Another QA run owns ${lock}. Inspect owner.json and its PID before removing a stale lock.`)
      }
      acquiredLocks.push(lock)
      writeFileSync(
        join(lock, 'owner.json'),
        JSON.stringify({ pid: process.pid, runId, runDirectory, sourceCheckout: root })
      )
    }
  } catch (error) {
    for (const lock of acquiredLocks.reverse()) rmSync(lock, { recursive: true })
    throw error
  }
  const interruption = () => {
    abort.abort(new Error('QA interrupted'))
    electron?.process().kill('SIGTERM')
  }
  process.once('SIGINT', interruption)
  process.once('SIGTERM', interruption)
  const deadline = setTimeout(
    interruption,
    mode === 'dictation' ||
      process.argv.includes('--live') ||
      process.argv.includes('--agent-retrieval') ||
      (mode === 'audio' && (process.argv.includes('--living-spaces') || process.argv.includes('--stop-boundary'))) ||
      proactiveBriefingMini
      ? 600_000
      : 240_000
  )
  deadline.unref()
  try {
    console.log(`QA ${mode}: ${runDirectory}`)
    report.git = command('git', ['rev-parse', 'HEAD'], root)
    report.dirty = command('git', ['status', '--porcelain'], root)
    report.sourceCheckout = desktop
    report.syntheticCapture = mode === 'dictation'
    if (mode === 'dictation') {
      report.nativeInsertion =
        !process.argv.includes('--skip-insertion') &&
        !process.argv.includes('--hud') &&
        !process.argv.includes('--shared-capture')
      if (process.argv.includes('--hud')) report.scope = 'dictation HUD with idle widget hidden'
      if (process.argv.includes('--shared-capture'))
        report.scope =
          'Shared Chromium microphone stream and AudioWorklet with Dutch fixture, first-word retention, real ASR, history, restart and idle capture'
    }
    if (mode === 'dictation') {
      const wavIndex = process.argv.indexOf('--dictation-wav')
      assert(
        wavIndex >= 0 && process.argv[wavIndex + 1]?.startsWith('/') && existsSync(process.argv[wavIndex + 1]),
        'dictation requires --dictation-wav /absolute/dutch-planning-fixture.wav'
      )
      assert.equal(
        readPcmWavInfo(process.argv[wavIndex + 1]).sampleRate,
        16_000,
        'Dictation fixture must be 16 kHz mono PCM16 for the direct shared-ASR checks'
      )
      report.inference =
        'Real Parakeet with supplied Dutch planning fixture through Chromium fake microphone. OS microphone consent bypassed only in owned source snapshot.'
    }
    const hostTask = process.argv.includes('--host-task') || sharedAgent
    if (process.argv.includes('--agent-documents-ui'))
      assert.deepEqual(
        [...process.argv.slice(2)].sort(),
        ['--agent-documents-ui', 'smoke'],
        'Documents UI is an isolated fixture-only scenario'
      )
    if (proactiveNotes)
      assert.deepEqual(
        [...process.argv.slice(2)].sort(),
        ['--proactive-notes', 'smoke'],
        'Notes is a silent isolated scenario only'
      )
    const proactiveAgent = process.argv.includes('--proactive-agent')
    assert(!process.argv.includes('--day-sync') || proactiveAgent, '--day-sync requires --proactive-agent')
    assert(!process.argv.includes('--day-review') || proactiveAgent, '--day-review requires --proactive-agent')
    if (process.argv.includes('--day-review'))
      assert(!process.argv.includes('--day-sync'), '--day-review and --day-sync are separate scenarios')
    if (proactiveAgent) {
      assert.deepEqual(
        [...process.argv.slice(2)].sort(),
        [
          '--proactive-agent',
          'smoke',
          ...(process.argv.includes('--live') ? ['--live'] : []),
          ...(process.argv.includes('--day-sync') ? ['--day-sync'] : []),
          ...(process.argv.includes('--day-review') ? ['--day-review'] : []),
        ].sort(),
        '--proactive-agent accepts optional --live/--day-sync or --day-review; competing fixture flags are forbidden'
      )
    }
    if (proactiveBriefing || proactiveBriefingFollowup) {
      assert.deepEqual(
        [...process.argv.slice(2)].sort(),
        [proactiveBriefingFollowup ? '--proactive-briefing-followup' : '--proactive-briefing', 'smoke'],
        '--proactive-briefing is a silent fixture-only native scenario'
      )
      proactiveBriefingSetup = await setupProactiveBriefingQa(runDirectory)
      process.env.REMEMBER_QA_BRIEFING_MANIFEST = proactiveBriefingSetup.manifestPath
    }
    if (proactiveBriefingMini) {
      assert.deepEqual(
        [...process.argv.slice(2)].sort(),
        ['--proactive-briefing-mini', 'smoke'],
        '--proactive-briefing-mini requires exactly two separately provisioned owned Mini hosts'
      )
      const setup = await setupProactiveBriefingMiniQa(runDirectory)
      process.env.REMEMBER_QA_BRIEFING_MANIFEST = setup.manifestPath
    }
    if (sharedAgent) {
      assert.deepEqual(
        [...process.argv.slice(2)].sort(),
        ['--shared-agent', 'smoke'],
        '--shared-agent is a silent fixture-only smoke scenario'
      )
      sharedAgentSetup = await setupSharedAgentQa(runDirectory)
      process.env.REMEMBER_QA_HOST_TASK_MANIFEST = sharedAgentSetup.manifestPath
    }
    if (hostTask && !sharedAgent) {
      assert.deepEqual(
        [...process.argv.slice(2)].sort(),
        ['--host-task', '--live', 'smoke'],
        '--host-task accepts only smoke --host-task --live; competing fixture flags are forbidden'
      )
      readHostTaskQaManifest()
    }
    report.evidenceSource = hostTask
      ? 'Silent isolated profile; own synthetic manual Tasks and Personal page, no audio fixture'
      : mode === 'audio'
        ? 'seeded fixture plus live native inputs'
        : 'seeded fixture'
    snapshotDesktop()
    if (hostTask) {
      assert.equal(mode, 'smoke', '--host-task requires smoke mode')
      assert(sharedAgent || process.argv.includes('--live'), '--host-task requires --live')
      seedHostTaskProfile(profile)
    }
    if (proactiveBriefing || proactiveBriefingFollowup) seedProactiveBriefingProfile(profile)
    if (proactiveBriefingMini) seedProactiveBriefingMiniProfile(profile)
    if (proactiveNotes) seedProactiveNotesProfile(profile)
    const fixture = hostTask || anyProactiveBriefing || proactiveNotes ? null : seedProfile(profile)
    if (process.argv.includes('--error-reporting')) {
      assert.deepEqual([...process.argv.slice(2)].sort(), ['--error-reporting', 'smoke'])
      const settingsFile = join(profile, 'settings.json')
      const settings = JSON.parse(readFileSync(settingsFile, 'utf8'))
      writeFileSync(
        settingsFile,
        JSON.stringify({
          ...settings,
          errorReportingEnabled: true,
          cloudAnalysisConsent: false,
          audioCaptureEnabled: false,
        })
      )
    }
    const audioProcessingRecovery = process.argv.includes('--audio-processing-recovery')
      ? seedAudioProcessingRecovery(profile)
      : null
    if (audioProcessingRecovery) assert.equal(mode, 'smoke', '--audio-processing-recovery requires smoke mode')
    if (process.argv.includes('--startup-travel')) {
      assert.equal(mode, 'smoke', '--startup-travel requires smoke mode')
      seedStartupTravel(profile)
    }
    const modelIndex = process.argv.indexOf('--models')
    const models =
      modelIndex >= 0
        ? process.argv[modelIndex + 1]
        : join(process.env.HOME ?? '', 'Library/Application Support/Remember/models')
    if (mode === 'recovery-reset') {
      // Reset needs a deletable model directory, not inference assets or a download.
      mkdirSync(join(profile, 'models'), { recursive: true })
      writeFileSync(join(profile, 'models', 'qa-reset-marker'), 'Disposable reset fixture\n')
    } else {
      assert(
        models?.startsWith('/') && existsSync(models),
        'QA needs local model assets to complete real onboarding. Supply --models /absolute/path/to/models; no model downloads or permission changes are automatic.'
      )
      for (const file of [
        'encoder.int8.onnx',
        'decoder.int8.onnx',
        'joiner.int8.onnx',
        'tokens.txt',
        'silero-vad.onnx',
      ]) {
        assert(existsSync(join(models, 'parakeet-tdt-0.6b-v3-int8', file)), `Missing model asset: ${file}`)
      }
      report.models = models
      command('/bin/cp', ['-cR', models, join(profile, 'models')])
    }
    report.phase = 'building'
    writeJson('report.json', report)
    console.log('Building native helpers and Electron main/preload…')
    command('pnpm', ['native:build'])
    // Resolve from the checkout: pnpm's relative bin shims break through the snapshot's node_modules symlink.
    const require = createRequire(join(desktop, 'package.json'))
    const electronVite = join(dirname(require.resolve('electron-vite/package.json')), 'bin/electron-vite.js')
    command(process.execPath, [electronVite, 'build', '--ignoreConfigWarning'])
    command(process.execPath, ['scripts/verify-main-bundle.cjs'])
    report.phase = 'starting renderer'
    writeJson('report.json', report)
    await startRenderer()
    report.phase = 'running scenario'
    writeJson('report.json', report)
    if (mode === 'smoke' && process.argv.includes('--error-reporting')) {
      report.scope = 'Native error reporting preference, Offline mode and restart persistence; Sentry delivery disabled'
      await errorReportingSettingsQa()
    } else if (mode === 'smoke' && process.argv.includes('--context-loading')) {
      assert(fixture)
      await contextLoadingQa(fixture)
    } else if (mode === 'smoke' && proactiveNotes) {
      report.scope = 'Native saved Note to initiative, ordinary follow-up, exact source, deletion and restart'
      report.evidenceSource =
        'Live canonical synthetic transcript completion, real history and stores; capture paused/audio off'
      report.inference = 'Deterministic local CLI only; no model, ASR, Mini or cloud'
      await proactiveNotesQa({
        directory: runDirectory,
        desktopDirectory,
        launch,
        close: closeElectron,
        getElectron: () => electron,
        checks,
      })
    } else if (mode === 'smoke' && proactiveBriefingMini) {
      report.scope = 'Isolated native private briefing through two owned Mini hosts, exact Stop and restart'
      report.evidenceSource =
        'Frozen synthetic BP01 and B control sources; disposable Personal page; no physical capture'
      report.inference =
        'At most two real observer calls and two tools-disabled Mini synthesis calls; no ordinary chat call'
      report.independentMiniReadback = 'Required separately before an end-to-end pass claim'
      await proactiveBriefingMiniQa({
        directory: runDirectory,
        desktopDirectory,
        launch,
        close: closeElectron,
        getElectron: () => electron,
        checks,
      })
    } else if (mode === 'smoke' && proactiveBriefingFollowup) {
      report.scope = 'Native same-chat briefing follow-up, source revocation and restart in an isolated profile'
      report.evidenceSource = 'Saved synthetic briefing and original sources; no physical capture'
      report.inference =
        'Actual tools-disabled SDK and local host with deterministic fixture CLI; no model or Mini call'
      await proactiveBriefingFollowupQa({
        directory: runDirectory,
        desktopDirectory,
        launch,
        close: closeElectron,
        getElectron: () => electron,
        checks,
      })
    } else if (mode === 'smoke' && proactiveBriefing) {
      report.scope = 'Native proactive private briefing, exact Stop and restart in an isolated profile'
      report.evidenceSource = 'Two fixed synthetic context sources and disposable Personal page; no physical capture'
      report.inference = 'Actual SDK and local briefing hosts with deterministic fixture CLI; no model or Mini call'
      await proactiveBriefingQa({
        directory: runDirectory,
        desktopDirectory,
        launch,
        close: closeElectron,
        getElectron: () => electron,
        checks,
      })
    } else if (mode === 'smoke' && sharedAgent) {
      report.scope = 'Shared native Agentchat and explicit Task actions with separate controls and restart'
      report.evidenceSource =
        'Synthetic Tasks/Personal data, two actual local coordinators with fake providers, fixture tools-disabled chat; no physical capture'
      report.inference = 'Deterministic fixture outputs only; no model or Mini call'
      await sharedAgentQa({
        directory: runDirectory,
        launch,
        close: closeElectron,
        getElectron: () => electron,
        checks,
      })
    } else if (mode === 'smoke' && hostTask) {
      report.scope =
        'Native explicit Task-to-agent A/B with real Mini tools and reviewed Personal save; silent isolated profile'
      report.evidenceSource =
        'Own synthetic manual Tasks and Personal page; actual native IPC and two preprovisioned Mini coordinators'
      await residentHostTaskQa({
        directory: runDirectory,
        launch,
        close: closeElectron,
        getElectron: () => electron,
        checks,
      })
    } else if (mode === 'smoke' && proactiveAgent) {
      const dayReview = process.argv.includes('--day-review')
      const daySync = process.argv.includes('--day-sync') || dayReview
      const live = process.argv.includes('--live')
      report.scope = dayReview
        ? `Native scheduled Task review, ${live ? 'simulated elapsed-time help' : 'unchanged-state assessment'}, cooldown, ${live ? '' : 'user preemption, '}completion and full restart`
        : daySync
          ? 'Native task-free conversational offers, ordinary acceptance and refusal, repeat silence and full restart'
          : 'Native proactive source-to-chat, source details, dismissal and restart in an isolated profile'
      report.evidenceSource = daySync
        ? dayReview
          ? 'Synthetic Day summarizer in private snapshot, real manual Task and refresh IPC; capture paused and audio off'
          : 'Explicitly synthetic film-evening context and Day summaries in private snapshot, real refresh IPC and zero Tasks; capture paused and audio off'
        : 'Synthetic AX helper, no physical screen or audio capture; existing seeded historical evidence'
      report.inference = live
        ? dayReview
          ? 'Actual tools-disabled Codex assessments; an isolated process clock advances past follow-up time and a synthetic manual Task supplies a commitment, facts and deadline. A useful scheduled draft is required; ordinary chat and controlled preemption are omitted'
          : daySync
            ? 'Actual tools-disabled Codex interpretation of synthetic conversational Day context, ordinary ja graag, and provider-free nu even niet; isolated process clock advances past cooldowns'
            : 'One actual tools-disabled Codex interpretation of synthetic context; ordinary chat omitted'
        : 'Deterministic tools-disabled interpretation and one deterministic explicit chat; no actual model calls'
      await proactiveAgentQa({
        directory: runDirectory,
        desktopDirectory,
        launch,
        close: closeElectron,
        getElectron: () => electron,
        checks,
        live,
        daySync,
        dayReview,
      })
    } else if (mode === 'smoke' && process.argv.includes('--host-context-ui')) {
      report.scope =
        'Native stored context Stop reason, restart/history and isolated unconfirmed UI; no provider, cloud or capture'
      await residentHostContextStopUiQa({
        directory: runDirectory,
        launch,
        close: closeElectron,
        getElectron: () => electron,
        checks,
      })
    } else if (mode === 'smoke' && process.argv.includes('--host-expiry-ui')) {
      report.scope =
        'Deterministic native stored expiry reason, restart/history and snapshot-only uncertain Stop UI; no provider, cloud or capture'
      await residentHostExpiryUiQa({
        directory: runDirectory,
        launch,
        close: closeElectron,
        getElectron: () => electron,
        checks,
      })
    } else if (mode === 'smoke' && process.argv.includes('--agent-documents-ui')) {
      report.scope = 'Native Agent project/document creation, follow-up edit, saved links and full restart'
      report.inference = 'Deterministic provider over the real native dynamic-tool transport; no live model or capture'
      await agentDocumentsQa(await launch(), webUrl, runDirectory)
      await closeElectron()
      await agentDocumentsAfterRestartQa(await launch(), webUrl, runDirectory)
      checks.push(
        'Reviewed Agent creates project and child document, edits it, opens deduplicated chat links and preserves wiki history and chat results after full restart'
      )
    } else if (mode === 'smoke' && process.argv.includes('--agent-review-ui')) {
      report.scope =
        'Native review keyboard/overflow and chat lifecycle with deterministic provider fixture, no live model or capture'
      await residentAgentQa(await launch(), webUrl, runDirectory)
      await closeElectron()
      await residentAgentAfterRestartQa(await launch(), webUrl, runDirectory)
      checks.push(
        'Long review is keyboard reachable and scrollable at 720px; fixture chat, consent cancellation and identity persist after full native restart'
      )
    } else if (mode === 'smoke' && process.argv.includes('--host-review')) {
      assert(process.argv.includes('--live'), '--host-review requires --live')
      report.scope = 'Native one-job host memory permission, revision and review lifecycle; no audio/capture'
      const { residentHostReviewQa } = await import('./residentHostReview')
      await residentHostReviewQa({
        directory: runDirectory,
        launch,
        close: closeElectron,
        getElectron: () => electron,
        checks,
      })
    } else if (mode === 'smoke' && process.argv.includes('--host-faults')) {
      assert(process.argv.includes('--live'), '--host-faults requires --live')
      report.scope = 'Native one-job host fault and Stop recovery, exact late readback, no audio/capture'
      await residentHostFaultsQa({
        directory: runDirectory,
        launch,
        close: closeElectron,
        getElectron: () => electron,
        checks,
      })
    } else if (mode === 'smoke' && process.argv.includes('--host-job')) {
      assert(process.argv.includes('--live'), '--host-job requires --live')
      assert(process.env.REMEMBER_QA_HOST_JOB_ENDPOINT, 'Explicit QA host endpoint required')
      report.scope =
        'One native host job across full Remember quit, current memory review, same-message restart; no audio/capture'
      await residentHostQa({
        directory: runDirectory,
        launch,
        close: closeElectron,
        getElectron: () => electron,
        checks,
      })
    } else if (mode === 'smoke' && process.argv.includes('--ambient-live')) {
      report.scope = 'Actual system speech through local ASR and live task analysis while capture continues'
      report.evidenceSource =
        'Synthetic Dutch speech over actual system output, real native capture and real model inference'
      await ambientLiveQa({ directory: runDirectory, profile, launch, close: closeElectron, checks })
    } else if (mode === 'smoke' && process.argv.includes('--remote-recovery')) {
      assert(process.argv.includes('--live'), '--remote-recovery requires --live')
      report.scope = 'Live Mac mini disconnect recovery and confirmed Stop through an owned loopback proxy'
      await residentRecoveryQa({ directory: runDirectory, launch, close: closeElectron, checks })
    } else if (mode === 'smoke' && process.argv.includes('--remote-agent')) {
      report.scope = 'Live Mac mini tool execution from the native chat and full Remember restart'
      await residentRemoteQa({ directory: runDirectory, launch, close: closeElectron, checks })
    } else if (mode === 'smoke' && process.argv.includes('--ambient-tasks')) {
      report.scope =
        'Captured evidence through the ordinary Day task writer, source navigation, dismissal and next-day restart'
      report.evidenceSource = 'Synthetic native capture and a parsed fixture Day plan; no model or full Day refresh'
      let target = await launch()
      assert(electron)
      await ambientTasksQa(electron, target, runDirectory, desktopDirectory)
      await closeElectron()
      target = await launch()
      assert(electron)
      await ambientTasksAfterRestartQa(electron, target, runDirectory)
      checks.push(
        'The ordinary Day writer preserves a dismissed task across restart and next-day exact-screen replay; a changed commitment remains eligible with its own source'
      )
    } else if (mode === 'smoke' && process.argv.includes('--living-spaces')) {
      report.scope = 'Living Spaces via native CLI, editor IPC, contribution readback and restart'
      await livingSpacesQa({ desktopDirectory, profile, runDirectory, launch, closeElectron, checks })
    } else if (mode === 'smoke' && process.argv.includes('--continuity')) {
      report.scope = 'Local CLI continuity, live capture observation, Inbox correction and native restart'
      await continuityQa({ desktopDirectory, profile, runDirectory, launch, closeElectron, checks })
    } else if (audioProcessingRecovery) {
      report.scope = 'Interrupted audio processing on open and ended Days through native startup and restart'
      let originalWavs: ReturnType<typeof inspectEvidence>['wavs'] | undefined
      for (const phase of ['audio-processing-recovery', 'audio-processing-restarted']) {
        const target = await launch()
        const days = await target.evaluate(() => window.remember.listDays())
        const recovered = verifyAudioProcessingRecovery(profile, days, audioProcessingRecovery)
        writeJson(`${phase}-proof.json`, recovered)
        await target.goto(`${webUrl}/conversations/activity/`)
        await target.getByRole('heading', { name: 'Snippets', exact: true }).waitFor({ state: 'visible' })
        const loadMore = target.locator('button[aria-controls="conversation-audio-activity-items"]')
        while (await loadMore.count()) await loadMore.click()
        for (const day of audioProcessingRecovery) {
          for (const ready of day.moments.filter((moment) => moment.status === 'ready')) {
            await target.getByText(ready.transcript, { exact: true }).waitFor({ state: 'visible' })
            if (day.wasOpen) assert.equal(await target.locator(`#conversation-activity-${ready.id}`).isEnabled(), true)
          }
          for (const failed of day.moments.filter((moment) => moment.status === 'failed')) {
            await target
              .locator(`label[for="conversation-activity-${failed.id}"]`)
              .getByText('Audio could not be transcribed.', { exact: true })
              .waitFor({ state: 'visible' })
          }
        }
        assert.equal(await target.getByText('Audio is being processed locally…', { exact: true }).count(), 0)
        const evidence = await checkpoint(phase)
        if (originalWavs) assert.deepEqual(evidence.wavs, originalWavs, 'Retained audio bytes must survive restart')
        else originalWavs = evidence.wavs
        await closeElectron()
        checks.push(`${phase}: accepted speech is ready, missing speech fails, empty/quarantined speech stays terminal`)
        checks.push(`${phase}: legacy failed speech recovers; legacy failures without accepted speech remain failed`)
      }
      checks.push(
        'Native Activity exposes recovered transcripts and errors; decoded speech and local audio survive restart'
      )
    } else if (mode === 'smoke' && process.argv.includes('--startup-travel')) {
      report.scope = 'Legacy reused-PID lock recovery and imported Day persistence after timezone travel'
      for (const phase of ['startup-travel', 'startup-travel-restarted']) {
        const target = await launch()
        assert(electron)
        assert.equal(
          await electron.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
          'America/Los_Angeles'
        )
        assert(!target.url().includes('/startup-error'))
        const days = await target.evaluate(() => window.remember.listDays())
        const day = verifyStartupTravel(days)
        const owner = JSON.parse(readFileSync(join(profile, '.runtime-lock/owner.json'), 'utf8'))
        assert.notEqual(owner.token, 'qa-stale-before-reboot')
        assert.equal(typeof owner.processStartedAt, 'number')
        writeJson(`${phase}-proof.json`, { day, owner, timezone: 'America/Los_Angeles' })
        await target.goto(`${webUrl}/day/conversations/?id=${day.id}`)
        await target.getByText('Synthetic travel meeting', { exact: true }).first().waitFor({ state: 'visible' })
        await checkpoint(phase)
        await closeElectron()
        assert(!existsSync(join(profile, '.runtime-lock')), 'Clean shutdown must release the runtime lock')
        checks.push(phase)
      }
    } else if (mode === 'smoke') {
      assert(fixture)
      await smoke(fixture)
    }
    if (mode === 'widget')
      await (process.argv.includes('--menu') ? edgeWidgetMenuQa : edgeWidgetDockingQa)({
        launch,
        closeElectron,
        getElectron: () => electron,
        runDirectory,
        checks,
      })
    if (mode === 'audio') await liveAudio()
    if (mode === 'dictation')
      await (process.argv.includes('--shared-capture') ? sharedMicrophoneFixtureQa : dictationQa)({
        launch,
        closeElectron,
        getElectron: () => electron,
        runDirectory,
        wavPath: process.argv[process.argv.indexOf('--dictation-wav') + 1],
        verifyInsertion: !process.argv.includes('--skip-insertion'),
        hudOnly: process.argv.includes('--hud'),
        checks,
      })
    if (mode === 'recovery-reset') await recoveryReset()
    if (mode === 'learning') await learning()
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'
    report.error = error instanceof Error ? error.stack : String(error)
    process.exitCode = 1
    try {
      await checkpoint('failure')
    } catch (captureError) {
      report.artifactError = String(captureError)
    }
  } finally {
    clearTimeout(deadline)
    stimulus?.kill('SIGTERM')
    try {
      await closeElectron()
    } catch (error) {
      report.cleanupError = String(error)
      report.status = 'failed'
      process.exitCode = 1
    }
    try {
      if (exportedWeb)
        await new Promise<void>((resolve, reject) => exportedWeb?.close((error) => (error ? reject(error) : resolve())))
      if (web?.pid && web.exitCode === null && web.signalCode === null) {
        process.kill(-web.pid, 'SIGTERM')
        await Promise.race([once(web, 'exit'), delay(5_000)])
        if (web.exitCode === null && web.signalCode === null) process.kill(-web.pid, 'SIGKILL')
      }
    } catch (error) {
      report.rendererCleanupError = String(error)
      report.status = 'failed'
      process.exitCode = 1
    }
    try {
      await sharedAgentSetup?.cleanup()
    } catch (error) {
      report.sharedAgentCleanupError = String(error)
      report.status = 'failed'
      process.exitCode = 1
    }
    try {
      await proactiveBriefingSetup?.cleanup()
    } catch (error) {
      report.proactiveBriefingCleanupError = String(error)
      report.status = 'failed'
      process.exitCode = 1
    }
    report.finishedAt = new Date().toISOString()
    report.phase = 'finished'
    writeJson('report.json', report)
    for (const lock of acquiredLocks.reverse()) rmSync(lock, { recursive: true })
    console.log(`QA ${report.status}. Evidence: ${join(runDirectory, 'report.json')}`)
    if (report.error) console.error(report.error)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
