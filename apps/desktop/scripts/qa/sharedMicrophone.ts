import assert from 'node:assert/strict'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DictationState } from '@remember/shared'
import type { ElectronApplication, Page } from 'playwright-core'
import { readPcmWavInfo } from '../../src/main/dailyReview/pcmWav'

type CaptureEvent = { name: string; at: number; wallTime: number; level?: number }
type CaptureInterval = { startedAt: number; endedAt: number }

declare global {
  var qaSharedDictation: {
    events: CaptureEvent[]
    wav?: number[]
    boundaries?: Array<{ action: string; startedAt: number }>
  } | null
  var qaSharedPermissionGate: (() => Promise<void>) | undefined
  var qaReleaseSharedPermission: (() => void) | undefined
  var qaRestoreMicrophonePermission: (() => void) | undefined
  var qaAudioRecovery: {
    delaySystemStopMs: number
    chunks: Array<{ startedAt: number; durationMs: number; sampleCount: number }>
    snapshot: () => {
      microphone: boolean
      microphoneClosed: boolean | null
      systemPid: number | null
      retryPending: boolean
      chunks: Array<{ startedAt: number; durationMs: number; sampleCount: number }>
    }
  }
  var qaSharedMicrophone: {
    snapshot: () => Promise<{
      transport: boolean
      conversation: boolean
      dictation: boolean
      capture: Record<string, unknown> | null
    }>
    crash: () => void
  }
}

function replaceOnce(source: string, before: string, after: string) {
  assert.equal(source.split(before).length, 2, `Expected one QA instrumentation point: ${before}`)
  return source.replace(before, after)
}

// Instrument only the disposable QA copy. Both capture backends keep their actual
// device input, recorder events, inference, IPC, and persistence behavior.
export function installSharedMicrophoneQa(desktop: string, permissionGate = true) {
  const transportFile = join(desktop, 'src/main/dailyReview/sharedMicrophoneTransport.ts')
  writeFileSync(
    transportFile,
    replaceOnce(
      readFileSync(transportFile, 'utf8'),
      "        if (message.type === 'boundary') receivingAudio = message.route !== 'idle'",
      `        if (message.type === 'boundary') {
          receivingAudio = message.route !== 'idle'
          if (globalThis.qaSharedDictation) {
            (globalThis.qaSharedDictation.boundaries ??= []).push({ action: String(message.action), startedAt: Number(message.started_at) })
          }
        }`
    )
  )
  const dailyReviewFile = join(desktop, 'src/main/dailyReview/index.ts')
  const dailyReviewSource = replaceOnce(
    readFileSync(dailyReviewFile, 'utf8'),
    '      microphoneLastChunkAt = chunk.startedAt + chunk.durationMs',
    `      globalThis.qaAudioRecovery?.chunks.push({ startedAt: chunk.startedAt, durationMs: chunk.durationMs, sampleCount: chunk.sampleCount })
      microphoneLastChunkAt = chunk.startedAt + chunk.durationMs`
  )
  writeFileSync(
    dailyReviewFile,
    replaceOnce(
      dailyReviewSource,
      '  stopSystemAudioCapture(child)',
      `  if (globalThis.qaAudioRecovery?.delaySystemStopMs) {
    setTimeout(() => stopSystemAudioCapture(child), globalThis.qaAudioRecovery.delaySystemStopMs)
  } else stopSystemAudioCapture(child)`
    ) +
      `
Object.assign(globalThis, { qaAudioRecovery: {
  delaySystemStopMs: 0,
  chunks: [],
  snapshot: () => ({
    microphone: microphoneAudioCaptureProcess != null,
    microphoneClosed: microphoneAudioCaptureProcess?.isClosed ?? null,
    systemPid: systemAudioCaptureProcess?.pid ?? null,
    retryPending: microphoneRestartTimer != null,
    chunks: globalThis.qaAudioRecovery.chunks.slice(),
  }),
} })
`
  )
  const file = join(desktop, 'src/main/dictation/index.ts')
  let source = readFileSync(file, 'utf8')
  source = replaceOnce(
    source,
    'async function toggle(saveOnly = false) {',
    "async function toggle(saveOnly = false) { markSharedCapture('command');"
  )
  if (permissionGate) {
    source = replaceOnce(
      source,
      'ensureMicrophoneAccess(systemPreferences)',
      '(globalThis.qaSharedPermissionGate ? await globalThis.qaSharedPermissionGate().then(() => ensureMicrophoneAccess(systemPreferences)) : ensureMicrophoneAccess(systemPreferences))'
    )
  }
  source = replaceOnce(
    source,
    'const sharedRecorder = createSharedDictationCapture(handleRecorderEvent)',
    `const sharedRecorder = createSharedDictationCapture(handleRecorderEvent)
  const qaSharedStart = sharedRecorder.start
  sharedRecorder.start = async (options) => {
    const selected = await qaSharedStart(options)
    markSharedCapture(selected ? 'shared-selected' : 'browser-selected')
    return selected
  }`
  )
  source = replaceOnce(
    source,
    'function handleRecorderEvent(event: DictationRecorderEvent) {',
    `function handleRecorderEvent(event: DictationRecorderEvent) {
    if (event.type === 'started' || event.type === 'error' || event.type === 'result') markSharedCapture(event.type)
    if (event.type === 'level' && event.level > 0 && !globalThis.qaSharedDictation?.events.some((entry) => entry.name === 'signal')) markSharedCapture('signal', event.level)
    if (event.type === 'result' && globalThis.qaSharedDictation) globalThis.qaSharedDictation.wav = Array.from(new Uint8Array(event.wav))`
  )
  writeFileSync(file, source)
  appendFileSync(
    file,
    `
function markSharedCapture(name: string, level?: number) {
  globalThis.qaSharedDictation?.events.push({ name, at: performance.now(), wallTime: Date.now(), level })
}
`
  )
  appendFileSync(
    join(desktop, 'src/main/dailyReview/microphoneAudio.ts'),
    `
import { BrowserWindow as QaMicrophoneWindow } from 'electron'
Object.assign(globalThis, { qaSharedMicrophone: {
  snapshot: async () => {
    const current = service as unknown as {
      transport: unknown
      conversation: unknown
      dictation: unknown
      command: (type: string) => Promise<Record<string, unknown>>
    } | null
    return {
      transport: Boolean(current?.transport),
      conversation: Boolean(current?.conversation),
      dictation: Boolean(current?.dictation),
      capture: current?.transport ? await current.command('status') : null,
    }
  },
  crash: () => {
    const window = QaMicrophoneWindow.getAllWindows().find((window) => window.getTitle() === 'Remember microphone capture')
    if (!window) throw new Error('No isolated shared microphone renderer to crash')
    window.webContents.forcefullyCrashRenderer()
  },
} })
`
  )
}

