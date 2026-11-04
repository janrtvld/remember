import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DictationBridge, DictationState } from '@remember/shared'
import type { ElectronApplication, Page } from 'playwright-core'
import type { TranscriptionResult } from '../../src/main/voiceNotes/transcribe'
import { readyWidget, verifyDisplayFollowing, verifyWidgetLevelUpdates } from './edgeWidget'

declare global {
  interface Window {
    rememberDictation?: DictationBridge
  }
  var qaSpeech: (samples: number[], kind: 'dictation' | 'conversation') => Promise<TranscriptionResult[]>
  var qaDictationSounds: { cues: string[]; audible: boolean }
  var qaDictationModelPreparations: number
  var qaDictationStartup: {
    events: Array<{ name: string; at: number }>
    releaseDuck?: () => void
  } | null
}

// Only the disposable QA snapshot has this direct inference entry point. The recorder
// still captures real Chromium audio buffers from the explicitly supplied WAV file.
export function installDictationFixture(desktop: string, sharedCapture = false) {
  const file = join(desktop, 'src/main/index.ts')
  appendFileSync(
    file,
    `
import { transcribeDictation as qaDictate, transcribeWav as qaConversation, flushTranscriptionStream as qaFlush } from './voiceNotes/transcribe'
Object.assign(globalThis, { qaSpeech: async (bytes: number[], kind: string) => {
  const wav = Buffer.from(bytes)
  if (kind === 'dictation') return [await qaDictate(wav)]
  const context = { streamId: 'qa-conversation', chunkId: 'qa-chunk', captureEpochId: 'qa-epoch', captureSequence: 0, startedAt: 1000, defaultLanguage: 'nl' as const }
  return [await qaConversation(wav, context), await qaFlush(context.streamId)]
} })
`
  )
  const service = join(desktop, 'src/main/dictation/index.ts')
  const source = readFileSync(service, 'utf8')
  const permission = 'ensureMicrophoneAccess(systemPreferences)'
  assert.equal(source.split(permission).length, 2)
  const sharedConstructor = 'const sharedRecorder = createSharedDictationCapture(handleRecorderEvent)'
  assert.equal(source.split(sharedConstructor).length, 2)
  writeFileSync(
    service,
    source
      .replace(permission, 'Promise.resolve(true)')
      .replaceAll("systemPreferences.getMediaAccessStatus('microphone')", "'granted'")
      .replace(
        sharedConstructor,
        sharedCapture
          ? sharedConstructor
          : `const sharedRecorder = { ...createSharedDictationCapture(handleRecorderEvent), prewarm: async () => undefined, start: async () => false, defaultInputSelected: () => false }`
      )
      .replace('accessibilityGranted, controlOutput,', 'accessibilityGranted, controlOutput as nativeControlOutput,')
      .replace(
        'async function prepareModel() {',
        'async function prepareModel() { globalThis.qaDictationModelPreparations = (globalThis.qaDictationModelPreparations ?? 0) + 1;'
      )
  )
  appendFileSync(
    service,
    `
async function controlOutput(action: 'duck' | 'restore' | 'playing') {
  const probe = globalThis.qaDictationStartup
  if (!probe) return nativeControlOutput(action)
  probe.events.push({ name: action, at: Date.now() })
  if (action === 'duck') await new Promise<void>((resolve) => { probe.releaseDuck = resolve })
  return action === 'playing' ? 'idle' : 'ok'
}
`
  )
  appendFileSync(
    file,
    `
ipcMain.on('remember:dictation-recorder:event', (_event, event) => {
  const probe = globalThis.qaDictationStartup
  if (probe && (event.type === 'samples' || event.type === 'started' || (event.type === 'level' && event.level > 0))) {
    if (!probe.events.some((entry) => entry.name === event.type)) {
      probe.events.push({ name: event.type, at: Date.now() })
    }
  }
})
`
  )
  const recorder = join(desktop, 'src/preload/dictationRecorder.ts')
  const recorderSource = readFileSync(recorder, 'utf8')
  const samples = 'chunks.push(samples)'
  assert.equal(recorderSource.split(samples).length, 2)
  writeFileSync(
    recorder,
    recorderSource.replace(
      samples,
      `if (sampleCount === 0) ipcRenderer.send(eventChannel, { type: 'samples', sessionId: capture.sessionId })\n      ${samples}`
    )
  )
}