export async function ownedMicrophoneRenderers(electron: ElectronApplication) {
  return electron.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((window) => window.getTitle() === 'Remember microphone capture')
      .map((window) => ({
        id: window.id,
        webContentsId: window.webContents.id,
        pid: window.webContents.getOSProcessId(),
      }))
  )
}

export async function sharedMicrophoneRecoveryQa({
  target,
  electron,
  runDirectory,
  checks,
}: {
  target: Page
  electron: ElectronApplication
  runDirectory: string
  checks: string[]
}) {
  const before = await electron.evaluate(() => globalThis.qaAudioRecovery.snapshot())
  assert(before.microphone && before.systemPid, 'Both audio sources must be active before the recovery check')
  await electron.evaluate(() => {
    // A slow system helper shutdown must never consume the one microphone retry.
    globalThis.qaAudioRecovery.delaySystemStopMs = 2_500
    globalThis.qaSharedMicrophone.crash()
  })
  await target.waitForTimeout(4_000)
  const after = await electron.evaluate(() => globalThis.qaAudioRecovery.snapshot())
  writeFileSync(join(runDirectory, 'microphone-recovery.json'), `${JSON.stringify({ before, after }, null, 2)}\n`)
  await electron.evaluate(() => {
    globalThis.qaAudioRecovery.delaySystemStopMs = 0
  })
  assert(
    after.microphone && !after.microphoneClosed,
    'Microphone recovery must survive a system helper still closing at the retry deadline'
  )
  assert.equal(after.systemPid, before.systemPid, 'A microphone failure must leave the working system recorder running')
  assert(after.chunks.length > before.chunks.length, 'A renderer failure must retain the captured conversation prefix')
  const first = await electron.evaluate(() => globalThis.qaSharedMicrophone.snapshot())
  await target.waitForTimeout(250)
  const next = await electron.evaluate(() => globalThis.qaSharedMicrophone.snapshot())
  assert(first.capture?.running && next.capture?.running)
  assert(
    Number(next.capture.callback_count) > Number(first.capture.callback_count),
    'Recovered input must deliver new PCM'
  )
  checks.push(
    'Microphone failure recovers with fresh PCM while the same system audio helper continues; delayed system shutdown cannot consume the retry'
  )
  await electron.evaluate(() => {
    // Only the owned Electron main process is stalled; Chromium capture continues.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3_000)
  })
  await target.waitForTimeout(4_000)
  const afterStall = await electron.evaluate(() => globalThis.qaAudioRecovery.snapshot())
  const recovered = await electron.evaluate(() => globalThis.qaSharedMicrophone.snapshot())
  await target.waitForTimeout(250)
  const flowing = await electron.evaluate(() => globalThis.qaSharedMicrophone.snapshot())
  writeFileSync(
    join(runDirectory, 'microphone-recovery.json'),
    `${JSON.stringify({ before, after, afterStall, recovered, flowing }, null, 2)}\n`
  )
  assert.equal(afterStall.systemPid, before.systemPid)
  assert(afterStall.chunks.length > after.chunks.length, 'A stalled consumer must retain the valid prefix')
  assert(recovered.capture?.running && flowing.capture?.running)
  assert(Number(flowing.capture.callback_count) > Number(recovered.capture.callback_count))
  checks.push(
    'A three-second main-process stall retains the valid microphone prefix and recovers fresh PCM without restarting system audio'
  )
}

export async function sharedMicrophoneQa({
  target,
  electron,
  runDirectory,
  checks,
}: {
  target: Page
  electron: ElectronApplication
  runDirectory: string
  checks: string[]
}) {
  const intervals: CaptureInterval[] = []
  const trials: Array<{ latencyMs: number; signalMs: number; events: CaptureEvent[] }> = []
  const evidence: Record<string, unknown> = {
    timingBoundary:
      'Electron main toggle entry to receipt of the started event after first retained PCM; excludes physical keypress, renderer-to-main IPC and HUD paint.',
    trials,
    intervals,
  }
  const save = () =>
    writeFileSync(join(runDirectory, 'dictation-shared.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  async function eventually(check: () => Promise<boolean>, description: string, timeout = 15_000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await check()) return
      await target.waitForTimeout(20)
    }
    throw new Error(`Shared microphone dictation timed out: ${description}`)
  }
  const state = () => target.evaluate(() => window.rememberDictation?.getState())
  const waitStatus = (status: DictationState['status']) =>
    eventually(async () => (await state())?.status === status, status)
  const resetProbe = () =>
    electron.evaluate(() => {
      globalThis.qaSharedDictation = { events: [] }
    })
  const conversationReady = () =>
    eventually(
      async () => Boolean((await target.evaluate(() => window.remember.getState())).microphoneName),
      'conversation microphone resumes'
    )
  const settings = await target.evaluate(() => window.remember.getSettings())
  await target.evaluate(
    (dictation) =>
      window.remember.updateSettings({
        dictation: {
          ...dictation,
          microphoneId: null,
          autoInsert: false,
          soundsEnabled: false,
          dimMediaDuringRecording: false,
          forceBuiltInMicWhenAudioPlaying: false,
        },
      }),
    settings.dictation
  )
  await conversationReady()
  const initialRenderers = await ownedMicrophoneRenderers(electron)
  assert.equal(initialRenderers.length, 1, 'One shared Chromium renderer must own the QA microphone')
  evidence.initialRenderers = initialRenderers
  const initialEngine = await electron.evaluate(() => globalThis.qaSharedMicrophone.snapshot())
  assert.equal(initialEngine.capture?.running, true, 'Conversation must already be receiving real input')
  assert.equal(initialEngine.conversation, true)
  evidence.initialEngine = initialEngine
  if (!initialEngine.capture?.default_input_is_selected) {
    const microphoneName = String(initialEngine.capture?.microphone_name)
    const devices = (await state())?.microphones ?? []
    const selected = devices.find((device) => device.label === microphoneName)
    assert(selected, `QA needs the active shared microphone in the device list: ${microphoneName}`)
    await target.evaluate(async (microphoneId) => {
      const current = await window.remember.getSettings()
      await window.remember.updateSettings({ dictation: { ...current.dictation, microphoneId } })
    }, selected.id)
    evidence.selection = { kind: 'explicit-shared-input', label: selected.label }
  } else evidence.selection = { kind: 'system-default' }
  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      await resetProbe()
      await target.evaluate(() => window.rememberDictation?.toggle())
      await waitStatus('recording')
      const recordingStartedAt = (await state())?.startedAt
      assert(recordingStartedAt != null)
      await eventually(
        async () =>
          Boolean(
            await electron.evaluate(() => globalThis.qaSharedDictation?.events.some((event) => event.name === 'signal'))
          ),
        'real microphone samples with nonzero signal'
      )
      const events = await electron.evaluate(() => globalThis.qaSharedDictation?.events)
      assert(events)
      const command = events?.find((event) => event.name === 'command')
      const started = events?.find((event) => event.name === 'started')
      const signal = events?.find((event) => event.name === 'signal')
      assert(command && started && signal)
      assert(
        events?.some((event) => event.name === 'shared-selected'),
        'The explicitly matched microphone must select shared capture'
      )
      assert(!events.some((event) => event.name === 'browser-selected'))
      assert.deepEqual(
        await ownedMicrophoneRenderers(electron),
        initialRenderers,
        'Starting a note must reuse the existing renderer'
      )
      trials.push({ latencyMs: started.at - command.at, signalMs: signal.at - command.at, events })
      if (attempt === 5) {
        const crashed = await electron.evaluate(({ BrowserWindow }) => {
          const recorder = BrowserWindow.getAllWindows().find(
            (window) => window.getTitle() === 'Remember dictation recorder'
          )
          if (!recorder) throw new Error('The owned recorder renderer must exist before its crash check')
          const id = recorder.id
          recorder.webContents.forcefullyCrashRenderer()
          return id
        })
        await eventually(
          async () =>
            Boolean(
              await electron.evaluate(
                ({ BrowserWindow }, id) =>
                  BrowserWindow.getAllWindows().some(
                    (window) => window.getTitle() === 'Remember dictation recorder' && window.id !== id
                  ),
                crashed
              )
            ),
          'optional recorder renderer replacement'
        )
        assert.equal((await state())?.status, 'recording', 'A sounds renderer crash must not interrupt shared capture')
        assert.deepEqual(await ownedMicrophoneRenderers(electron), initialRenderers)
        evidence.optionalRendererCrash = { oldWindowId: crashed, recordingContinued: true }
        checks.push(
          'Crashing the optional sound/device renderer replaces that window while shared Chromium microphone capture continues'
        )
      }
      await target.waitForTimeout(attempt === 5 ? 1_200 : 250)
      if (attempt === 5) {
        await target.evaluate(() => window.rememberDictation?.toggle())
        await eventually(
          async () => electron.evaluate(() => Boolean(globalThis.qaSharedDictation?.wav)),
          'shared capture WAV result'
        )
        const bytes = await electron.evaluate(() => globalThis.qaSharedDictation?.wav)
        assert(bytes)
        const wav = Buffer.from(bytes)
        const path = join(runDirectory, 'dictation-shared.wav')
        writeFileSync(path, wav)
        const info = readPcmWavInfo(path)
        let energy = 0
        let nonzero = 0
        for (let offset = info.dataOffset; offset < info.dataOffset + info.sampleCount * 2; offset += 2) {
          const sample = wav.readInt16LE(offset) / 32768
          energy += sample * sample
          if (sample !== 0) nonzero++
        }
        evidence.wav = {
          ...info,
          durationMs: (info.sampleCount / info.sampleRate) * 1000,
          rms: Math.sqrt(energy / info.sampleCount),
          nonzero,
        }
        assert(info.sampleCount / info.sampleRate >= 1, 'Finishing must retain the shared recording')
        assert(nonzero > info.sampleCount / 2, 'The saved shared capture WAV must contain actual microphone signal')
        await eventually(
          async () => ['done', 'error'].includes((await state())?.status ?? ''),
          'real inference terminates',
          30_000
        )
        evidence.transcription = await state()
      }
      await target.evaluate(() => window.rememberDictation?.cancel())
      await waitStatus('idle')
      await eventually(
        async () =>
          Boolean(
            await electron.evaluate(() =>
              globalThis.qaSharedDictation?.boundaries?.some(
                (boundary) => boundary.action === 'dictation-stop' || boundary.action === 'dictation-cancel'
              )
            )
          ),
        'sample boundary returning input to conversations'
      )
      const endedAt = await electron.evaluate(
        () =>
          globalThis.qaSharedDictation?.boundaries?.find(
            (boundary) => boundary.action === 'dictation-stop' || boundary.action === 'dictation-cancel'
          )?.startedAt
      )
      assert(endedAt != null && Number.isFinite(endedAt))
      intervals.push({ startedAt: recordingStartedAt, endedAt })
      await conversationReady()
      assert.deepEqual(
        await ownedMicrophoneRenderers(electron),
        initialRenderers,
        'Cancelling must retain the conversation renderer'
      )
      save()
    }
    const sorted = trials.map((trial) => trial.latencyMs).sort((left, right) => left - right)
    evidence.latency = { medianMs: (sorted[2] + sorted[3]) / 2, maxMs: sorted.at(-1) }
    assert((sorted[2] + sorted[3]) / 2 < 100, 'Shared Chromium median command-to-first-buffer must stay below 100 ms')
    assert(
      sorted.every((value) => value < 500),
      'Shared capture must not retain the old half-second startup tail'
    )
    checks.push(
      'Six real Voice note starts reuse one shared Chromium microphone stream, deliver nonzero samples, and finish/cancel back to conversation capture; median first-buffer latency stays below 100 ms'
    )

    // Hold only the QA permission await to exercise cancellation before shared
    // capture starts; releasing it must not resurrect a cancelled session.
    await electron.evaluate(() => {
      globalThis.qaSharedPermissionGate = () =>
        new Promise<void>((resolve) => {
          globalThis.qaReleaseSharedPermission = resolve
        })
    })
    await target.evaluate(() => void window.rememberDictation?.toggle())
    await waitStatus('starting')
    await target.evaluate(() => void window.rememberDictation?.cancel())
    await waitStatus('idle')
    await electron.evaluate(() => {
      globalThis.qaReleaseSharedPermission?.()
      globalThis.qaSharedPermissionGate = undefined
    })
    await target.waitForTimeout(200)
    assert.equal((await state())?.status, 'idle')
    await conversationReady()
    checks.push('Cancelling while permission setup is pending leaves no recording after the pending setup resolves')
    evidence.pendingCancellation = 'passed'
    await resetProbe()
    await target.evaluate(() => window.rememberDictation?.toggle())
    await waitStatus('recording')
    const beforeCrash = await electron.evaluate(() => globalThis.qaSharedMicrophone.snapshot())
    const beforeCrashRenderers = await ownedMicrophoneRenderers(electron)
    assert.deepEqual(beforeCrashRenderers, initialRenderers)
    await electron.evaluate(() => globalThis.qaSharedMicrophone.crash())
    await waitStatus('error')
    await conversationReady()
    const recovered = await electron.evaluate(() => globalThis.qaSharedMicrophone.snapshot())
    const recoveredRenderers = await ownedMicrophoneRenderers(electron)
    assert.equal(recoveredRenderers.length, 1)
    assert.notEqual(recoveredRenderers[0].id, beforeCrashRenderers[0].id, 'A crashed capture renderer must be replaced')
    assert(recovered.conversation, 'Conversation input must recover without stopping system capture')
    await resetProbe()
    await target.evaluate(() => window.rememberDictation?.toggle())
    await waitStatus('recording')
    const afterRecovery = await electron.evaluate(() => globalThis.qaSharedMicrophone.snapshot())
    assert(afterRecovery.dictation && afterRecovery.conversation)
    await target.evaluate(() => window.rememberDictation?.cancel())
    await waitStatus('idle')
    evidence.crashRecovery = { beforeCrash, beforeCrashRenderers, recovered, recoveredRenderers, afterRecovery }
    checks.push(
      'Crashing only the isolated microphone renderer reports a recording error, restarts conversation input, and permits another shared microphone Voice note'
    )
    await target.evaluate(() => window.rememberDictation?.toggle())
    await waitStatus('recording')
    const deniedAt = Date.now()
    try {
      await electron.evaluate(({ systemPreferences }) => {
        const original = systemPreferences.getMediaAccessStatus
        globalThis.qaRestoreMicrophonePermission = () => {
          systemPreferences.getMediaAccessStatus = original
        }
        systemPreferences.getMediaAccessStatus = (mediaType) =>
          mediaType === 'microphone' ? 'denied' : original.call(systemPreferences, mediaType)
      })
      await eventually(
        async () => (await state())?.status === 'error',
        'simulated permission denial stops the note',
        7_000
      )
      const stopped = await electron.evaluate(() => globalThis.qaSharedMicrophone.snapshot())
      assert.equal(stopped.dictation, false, 'Permission denial must remove the active Voice note subscriber')
      evidence.permissionDenial = { simulatedInOwnedApp: true, latencyMs: Date.now() - deniedAt, stopped }
      checks.push(
        'A simulated microphone permission denial in the owned Electron process stops the shared Voice note within seven seconds; the OS permission itself is unchanged'
      )
    } finally {
      await electron.evaluate(() => {
        globalThis.qaRestoreMicrophonePermission?.()
        globalThis.qaRestoreMicrophonePermission = undefined
      })
    }
    await target.evaluate(() => window.rememberDictation?.cancel())
    await waitStatus('idle')
    await conversationReady()
    save()
    return intervals
  } finally {
    await electron.evaluate(() => {
      globalThis.qaReleaseSharedPermission?.()
      globalThis.qaSharedPermissionGate = undefined
      globalThis.qaRestoreMicrophonePermission?.()
      globalThis.qaRestoreMicrophonePermission = undefined
      globalThis.qaSharedDictation = null
    })
    await target.evaluate(() => window.rememberDictation?.cancel())
    await target.evaluate((dictation) => window.remember.updateSettings({ dictation }), settings.dictation)
    save()
  }
}