export async function verifyHiddenWidgetDictation({
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
  async function waitStatus(status: DictationState['status']) {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if ((await target.evaluate(() => window.rememberDictation?.getState()))?.status === status) return
      await target.waitForTimeout(100)
    }
    assert.fail(
      `Dictation did not reach ${status}: ${JSON.stringify(await target.evaluate(() => window.rememberDictation?.getState()))}`
    )
  }
  const nativeWidget = () =>
    electron.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((window) => window.getTitle() === 'Remember widget')
      return window ? { visible: window.isVisible(), focused: window.isFocused() } : null
    })
  const assertHidden = async () => assert.equal(await nativeWidget(), null, 'The hidden idle bar must not return')
  await target.waitForFunction(() => window.rememberDictation !== undefined)
  await target.evaluate(() => window.rememberDictation?.cancel())
  await waitStatus('idle')
  await readyWidget(electron, target)

  for (const hidden of [
    { edgeWidgetEnabled: false, edgeWidgetHiddenUntil: null },
    { edgeWidgetEnabled: true, edgeWidgetHiddenUntil: Date.now() + 3_600_000 },
  ]) {
    const kind = hidden.edgeWidgetEnabled ? 'snoozed' : 'disabled'
    await target.evaluate((hidden) => window.remember.updateSettings(hidden), hidden)
    await assertHidden()
    await target.evaluate(() => window.rememberDictation?.toggle())
    await waitStatus('recording')
    let hud: Page | undefined
    for (let attempt = 0; !hud && attempt < 100; attempt++) {
      hud = electron.windows().find((page) => !page.isClosed() && page.url().includes('/edge-widget/'))
      if (!hud) await target.waitForTimeout(100)
    }
    assert(hud, `Dictation must create its HUD when the idle widget is ${kind}`)
    await hud.getByRole('button', { name: 'Cancel dictation', exact: true }).waitFor()
    await hud.getByRole('button', { name: 'Stop dictation', exact: true }).waitFor()
    assert.deepEqual(await nativeWidget(), { visible: true, focused: false })
    await hud.addStyleTag({ content: 'nextjs-portal { display: none; }' })
    await hud.screenshot({ path: join(runDirectory, `dictation-hud-${kind}.png`) })
    if (hidden.edgeWidgetEnabled) {
      await target.waitForTimeout(6_000)
      const closed = hud.waitForEvent('close')
      await hud.getByRole('button', { name: 'Stop dictation', exact: true }).click()
      await waitStatus('done')
      assert.match((await target.evaluate(() => window.rememberDictation?.getState()))?.text ?? '', /planning/i)
      await closed
      await assertHidden()
      await waitStatus('idle')
    } else {
      await hud.getByRole('button', { name: 'Cancel dictation', exact: true }).click()
      await waitStatus('idle')
    }
    await assertHidden()
    const settings = await target.evaluate(() => window.remember.getSettings())
    assert.equal(settings.edgeWidgetEnabled, hidden.edgeWidgetEnabled)
    assert.equal(settings.edgeWidgetHiddenUntil, hidden.edgeWidgetHiddenUntil)
  }
  checks.push(
    'Disabled and snoozed idle widgets still show a nonfocused dictation HUD with working controls; cancel and successful transcription hide it again without changing either hide preference'
  )
}