export async function verifySharedMicrophoneIdle(
  electron: ElectronApplication,
  runDirectory: string,
  checks: string[],
  evidenceName = 'shared-microphone-idle'
) {
  const before = await electron.evaluate(() => globalThis.qaSharedMicrophone.snapshot())
  assert.equal(before.conversation, false, 'Stopped conversation must release its microphone subscriber')
  assert.equal(before.dictation, false, 'Stopped Voice note must release its microphone subscriber')
  assert(before.capture, 'Prepared capture renderer must respond after all capture has stopped')
  assert.equal(before.capture.running, false, 'A prepared renderer must not keep the microphone active')
  assert.equal(before.capture.context_state, 'closed', 'Idle capture must close its AudioContext')
  assert(
    Array.isArray(before.capture.tracks) &&
      before.capture.tracks.length > 0 &&
      before.capture.tracks.every((track) => track?.readyState === 'ended'),
    'Every captured microphone track must end when its last subscriber stops'
  )
  assert.equal(typeof before.capture.callback_count, 'number')
  await new Promise((resolve) => setTimeout(resolve, 600))
  const after = await electron.evaluate(() => globalThis.qaSharedMicrophone.snapshot())
  assert.equal(after.capture?.running, false)
  assert.equal(
    after.capture?.callback_count,
    before.capture.callback_count,
    'Idle preparation must deliver no PCM packets'
  )
  writeFileSync(join(runDirectory, `${evidenceName}.json`), `${JSON.stringify({ before, after }, null, 2)}\n`)
  checks.push(
    'After all recording stops, the prepared capture renderer keeps its input stopped and its delivered PCM packet count stays unchanged'
  )
}

/** Known wanted speech reaches the real shared worklet without speaker/AEC ambiguity. */
export async function sharedMicrophoneFixtureQa({
  launch,
  closeElectron,
  getElectron,
  runDirectory,
  checks,
}: {
  launch: () => Promise<Page>
  closeElectron: () => Promise<void>
  getElectron: () => ElectronApplication | undefined
  runDirectory: string
  checks: string[]
  wavPath?: string
  verifyInsertion?: boolean
  hudOnly?: boolean
}) {
  let target = await launch()
  let electron = getElectron()
  assert(electron)
  const waitStatus = async (expected: DictationState['status']) => {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const state = await target.evaluate(() => window.rememberDictation?.getState())
      if (state?.status === expected) return state
      if (state?.status === 'error') assert.fail(`Shared fixture recording failed: ${JSON.stringify(state)}`)
      await target.waitForTimeout(20)
    }
    assert.fail(`Shared fixture recording did not reach ${expected}`)
  }
  const originalClipboard = await electron.evaluate(({ clipboard }) => clipboard.readText())
  try {
    const settings = await target.evaluate(() => window.remember.getSettings())
    await target.evaluate(
      (dictation) =>
        window.remember.updateSettings({
          dictation: {
            ...dictation,
            microphoneId: null,
            soundsEnabled: false,
            autoInsert: false,
            dimMediaDuringRecording: false,
            forceBuiltInMicWhenAudioPlaying: false,
          },
        }),
      settings.dictation
    )
    await electron.evaluate(() => {
      globalThis.qaSharedDictation = { events: [] }
    })
    await target.evaluate(() => window.rememberDictation?.toggle())
    await waitStatus('recording')
    const recording = await electron.evaluate(() => globalThis.qaSharedMicrophone.snapshot())
    const sharedPage = electron.windows().find((window) => window.url().includes('microphone-capture.html'))
    const devices = await sharedPage?.evaluate(async () =>
      (await navigator.mediaDevices.enumerateDevices()).map((device) => ({
        id: device.deviceId,
        groupId: device.groupId,
        label: device.label,
        kind: device.kind,
      }))
    )
    writeFileSync(
      join(runDirectory, 'shared-fixture-start.json'),
      `${JSON.stringify({ recording, devices, events: await electron.evaluate(() => globalThis.qaSharedDictation?.events) }, null, 2)}\n`
    )
    assert.equal(recording.capture?.running, true)
    assert.equal(recording.dictation, true)
    assert.equal(recording.conversation, false)
    await target.waitForTimeout(6_500)
    await target.evaluate(() => window.rememberDictation?.toggle())
    await waitStatus('done')
    const note = (await target.evaluate(() => window.rememberDictation?.getHistory()))?.[0]
    assert(note)
    assert.match(note.text, /^Morgen\b/i, 'The shared worklet must preserve the first spoken word')
    assert.match(note.text, /planning/i)
    assert.match(note.text, /team[.!]?$/i, 'The shared worklet must preserve the final spoken word')
    const capture = await electron.evaluate(() => globalThis.qaSharedDictation)
    assert(capture)
    assert(capture?.events.some((event) => event.name === 'shared-selected'))
    assert(!capture.events.some((event) => event.name === 'browser-selected'))
    assert(capture.wav)
    const wav = Buffer.from(capture.wav)
    const path = join(runDirectory, 'shared-fixture.wav')
    writeFileSync(path, wav)
    const info = readPcmWavInfo(path)
    assert.equal(info.sampleRate, 16_000)
    assert(info.sampleCount > 6 * 16_000)
    writeFileSync(
      join(runDirectory, 'shared-fixture.json'),
      `${JSON.stringify({ note, info, recording, events: capture.events }, null, 2)}\n`
    )
    checks.push(
      'Known Dutch wanted speech passes through the actual shared Chromium stream and AudioWorklet; real Parakeet retains the first and last words and persists a 16 kHz PCM Voice note'
    )
    await target.evaluate(() => window.rememberDictation?.cancel())
    await waitStatus('idle')
    await verifySharedMicrophoneIdle(electron, runDirectory, checks)
    await closeElectron()
    target = await launch()
    electron = getElectron()
    assert(electron)
    const restored = (await target.evaluate(() => window.rememberDictation?.getHistory()))?.find(
      (entry) => entry.id === note.id
    )
    assert.deepEqual(restored, note, 'Shared capture history must survive a full app restart')
    const retained = await target.evaluate(async (id) => {
      const wav = await window.rememberDictation?.downloadNote(id)
      return wav ? Array.from(new Uint8Array(wav)) : null
    }, note.id)
    assert(retained)
    assert.deepEqual(Buffer.from(retained), wav, 'Persisted Voice note PCM must survive restart unchanged')
    await target.evaluate((id) => window.rememberDictation?.deleteNote(id), note.id)
    assert(
      !(await target.evaluate(() => window.rememberDictation?.getHistory()))?.some((entry) => entry.id === note.id)
    )
    checks.push(
      'The shared-stream Voice note and exact WAV bytes survive full Electron restart and can be deleted through real IPC'
    )
  } finally {
    await getElectron()?.evaluate(({ clipboard }, previous) => clipboard.writeText(previous), originalClipboard)
  }
}