export async function dictationQa({
  launch,
  closeElectron,
  getElectron,
  runDirectory,
  wavPath,
  verifyInsertion = true,
  hudOnly = false,
  checks,
}: {
  launch: () => Promise<Page>
  closeElectron: () => Promise<void>
  getElectron: () => ElectronApplication | undefined
  runDirectory: string
  wavPath: string
  verifyInsertion?: boolean
  hudOnly?: boolean
  checks: string[]
}) {
  let target = await launch()
  let electron = getElectron()
  assert(electron)
  if (!hudOnly) await target.goto(`${new URL(target.url()).origin}/notes/?preferences=1`)
  const dictation = async () => {
    const value = await target.evaluate(() => window.rememberDictation?.getState())
    assert(value)
    return value
  }
  async function eventually(check: () => Promise<boolean>) {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (await check()) return
      await target.waitForTimeout(100)
    }
    throw new Error(`Dictation check timed out: ${JSON.stringify(await dictation())}`)
  }
  const waitStatus = (status: DictationState['status']) => eventually(async () => (await dictation()).status === status)
  const originalClipboard = await electron.evaluate(({ clipboard }) => clipboard.readText())
  try {
    const settings = await target.evaluate(() => window.remember.getSettings())
    await target.evaluate(
      (preferences) =>
        window.remember.updateSettings({
          dictation: {
            ...preferences,
            autoInsert: false,
            soundsEnabled: false,
            dimMediaDuringRecording: false,
            forceBuiltInMicWhenAudioPlaying: false,
          },
        }),
      settings.dictation
    )
    if (hudOnly) {
      await verifyHiddenWidgetDictation({ target, electron, runDirectory, checks })
      return
    }
    await target.reload()
    await target.getByRole('region', { name: 'Dictation', exact: true }).waitFor()
    await target.getByRole('switch', { name: 'Sounds', exact: true }).click()
    await eventually(() => target.evaluate(async () => (await window.remember.getSettings()).dictation.soundsEnabled))
    assert.equal((await target.evaluate(() => window.remember.getSettings())).dictation.soundsEnabled, true)
    await target.getByRole('switch', { name: 'Sounds', exact: true }).click()
    await eventually(() => target.evaluate(async () => !(await window.remember.getSettings()).dictation.soundsEnabled))
    await target.getByRole('button', { name: 'Record dictation shortcut' }).click()
    await target
      .getByRole('button', { name: 'Record dictation shortcut' })
      .getByText('Press a key combination…')
      .waitFor()
    await target.keyboard.press('Control+Alt+D')
    await eventually(() =>
      target.evaluate(async () => (await window.remember.getSettings()).dictation.shortcut === 'Control+Alt+D')
    )
    const chosen = (await target.evaluate(() => window.remember.getSettings())).dictation
    await target
      .getByRole('region', { name: 'Dictation', exact: true })
      .screenshot({ path: join(runDirectory, 'dictation-settings.png') })
    checks.push('Settings controls persist sound and shortcut changes through real Electron IPC')
    await target
      .getByRole('dialog', { name: 'Dictation preferences' })
      .getByRole('button', { name: 'Close', exact: true })
      .click()

    // Hold the optional volume helper indefinitely: real captured samples and the
    // first spoken word must survive even before setup has finished.
    await target.evaluate(
      (dictation) => window.remember.updateSettings({ dictation: { ...dictation, dimMediaDuringRecording: true } }),
      chosen
    )
    await electron.evaluate(() => {
      globalThis.qaDictationStartup = { events: [{ name: 'toggle', at: Date.now() }] }
    })
    try {
      await target.evaluate(() => void window.rememberDictation?.toggle())
      await waitStatus('recording')
      await eventually(async () =>
        Boolean(
          await electron?.evaluate(() => globalThis.qaDictationStartup?.events.some((event) => event.name === 'level'))
        )
      )
      await target.waitForTimeout(6_500)
      await target.evaluate(() => window.rememberDictation?.toggle())
      await waitStatus('transcribing')
      const startup = await electron.evaluate(() => {
        const probe = globalThis.qaDictationStartup
        if (!probe?.releaseDuck) throw new Error('Volume helper was not held')
        const events = [...probe.events]
        probe.releaseDuck()
        return events
      })
      assert(startup.some((event) => event.name === 'started'))
      assert(startup.some((event) => event.name === 'level'))
      assert(!startup.some((event) => event.name === 'restore'), 'Restore must wait for pending ducking')
      await waitStatus('done')
      const note = (await target.evaluate(() => window.rememberDictation?.getHistory()))?.[0]
      assert(note)
      assert.match(note.text, /^Morgen\b/i, 'Speech at the beginning of capture must be retained')
      assert.match(note.text, /planning/i)
      const restored = await electron.evaluate(() => globalThis.qaDictationStartup?.events)
      assert(restored?.some((event) => event.name === 'restore'))
      await target.evaluate((id) => window.rememberDictation?.deleteNote(id), note.id)
      await electron.evaluate(() => {
        globalThis.qaDictationStartup = { events: [{ name: 'toggle', at: Date.now() }] }
      })
      await target.evaluate(() => window.rememberDictation?.toggle())
      await waitStatus('recording')
      await target.evaluate(() => void window.rememberDictation?.cancel())
      await waitStatus('idle')
      const cancelling = await electron.evaluate(({ BrowserWindow }) => {
        const probe = globalThis.qaDictationStartup
        if (!probe?.releaseDuck) throw new Error('Volume helper was not held during cancellation')
        const events = [...probe.events]
        const recording = BrowserWindow.getAllWindows().some(
          (window) => window.getTitle() === 'Remember dictation recorder'
        )
        probe.releaseDuck()
        return { events, recording }
      })
      assert.equal(cancelling.recording, false, 'Cancel must close the microphone before pending setup finishes')
      assert(!cancelling.events.some((event) => event.name === 'restore'))
      await eventually(async () =>
        Boolean(
          await electron?.evaluate(() =>
            globalThis.qaDictationStartup?.events.some((event) => event.name === 'restore')
          )
        )
      )
      writeFileSync(
        join(runDirectory, 'dictation-startup.json'),
        JSON.stringify({ events: restored, text: note.text, cancellation: cancelling }, null, 2)
      )
      checks.push(
        'Cold-model dictation captures speech before volume setup finishes, preserves the first word, cancels immediately, and restores output only after pending dimming settles'
      )
    } finally {
      await electron.evaluate(() => {
        globalThis.qaDictationStartup?.releaseDuck?.()
        globalThis.qaDictationStartup = null
      })
      await target.evaluate((dictation) => window.remember.updateSettings({ dictation }), chosen)
    }
    const startupSamples: Array<{ readyMs: number; samplesMs: number; signalMs: number }> = []
    try {
      await target.evaluate(
        (dictation) =>
          window.remember.updateSettings({
            dictation: { ...dictation, dimMediaDuringRecording: false, forceBuiltInMicWhenAudioPlaying: false },
          }),
        chosen
      )
      for (let attempt = 0; attempt < 3; attempt++) {
        await target.waitForTimeout(300)
        await electron.evaluate(() => {
          globalThis.qaDictationStartup = { events: [{ name: 'toggle', at: Date.now() }] }
        })
        await target.evaluate(() => window.rememberDictation?.toggle())
        await waitStatus('recording')
        await eventually(async () =>
          Boolean(
            await electron?.evaluate(() =>
              globalThis.qaDictationStartup?.events.some((event) => event.name === 'level')
            )
          )
        )
        const events: Array<{ name: string; at: number }> | undefined = await electron.evaluate(
          () => globalThis.qaDictationStartup?.events
        )
        const requestedAt: number | undefined = events?.find((event) => event.name === 'toggle')?.at
        const readyAt: number | undefined = events?.find((event) => event.name === 'started')?.at
        const samplesAt: number | undefined = events?.find((event) => event.name === 'samples')?.at
        const signalAt: number | undefined = events?.find((event) => event.name === 'level')?.at
        assert(requestedAt && readyAt && samplesAt && signalAt)
        assert(readyAt >= samplesAt, 'The recording cue must wait until the microphone delivers samples')
        startupSamples.push({
          readyMs: readyAt - requestedAt,
          samplesMs: samplesAt - requestedAt,
          signalMs: signalAt - requestedAt,
        })
        writeFileSync(join(runDirectory, 'dictation-latency.json'), JSON.stringify(startupSamples, null, 2))
        if (attempt === 2) await verifyWidgetLevelUpdates(electron, runDirectory, checks)
        await target.evaluate(() => window.rememberDictation?.cancel())
        await waitStatus('idle')
      }
      checks.push(
        'Repeated dictation after cancellation measures command-to-ready and first-sample latency; recording readiness follows actual captured samples'
      )
    } finally {
      await electron.evaluate(() => {
        globalThis.qaDictationStartup = null
      })
      await target.evaluate((dictation) => window.remember.updateSettings({ dictation }), chosen)
    }
    await target.evaluate(() => window.rememberDictation?.refreshMicrophones())

    const wav = Array.from(readFileSync(wavPath))
    const transcripts = await electron.evaluate(async (_electron, wav) => {
      const start = Date.now()
      const conversation = await globalThis.qaSpeech(wav, 'conversation')
      const dictation = await globalThis.qaSpeech(wav, 'dictation')
      const silence = Buffer.from(wav.slice(0, 44))
      silence.writeUInt32LE(36 + 32000, 4)
      silence.writeUInt32LE(32000, 40)
      const empty = await globalThis.qaSpeech(Array.from(Buffer.concat([silence, Buffer.alloc(32000)])), 'dictation')
      const repeated = await globalThis.qaSpeech(wav, 'conversation')
      return { conversation, dictation, empty, repeated, elapsedMs: Date.now() - start }
    }, wav)
    const joined = (parts: TranscriptionResult[]) =>
      parts
        .map((part) => part.text)
        .filter(Boolean)
        .join(' ')
    assert.match(joined(transcripts.dictation).toLowerCase(), /planning/)
    assert.match(joined(transcripts.conversation).toLowerCase(), /planning/)
    assert.equal(joined(transcripts.empty), '')
    assert.equal(
      joined(transcripts.conversation),
      joined(transcripts.repeated),
      'Dictation must not contaminate conversation stream state'
    )
    for (const part of transcripts.conversation)
      for (const segment of part.segments) {
        assert(segment.startedAt >= 1000 && segment.endedAt > segment.startedAt)
        assert(segment.chunkIds.includes('qa-chunk'))
      }
    assert(
      transcripts.dictation.every((part) => part.language === null),
      'Do not invent language metadata Parakeet does not return'
    )
    writeFileSync(join(runDirectory, 'parakeet-transcripts.json'), JSON.stringify(transcripts, null, 2))
    checks.push(
      'Real shared Parakeet worker recognizes Dutch in both modes, preserves conversation timestamps and chunk provenance, suppresses silence, and isolates dictation state'
    )

    const widget = electron.windows().find((window) => window.url().includes('/edge-widget/'))
    assert(widget)
    await verifyDisplayFollowing(electron, widget, runDirectory, checks)
    await electron.evaluate(({ BrowserWindow }) => {
      const recorder = BrowserWindow.getAllWindows().find(
        (window) => window.getTitle() === 'Remember dictation recorder'
      )
      if (!recorder) throw new Error('Missing dictation recorder')
      globalThis.qaDictationSounds = { cues: [], audible: false }
      recorder.webContents.on('audio-state-changed', (event) => {
        if (event.audible) globalThis.qaDictationSounds.audible = true
      })
      const send = recorder.webContents.send.bind(recorder.webContents)
      recorder.webContents.send = (channel, ...args) => {
        if (channel === 'remember:dictation-recorder:command' && args[0]?.type === 'sound') {
          globalThis.qaDictationSounds.cues.push(args[0].cue)
        }
        send(channel, ...args)
      }
    })
    await target.evaluate(
      (dictation) => window.remember.updateSettings({ dictation: { ...dictation, soundsEnabled: true } }),
      chosen
    )
    await widget.locator('.edge-widget-handle').hover()
    const clipboardBeforeVoiceNote = await electron.evaluate(({ clipboard }) => clipboard.readText())
    await widget.getByRole('button', { name: 'Voice note', exact: true }).click()
    await waitStatus('recording')
    assert.equal(
      await electron.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((window) => window.getTitle() === 'Remember widget')
          ?.isFocused()
      ),
      false
    )
    await target.waitForTimeout(10_000)
    assert.equal(await widget.locator('.edge-widget-secondary:not([inert])').count(), 0)
    await widget.getByRole('button', { name: 'Cancel dictation', exact: true }).waitFor()
    await widget.screenshot({ path: join(runDirectory, 'dictation-recording.png') })
    await widget.getByRole('button', { name: 'Stop dictation', exact: true }).click()
    await waitStatus('done')
    let recorded = await dictation()
    assert.match(recorded.text.toLowerCase(), /planning/)
    assert.equal(recorded.result, null, 'Widget Voice note saves without insertion')
    assert.equal(await electron.evaluate(({ clipboard }) => clipboard.readText()), clipboardBeforeVoiceNote)
    assert.equal(await widget.locator('.edge-widget-dictation-status').count(), 0, 'Success has no copy message')
    await widget.screenshot({ path: join(runDirectory, 'dictation-result.png') })
    const sounds = await electron.evaluate(() => globalThis.qaDictationSounds)
    assert.deepEqual(sounds.cues, ['success', 'tap', 'success'])
    assert.equal(sounds.audible, true, 'The bundled sound engine must produce audible native Web Audio')
    writeFileSync(join(runDirectory, 'dictation-sounds.json'), JSON.stringify(sounds, null, 2))
    await target.evaluate((dictation) => window.remember.updateSettings({ dictation }), chosen)
    checks.push('Dictation emits start, stop, and success cues through audible native Web Audio')
    checks.push(
      'Native Voice note widget records WAV, hides the other controls, transcribes with Parakeet, preserves the clipboard and saves without automatic insertion or focus change'
    )

    const firstNotes = await target.evaluate(() => window.rememberDictation?.getHistory())
    assert.equal(firstNotes?.length, 1)
    const firstNote = firstNotes?.[0]
    assert(firstNote)
    assert.equal(firstNote.text, recorded.text)
    assert.equal(firstNote.status, 'completed')
    assert.equal(firstNote.hasAudio, true)
    await target.locator(`[data-note-id="${firstNote.id}"]`).getByText(recorded.text, { exact: true }).waitFor()
    await target
      .locator(`[data-note-id="${firstNote.id}"]`)
      .getByRole('button', { name: 'Copy note', exact: true })
      .click()
    assert.equal(await electron.evaluate(({ clipboard }) => clipboard.readText()), recorded.text)
    const downloaded = await target.evaluate(async (id) => {
      const audio = await window.rememberDictation?.downloadNote(id)
      return audio ? { length: audio.byteLength, header: Array.from(new Uint8Array(audio).slice(0, 4)) } : null
    }, firstNote.id)
    assert(downloaded && downloaded.length > 44)
    assert.deepEqual(downloaded.header, [82, 73, 70, 70])
    await target.getByRole('button', { name: /Dictate/ }).click()
    await waitStatus('recording')
    await target.waitForTimeout(6_000)
    await target.getByRole('button', { name: 'Stop recording', exact: true }).click()
    await waitStatus('done')
    recorded = await dictation()
    let notesBeforeRestart = await target.evaluate(() => window.rememberDictation?.getHistory())
    assert.equal(notesBeforeRestart?.length, 2)
    assert.equal(notesBeforeRestart?.[1].id, firstNote.id)
    await target.screenshot({ path: join(runDirectory, 'dictation-notes.png') })
    checks.push(
      'Notes records two real dictations in order, exposes stored audio, and copies a selected transcript through native IPC'
    )

    if (verifyInsertion) {
      assert.equal(
        recorded.accessibilityGranted,
        true,
        'Native insertion QA requires existing Accessibility permission'
      )
      await target.evaluate(
        (dictation) => window.remember.updateSettings({ dictation: { ...dictation, autoInsert: true } }),
        chosen
      )
      await target.evaluate(() => {
        const field = document.createElement('textarea')
        field.id = 'qa-dictation-target'
        field.setAttribute('aria-label', 'Dictation insertion target')
        document.body.append(field)
        field.focus()
      })
      const nativeFocus = async () => ({
        front: execFileSync('/usr/bin/lsappinfo', ['front'], { encoding: 'utf8' }).trim(),
        windows: await electron?.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().map((window) => ({
            title: window.getTitle(),
            focused: window.isFocused(),
            visible: window.isVisible(),
          }))
        ),
        focusedElement: await target.evaluate(() => document.activeElement?.id),
      })
      await target.evaluate(() => window.rememberDictation?.toggle())
      await waitStatus('recording')
      await target.waitForTimeout(6000)
      await electron.evaluate(({ app, BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find((window) => window.getTitle() === 'Remember')
        window?.show()
        app.focus({ steal: true })
        window?.focus()
      })
      await target.locator('#qa-dictation-target').focus()
      await eventually(async () =>
        Boolean((await nativeFocus()).windows?.some((window) => window.title === 'Remember' && window.focused))
      )
      writeFileSync(join(runDirectory, 'insertion-before.json'), JSON.stringify(await nativeFocus(), null, 2))
      await widget.getByRole('button', { name: 'Stop dictation', exact: true }).click()
      await waitStatus('done')
      writeFileSync(join(runDirectory, 'insertion-after.json'), JSON.stringify(await nativeFocus(), null, 2))
      await eventually(() =>
        target
          .locator('#qa-dictation-target')
          .inputValue()
          .then((value) => /planning/i.test(value))
      )
      recorded = await dictation()
      assert.equal(recorded.result, 'inserted')
      await target.evaluate((dictation) => window.remember.updateSettings({ dictation }), chosen)
      checks.push(
        'Native Cmd+V helper inserts the actual transcript into a focused text field while widget clicks preserve focus'
      )
    }

    await target.evaluate(() => window.rememberDictation?.cancel())
    await target.evaluate(() => {
      void window.rememberDictation?.toggle()
      return window.rememberDictation?.cancel()
    })
    await target.evaluate(() => window.rememberDictation?.toggle())
    await waitStatus('recording')
    await widget.getByRole('button', { name: 'Cancel dictation', exact: true }).click()
    await waitStatus('idle')
    checks.push(
      'Cancelling during microphone startup permits a fresh recording; the capsule cancel control returns it to idle'
    )

    const profile = await electron.evaluate(({ app }) => app.getPath('userData'))
    const model = join(profile, 'models', 'parakeet-tdt-0.6b-v3-int8')
    const offlineMode = (await target.evaluate(() => window.remember.getSettings())).offlineMode
    await target.evaluate(() => window.remember.updateSettings({ offlineMode: true }))
    await target.goto(`${new URL(target.url()).origin}/notes/`)
    const preparationCount = await electron.evaluate(() => globalThis.qaDictationModelPreparations ?? 0)
    renameSync(model, `${model}.held`)
    try {
      await target.evaluate(() => window.rememberDictation?.toggle())
      await waitStatus('error')
      assert.equal((await dictation()).error, 'model-required')
      assert.equal(
        await electron.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some((window) => window.getTitle() === 'Remember widget')
        ),
        false,
        'A missing model must keep the widget hidden even when dictation reports an error'
      )
      await target.getByRole('button', { name: 'Dictation preferences', exact: true }).click()
      await target
        .getByRole('dialog', { name: 'Dictation preferences', exact: true })
        .getByRole('heading', { name: 'Dictation preferences', exact: true })
        .waitFor()
      await target.screenshot({ path: join(runDirectory, 'dictation-model-required.png') })
      assert.equal(
        await electron.evaluate(() => globalThis.qaDictationModelPreparations ?? 0),
        preparationCount,
        'Opening preferences must not download the model'
      )
      await target.getByRole('button', { name: 'Download model', exact: true }).waitFor()
      assert.equal((await target.evaluate(() => window.remember.getSettings())).offlineMode, true)
    } finally {
      await target.evaluate(() => window.rememberDictation?.cancelModelPreparation())
      await eventually(async () => !(await dictation()).modelPreparing)
      rmSync(model, { recursive: true, force: true })
      renameSync(`${model}.held`, model)
      await target.evaluate((offlineMode) => window.remember.updateSettings({ offlineMode }), offlineMode)
    }
    checks.push(
      'Missing shared model keeps the widget hidden; Notes preferences offers model recovery without an automatic download'
    )

    await verifyHiddenWidgetDictation({ target, electron, runDirectory, checks })
    recorded = await dictation()
    const hiddenUntil = (await target.evaluate(() => window.remember.getSettings())).edgeWidgetHiddenUntil
    notesBeforeRestart = await target.evaluate(() => window.rememberDictation?.getHistory())
    await closeElectron()
    target = await launch()
    electron = getElectron()
    assert(electron)
    assert.deepEqual((await target.evaluate(() => window.remember.getSettings())).dictation, chosen)
    const restored = await dictation()
    assert.equal(restored.text, recorded.text)
    assert.equal(restored.status, 'idle')
    assert.equal(restored.shortcutRegistered, true)
    assert.equal((await target.evaluate(() => window.remember.getSettings())).edgeWidgetHiddenUntil, hiddenUntil)
    assert.equal(
      await electron.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.getTitle() === 'Remember widget')
      ),
      false
    )
    assert.deepEqual(await target.evaluate(() => window.rememberDictation?.getHistory()), notesBeforeRestart)
    checks.push(
      'Dictation preferences, custom global shortcut, last transcript, and widget snooze survive a full app restart'
    )
    await closeElectron()
    writeFileSync(join(profile, 'dictation', 'last-result.json'), JSON.stringify({ text: '', pending: true }))
    target = await launch()
    assert.equal((await dictation()).canRetry, true)
    assert.equal((await dictation()).status, 'error')
    await target.evaluate(() => window.rememberDictation?.retry())
    await waitStatus('done')
    assert.match((await dictation()).text, /planning/)
    assert.equal(
      (await dictation()).result,
      'copied',
      'Retry must copy without inserting into an unrelated foreground app'
    )
    checks.push(
      'A retained pending recording recovers after restart and retries through real Parakeet; retry copies the text without automatic insertion'
    )
    const allNotes = await target.evaluate(() => window.rememberDictation?.getHistory())
    assert.equal(allNotes?.length, (notesBeforeRestart?.length ?? 0) + 1)
    await target.evaluate((id) => window.rememberDictation?.deleteNote(id), firstNote.id)
    assert.equal(await target.evaluate((id) => window.rememberDictation?.downloadNote(id), firstNote.id), null)
    await closeElectron()
    target = await launch()
    const afterDelete = await target.evaluate(() => window.rememberDictation?.getHistory())
    assert.equal(
      afterDelete?.some((note) => note.id === firstNote.id),
      false
    )
    assert.equal(afterDelete?.length, notesBeforeRestart?.length)
    for (const note of afterDelete ?? [])
      await target.evaluate((id) => window.rememberDictation?.deleteNote(id), note.id)
    assert.deepEqual(await target.evaluate(() => window.rememberDictation?.getHistory()), [])
    assert.equal(existsSync(join(profile, 'dictation', 'last-recording.wav')), false)
    assert.equal(
      (JSON.parse(readFileSync(join(profile, 'dictation', 'last-result.json'), 'utf8')) as { text: string }).text,
      ''
    )
    checks.push(
      'Full history survives restart; deleting one note removes its audio and stays deleted after another restart'
    )

    await target.evaluate(
      (dictation) => window.remember.updateSettings({ dictation: { ...dictation, autoInsert: true } }),
      chosen
    )
    electron = getElectron()
    assert(electron)
    await target.goto(`${new URL(target.url()).origin}/assistant/`)
    const composer = target.getByRole('textbox', { name: 'Message to the agent', exact: true })
    await composer.waitFor()
    await composer.fill('Existing draft.')
    const clipboardBeforeComposer = await electron.evaluate(({ clipboard }) => clipboard.readText())
    const messagesBeforeComposer = (
      await target.evaluate(() => window.remember.getAssistantConversation())
    ).messages.map((message) => message.id)
    await target.getByRole('button', { name: 'Dictate', exact: true }).click()
    await waitStatus('recording')
    await target.waitForTimeout(6_000)
    await target.getByRole('button', { name: 'Stop dictation', exact: true }).click()
    await waitStatus('done')
    const composerResult = await dictation()
    await eventually(async () => (await composer.inputValue()) === `Existing draft. ${composerResult.text}`)
    assert.match(composerResult.text, /planning/)
    assert.equal(composerResult.result, null, 'Composer dictation must not paste into another focused app')
    assert.equal(await electron.evaluate(({ clipboard }) => clipboard.readText()), clipboardBeforeComposer)
    assert.deepEqual(
      (await target.evaluate(() => window.remember.getAssistantConversation())).messages.map((message) => message.id),
      messagesBeforeComposer,
      'Dictation must remain an unsent draft'
    )
    await target.screenshot({ path: join(runDirectory, 'agent-composer-dictation.png') })
    assert.equal((await target.evaluate(() => window.rememberDictation?.getHistory()))?.[0]?.text, composerResult.text)
    await target.evaluate((dictation) => window.remember.updateSettings({ dictation }), chosen)
    checks.push(
      'Agent composer records through real IPC and Parakeet, appends to its existing unsent draft, preserves the clipboard with auto-insert enabled, and retains the audio in Notes'
    )
  } finally {
    await getElectron()?.evaluate(({ clipboard }, text) => clipboard.writeText(text), originalClipboard)
  }
}