export async function sharedMicrophoneColdQa({
  target,
  electron,
  runDirectory,
  checks,
}: {
  target: Page
  electron: ElectronApplication
  runDirectory: string
  checks: string[]
}) {
  const settings = await target.evaluate(() => window.remember.getSettings())
  await target.evaluate(
    (dictation) =>
      window.remember.updateSettings({
        dictation: {
          ...dictation,
          microphoneId: null,
          soundsEnabled: false,
          autoInsert: false,
          dimMediaDuringRecording: false,
          forceBuiltInMicWhenAudioPlaying: false,
        },
      }),
    settings.dictation
  )
  const trials: Array<Record<string, unknown>> = []
  const path = join(runDirectory, 'shared-cold-starts.json')
  const proof = {
    scope:
      'Five new physical getUserMedia streams in an isolated app with its conversation capture stopped. Other applications are left untouched, so this does not establish hardware-cold startup.',
    timing:
      'Electron main toggle entry to first retained PCM started event; excludes physical keypress, renderer-to-main IPC and HUD paint.',
    trials,
  }
  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt === 5) {
        const devices = (await target.evaluate(() => window.rememberDictation?.getState()))?.microphones
        const builtIn = devices?.find((device) => /macbook|built-in|internal|ingebouwd/i.test(device.label))
        assert(
          builtIn,
          'The physical QA machine must expose its built-in microphone for the explicit-selection regression'
        )
        await target.evaluate(async (microphoneId) => {
          const settings = await window.remember.getSettings()
          return window.remember.updateSettings({ dictation: { ...settings.dictation, microphoneId } })
        }, builtIn.id)
      }
      await electron.evaluate(() => {
        globalThis.qaSharedDictation = { events: [] }
      })
      const before = await electron.evaluate(() => globalThis.qaSharedMicrophone.snapshot())
      assert.equal(before.conversation, false)
      assert.equal(before.dictation, false)
      assert.notEqual(before.capture?.running, true)
      await target.evaluate(() => window.rememberDictation?.toggle())
      const deadline = Date.now() + 10_000
      while ((await target.evaluate(() => window.rememberDictation?.getState()))?.status !== 'recording') {
        assert(Date.now() < deadline, 'Cold shared capture must start within its bounded acquisition timeout')
        await target.waitForTimeout(20)
      }
      await target.waitForTimeout(200)
      const active = await electron.evaluate(() => globalThis.qaSharedMicrophone.snapshot())
      const events = await electron.evaluate(() => globalThis.qaSharedDictation?.events)
      const command = events?.find((event) => event.name === 'command')
      const started = events?.find((event) => event.name === 'started')
      const signal = events?.find((event) => event.name === 'signal')
      assert(command && started && signal)
      assert(events?.some((event) => event.name === 'shared-selected'))
      assert.equal(active.capture?.running, true)
      assert.equal(active.conversation, false)
      await target.evaluate(() => window.rememberDictation?.cancel())
      await verifySharedMicrophoneIdle(electron, runDirectory, [])
      const stopped = await electron.evaluate(() => globalThis.qaSharedMicrophone.snapshot())
      trials.push({
        selection: attempt === 5 ? 'explicit-built-in' : 'default',
        latencyMs: started.at - command.at,
        signalMs: signal.at - command.at,
        before,
        active,
        stopped,
        events,
      })
      writeFileSync(path, `${JSON.stringify(proof, null, 2)}\n`)
    }
    checks.push(
      'Five Voice notes each acquire a new real microphone stream with conversation capture off, retain actual nonzero input, and end every track and AudioContext between starts without delivered idle PCM'
    )
    checks.push(
      'An explicitly selected built-in microphone also uses the shared capture route rather than reopening the fallback recorder'
    )
    const meeting = await target.evaluate(() => window.remember.startManualMeeting())
    assert.equal(meeting.manualMeeting?.status, 'recording')
    assert(meeting.manualMeeting)
    await target.evaluate(() => window.rememberDictation?.toggle())
    const startedDeadline = Date.now() + 10_000
    while ((await target.evaluate(() => window.rememberDictation?.getState()))?.status !== 'recording') {
      assert(Date.now() < startedDeadline)
      await target.waitForTimeout(20)
    }
    await electron.evaluate(({ powerMonitor }) => {
      powerMonitor.emit('suspend')
    })
    const cancelledDeadline = Date.now() + 5_000
    while ((await target.evaluate(() => window.rememberDictation?.getState()))?.status !== 'idle') {
      assert(Date.now() < cancelledDeadline, 'The owned suspend event must cancel Voice note capture')
      await target.waitForTimeout(20)
    }
    await electron.evaluate(({ powerMonitor }) => {
      powerMonitor.emit('resume')
    })
    const resumedDeadline = Date.now() + 10_000
    while (!(await target.evaluate(() => window.remember.getState())).microphoneName) {
      assert(Date.now() < resumedDeadline, 'Conversation input must be ready after the owned resume event')
      await target.waitForTimeout(20)
    }
    const resumed = await electron.evaluate(() => globalThis.qaSharedMicrophone.snapshot())
    assert(resumed.conversation && !resumed.dictation && resumed.capture?.running)
    writeFileSync(
      join(runDirectory, 'shared-suspend-resume.json'),
      `${JSON.stringify({ simulatedPowerMonitorEvents: true, actualOsSleep: false, resumed }, null, 2)}\n`
    )
    await target.evaluate((id) => window.remember.stopManualMeeting(id), meeting.manualMeeting.id)
    await verifySharedMicrophoneIdle(electron, runDirectory, [])
    checks.push(
      'Simulated suspend/resume events in the owned Electron process cancel an active Voice note while leaving conversation capture recoverable; this does not exercise actual OS sleep'
    )
  } finally {
    await target.evaluate(() => window.rememberDictation?.cancel())
    await electron.evaluate(() => {
      globalThis.qaSharedDictation = null
    })
    await target.evaluate((dictation) => window.remember.updateSettings({ dictation }), settings.dictation)
    writeFileSync(path, `${JSON.stringify(proof, null, 2)}\n`)
  }
}
