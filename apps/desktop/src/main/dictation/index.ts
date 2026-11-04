import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DICTATION_CHANNELS,
  type DictationNote,
  type DictationRecorderEvent,
  type DictationState,
} from '@remember/shared'
import { type BrowserWindow, clipboard, globalShortcut, ipcMain, powerMonitor, systemPreferences } from 'electron'
import { suspendConversationMicrophone } from '../dailyReview'
import { getEvidenceStore } from '../dailyReview/evidenceRepository'
import { createSharedDictationCapture } from '../dailyReview/microphoneAudio'
import { getSettings, getSettingsHealth, subscribeSettingsChanges } from '../settings'
import {
  cancelDownload,
  downloadModel,
  downloadProgress,
  isModelDownloaded,
  modelPreparationPhase,
  subscribeModelPreparation,
} from '../voiceNotes/models'
import { transcribeDictation, warmTranscriber } from '../voiceNotes/transcribe'
import { createDictationHistory } from './history'
import { publishDictationHistoryChange, registerDictationHistorySource } from './historySource'
import { ensureMicrophoneAccess } from './microphonePermission'
import { accessibilityGranted, controlOutput, dictationDirectory, insertDictation } from './native'
import { createDictationRecorder } from './recorder'

let service: ReturnType<typeof createDictation> | null = null

export function getDictationState() {
  return service?.state() ?? null
}

export function onDictationStateChange(listener: (state: DictationState) => void) {
  return service?.subscribe(listener) ?? (() => undefined)
}

export async function toggleDictation() {
  await service?.toggle()
}

export async function toggleVoiceNote() {
  await service?.toggleVoiceNote()
}

export async function cancelDictation() {
  await service?.cancel()
}

export async function retryDictation() {
  await service?.retry()
}

export async function copyDictation() {
  await service?.copy()
}

export function completeDictationNote(id: string, transcript: string): DictationNote {
  if (!service) throw new Error('dictation-not-started')
  return service.completeNote(id, transcript)
}

export function startDictation(getMainWindow: () => BrowserWindow | null) {
  if (service) return
  service = createDictation(getMainWindow)
}

export async function disposeDictation() {
  await service?.dispose()
  service = null
}

function createDictation(getMainWindow: () => BrowserWindow | null) {
  let status: DictationState['status'] = 'idle'
  let error: DictationState['error'] = null
  let text = ''
  let result: DictationState['result'] = null
  let startedAt: number | null = null
  let level = 0
  let sessionId = 0
  let registeredShortcut: string | null = null
  let shortcutRecording = false
  let microphones: DictationState['microphones'] = []
  let releaseMicrophone: (() => void) | null = null
  let disposed = false
  let preparation = Promise.resolve()
  let outputDucking = Promise.resolve()
  let cleanup = Promise.resolve()
  let watchdog: ReturnType<typeof setTimeout> | null = null
  let permissionMonitor: ReturnType<typeof setInterval> | null = null
  let shortcutWatchdog: ReturnType<typeof setTimeout> | null = null
  let canRetry = false
  let activeNoteId: string | null = null
  let noteOnly = false
  let captureBackend: 'shared' | 'browser' | null = null
  const history = createDictationHistory(dictationDirectory())
  const listeners = new Set<(state: DictationState) => void>()
  const audioPath = join(dictationDirectory(), 'last-recording.wav')
  const resultPath = join(dictationDirectory(), 'last-result.json')
  let hasPriorNoteSources = true
  try {
    hasPriorNoteSources = getEvidenceStore().proactive.hasNoteSources()
  } catch (cause) {
    console.warn('[dictation] Previous Note source state unavailable', cause)
  }
  try {
    history.initialize({ hasPriorNoteSources })
  } catch (cause) {
    console.warn('[dictation] History unavailable', cause)
  }
  const removeHistoryChanges = history.subscribe(publishDictationHistoryChange)
  const removeHistorySource = registerDictationHistorySource(history.snapshot)
  try {
    const saved = JSON.parse(readFileSync(resultPath, 'utf8')) as {
      text?: unknown
      pending?: unknown
      noteId?: unknown
    }
    const notes = history.list()
    activeNoteId =
      notes.find((note) => note.id === saved.noteId)?.id ??
      (saved.noteId === undefined ? notes.find((note) => note.id === 'legacy')?.id : null) ??
      null
    if (typeof saved.text === 'string') text = saved.text
    canRetry = saved.pending === true && existsSync(audioPath)
    if (canRetry) {
      status = 'error'
      error = 'transcription'
    }
  } catch {
    // No previous dictation yet.
  }
  const recorder = createDictationRecorder(handleRecorderEvent)
  const sharedRecorder = createSharedDictationCapture(handleRecorderEvent)

  function prewarmSharedRecorder() {
    if (process.platform !== 'darwin' || systemPreferences.getMediaAccessStatus('microphone') !== 'granted') return
    void sharedRecorder
      .prewarm()
      .catch((cause) => console.warn('[dictation] Shared microphone preparation unavailable', cause))
  }

  function state(): DictationState {
    return {
      status,
      error,
      text,
      result,
      level,
      startedAt,
      canRetry,
      microphones,
      shortcutRegistered: registeredShortcut !== null,
      accessibilityGranted: accessibilityGranted(),
      modelReady: isModelDownloaded(),
      modelProgress: downloadProgress(),
      modelPreparing: modelPreparationPhase() !== null,
    }
  }

  function publish() {
    if (disposed) return
    const next = state()
    const window = getMainWindow()
    if (window && !window.isDestroyed()) window.webContents.send(DICTATION_CHANNELS.stateChanged, next)
    listeners.forEach((listener) => {
      listener(next)
    })
  }

  function publishHistory() {
    const window = getMainWindow()
    if (window && !window.isDestroyed()) window.webContents.send(DICTATION_CHANNELS.historyChanged, history.list())
  }

  function updateNote(patch: Parameters<typeof history.update>[1]) {
    if (!activeNoteId) return
    history.update(activeNoteId, patch)
    publishHistory()
  }

  function completeNote(id: string, transcript: string): DictationNote {
    if (disposed) throw new Error('dictation-disposed')
    if (typeof transcript !== 'string' || !transcript.trim()) throw new Error('dictation-empty-transcript')
    history.update(id, { text: transcript.trim(), status: 'completed', error: null })
    publishHistory()
    const note = history.find(id)
    if (!note) throw new Error('dictation-note-not-found')
    return note
  }

  function saveResult(pending: boolean) {
    mkdirSync(dictationDirectory(), { recursive: true })
    writeFileSync(resultPath, JSON.stringify({ text, pending, noteId: activeNoteId }), { mode: 0o600 })
  }

  function clearWatchdog() {
    if (watchdog) clearTimeout(watchdog)
    watchdog = null
  }

  function stopPermissionMonitor() {
    if (permissionMonitor) clearInterval(permissionMonitor)
    permissionMonitor = null
  }

  function releaseCapture() {
    cleanup = cleanup.then(async () => {
      await preparation
      await outputDucking
      await controlOutput('restore')
      releaseMicrophone?.()
      releaseMicrophone = null
    })
    return cleanup
  }

  function sound(kind: 'start' | 'stop' | 'done') {
    if (!getSettings().dictation.soundsEnabled) return
    const cues = { start: 'success', stop: 'tap', done: 'success' } as const
    recorder.send({ type: 'sound', cue: cues[kind] })
  }

  function applyShortcut() {
    if (registeredShortcut) globalShortcut.unregister(registeredShortcut)
    registeredShortcut = null
    const { enabled, shortcut } = getSettings().dictation
    if (disposed || shortcutRecording || !enabled || !shortcut || getSettingsHealth().status === 'recovery-required')
      return
    try {
      if (globalShortcut.register(shortcut, () => void toggle())) registeredShortcut = shortcut
    } catch (error) {
      console.warn('[dictation] Could not register shortcut', error)
    }
  }

  async function fail(reason: NonNullable<DictationState['error']>) {
    clearWatchdog()
    stopPermissionMonitor()
    sharedRecorder.cancel(sessionId)
    captureBackend = null
    recorder.reset()
    sessionId++
    status = 'error'
    error = reason
    level = 0
    if (activeNoteId && history.find(activeNoteId)?.status === 'processing')
      updateNote({ status: 'failed', error: reason })
    publish()
    await releaseCapture()
    publish()
    if (!disposed) recorder.prewarm()
  }

  async function toggle(saveOnly = false) {
    if (disposed || getSettingsHealth().status === 'recovery-required') return
    if (status === 'recording') {
      stopPermissionMonitor()
      status = 'transcribing'
      level = 0
      if (captureBackend === 'shared') sharedRecorder.stop(sessionId)
      else recorder.send({ type: 'stop', sessionId })
      sound('stop')
      publish()
      const current = sessionId
      clearWatchdog()
      watchdog = setTimeout(() => {
        if (current === sessionId && status === 'transcribing') void fail('recording')
      }, 10_000)
      return
    }
    if (status === 'starting' || status === 'transcribing') return
    if (!isModelDownloaded()) {
      error = 'model-required'
      status = 'error'
      publish()
      return
    }
    const current = ++sessionId
    noteOnly = saveOnly
    activeNoteId = null
    canRetry = false
    status = 'starting'
    error = null
    result = null
    startedAt = null
    publish()
    await cleanup
    if (current !== sessionId || disposed) return
    clearWatchdog()
    watchdog = setTimeout(() => {
      if (current === sessionId && status === 'starting') void fail('microphone')
    }, 15_000)
    preparation = (async () => {
      try {
        if (process.platform === 'darwin' && !(await ensureMicrophoneAccess(systemPreferences))) {
          throw new Error('microphone')
        }
        if (current !== sessionId || disposed) return
        const preferences = getSettings().dictation
        let sharedStarted = false
        // When the system default already matches the shared microphone,
        // playback cannot change the selected input. Avoid another helper launch.
        if (!preferences.microphoneId && sharedRecorder.defaultInputSelected()) {
          captureBackend = 'shared'
          sharedStarted = await sharedRecorder.start({ sessionId: current, forceBuiltInMicrophone: false })
        }
        if (current !== sessionId || disposed) return
        if (!sharedStarted) {
          const playing = preferences.forceBuiltInMicWhenAudioPlaying ? await controlOutput('playing') : 'idle'
          if (current !== sessionId || disposed) return
          captureBackend = 'shared'
          sharedStarted = await sharedRecorder.start({
            sessionId: current,
            microphoneId: preferences.microphoneId,
            microphoneLabel: microphones.find((microphone) => microphone.id === preferences.microphoneId)?.label,
            forceBuiltInMicrophone: playing === 'playing',
          })
          if (current !== sessionId || disposed) return
          if (!sharedStarted) {
            captureBackend = 'browser'
            releaseMicrophone = await suspendConversationMicrophone()
            if (current !== sessionId || disposed) return
            recorder.send({
              type: 'start',
              sessionId: current,
              microphoneId: preferences.microphoneId,
              forceBuiltInMicrophone: playing === 'playing',
            })
          }
        }
        // Retain audio while media dimming finishes; cleanup must restore only after it settles.
        outputDucking = preferences.dimMediaDuringRecording
          ? controlOutput('duck').then(() => undefined)
          : Promise.resolve()
      } catch (cause) {
        if (current === sessionId) {
          console.error('[dictation] Could not start recording', cause)
          // Finish preparation before cleanup awaits it.
          queueMicrotask(() => void fail('microphone'))
        }
      }
    })()
    await preparation
  }

  async function cancel(preservePending = false) {
    stopPermissionMonitor()
    sharedRecorder.cancel(sessionId)
    captureBackend = null
    sessionId++
    clearWatchdog()
    recorder.reset()
    status = 'idle'
    error = null
    startedAt = null
    level = 0
    if (activeNoteId && history.find(activeNoteId)?.status === 'processing') {
      if (preservePending) updateNote({ status: 'failed', error: 'interrupted' })
      else {
        history.remove(activeNoteId)
        activeNoteId = null
        publishHistory()
      }
    }
    if (canRetry && !preservePending) {
      canRetry = false
      try {
        saveResult(false)
        rmSync(audioPath, { force: true })
      } catch (cause) {
        console.warn('[dictation] Could not clear cancelled recording', cause)
      }
    }
    publish()
    await releaseCapture()
    publish()
    if (!disposed) recorder.prewarm()
  }

  async function transcribe(wav: Buffer, current: number, autoInsert: boolean | null) {
    try {
      const transcript = await transcribeDictation(wav)
      if (current !== sessionId || disposed) return
      if (!transcript.text.trim()) {
        status = 'error'
        error = 'no-speech'
        updateNote({ status: 'failed', error: 'no-speech' })
        publish()
        return
      }
      if (!activeNoteId) throw new Error('dictation-note-not-found')
      text = completeNote(activeNoteId, transcript.text).text
      saveResult(false)
      canRetry = false
      result = autoInsert === null ? null : await insertDictation(text, autoInsert)
      if (current !== sessionId || disposed) return
      status = 'done'
      error = null
      sound('done')
      publish()
      clearWatchdog()
      watchdog = setTimeout(() => {
        if (current !== sessionId || status !== 'done') return
        status = 'idle'
        publish()
      }, 4000)
    } catch (cause) {
      if (current !== sessionId || disposed) return
      console.error('[dictation] Transcription failed', cause)
      status = 'error'
      error = 'transcription'
      updateNote({ status: 'failed', error: 'transcription' })
      publish()
    }
  }

  async function receiveAudio(wav: ArrayBuffer, current: number, durationMs: number) {
    stopPermissionMonitor()
    clearWatchdog()
    status = 'transcribing'
    level = 0
    publish()
    await releaseCapture()
    if (current !== sessionId || disposed) return
    try {
      const audio = Buffer.from(wav)
      if (audio.length < 44 || audio.length > 60_000_000) throw new Error('Invalid recording size')
      mkdirSync(dictationDirectory(), { recursive: true })
      writeFileSync(audioPath, audio, { mode: 0o600 })
      activeNoteId = history.add(audio, startedAt ?? Date.now(), durationMs).id
      text = ''
      saveResult(true)
      canRetry = true
      publishHistory()
      await transcribe(audio, current, noteOnly ? null : getSettings().dictation.autoInsert)
    } catch (cause) {
      console.error('[dictation] Could not retain recording', cause)
      if (current === sessionId) await fail('recording')
    }
  }

  function handleRecorderEvent(event: DictationRecorderEvent) {
    if (event.type === 'devices') {
      microphones = Array.isArray(event.devices)
        ? event.devices.filter((device) => typeof device?.id === 'string' && typeof device.label === 'string')
        : []
      publish()
      return
    }
    if (event.type === 'ready' || disposed) return
    if (event.type === 'error' && event.sessionId === -1) {
      if (captureBackend === 'browser' && (status === 'starting' || status === 'recording')) void fail('recording')
      else if (captureBackend === 'shared') recorder.prewarm()
      return
    }
    if (event.sessionId !== sessionId) return
    if (event.type === 'started' && status === 'starting') {
      clearWatchdog()
      startedAt = event.startedAt
      status = 'recording'
      if (captureBackend === 'shared') {
        stopPermissionMonitor()
        permissionMonitor = setInterval(() => {
          if (status === 'recording' && systemPreferences.getMediaAccessStatus('microphone') !== 'granted')
            void fail('microphone')
        }, 5000)
        permissionMonitor.unref()
      }
      sound('start')
      publish()
      // Forking/loading the recognizer must never precede microphone capture.
      warmTranscriber()
    } else if (event.type === 'level' && status === 'recording') {
      level = Math.max(0, Math.min(1, Number(event.level) || 0))
      publish()
    } else if (event.type === 'result' && (status === 'recording' || status === 'transcribing')) {
      void receiveAudio(event.wav, sessionId, Math.max(0, Number(event.durationMs) || 0))
    } else if (
      event.type === 'error' &&
      (status === 'starting' || status === 'recording' || status === 'transcribing')
    ) {
      console.error('[dictation] Recorder failed', event.message)
      void fail('recording')
    }
  }

  async function retry() {
    if (!canRetry || !['idle', 'done', 'error'].includes(status)) return
    if (activeNoteId) return retryNote(activeNoteId)
    if (!isModelDownloaded()) return fail('model-required')
    status = 'transcribing'
    error = null
    publish()
    const current = ++sessionId
    try {
      const audio = readFileSync(audioPath)
      activeNoteId = history.add(audio, Date.now(), 0).id
      saveResult(true)
      publishHistory()
      await transcribe(audio, current, false)
    } catch {
      await fail('recording')
    }
  }

  async function retryNote(id: string) {
    if (!['idle', 'done', 'error'].includes(status)) throw new Error('dictation-busy')
    const note = history.find(id)
    const audio = history.audio(id)
    if (!note || !audio) throw new Error('dictation-audio-unavailable')
    if (!isModelDownloaded()) return fail('model-required')
    clearWatchdog()
    const current = ++sessionId
    activeNoteId = id
    startedAt = note.createdAt
    text = note.text
    canRetry = true
    result = null
    writeFileSync(audioPath, audio, { mode: 0o600 })
    saveResult(true)
    updateNote({ status: 'processing', error: null })
    status = 'transcribing'
    error = null
    publish()
    await transcribe(audio, current, false)
  }

  async function deleteNote(id: string) {
    const note = history.find(id)
    if (!note) return
    if (['starting', 'recording', 'transcribing'].includes(status)) throw new Error('dictation-busy')
    const saved = existsSync(resultPath) ? (JSON.parse(readFileSync(resultPath, 'utf8')) as { noteId?: string }) : null
    const isLastResult = saved?.noteId === id || (id === 'legacy' && saved?.noteId === undefined)
    if (id === activeNoteId || isLastResult) {
      await cancel()
      activeNoteId = null
      text = ''
      rmSync(audioPath, { force: true })
      saveResult(false)
      publish()
    }
    history.remove(id)
    publishHistory()
  }

  async function prepareModel() {
    try {
      await downloadModel(publish)
      if (isModelDownloaded()) {
        warmTranscriber()
        error = null
        if (status === 'error') status = 'idle'
      }
    } catch (cause) {
      if ((cause as Error)?.message !== 'cancelled') {
        error = 'download'
        console.error('[dictation] Model preparation failed', cause)
      }
    }
    publish()
  }

  const actions = {
    getHistory: history.list,
    retryNote,
    deleteNote,
    copyNote: async (id: string) => {
      const note = history.find(id)
      if (note?.text) await clipboard.writeText(note.text)
    },
    downloadNote: (id: string) => {
      const audio = history.audio(id)
      return audio ? Uint8Array.from(audio).buffer : null
    },
    getState: state,
    toggle: (target: unknown) => {
      if (target !== undefined && target !== 'composer') throw new Error('invalid-dictation-target')
      return toggle(target === 'composer')
    },
    cancel,
    retry,
    copy: async () => {
      if (text) await clipboard.writeText(text)
    },
    prepareModel,
    cancelModelPreparation: () => {
      cancelDownload()
      publish()
    },
    requestAccessibility: () => {
      const granted = process.platform === 'darwin' && systemPreferences.isTrustedAccessibilityClient(true)
      publish()
      return granted
    },
    refreshMicrophones: () => recorder.send({ type: 'devices' }),
    setShortcutRecording: (recording: boolean) => {
      if (typeof recording !== 'boolean') throw new Error('invalid-shortcut-recording-state')
      if (shortcutWatchdog) clearTimeout(shortcutWatchdog)
      shortcutRecording = recording
      if (recording)
        shortcutWatchdog = setTimeout(() => {
          shortcutRecording = false
          applyShortcut()
          publish()
        }, 60_000)
      applyShortcut()
      publish()
    },
  }
  for (const [name, action] of Object.entries(actions)) {
    ipcMain.handle(DICTATION_CHANNELS[name as keyof typeof actions], (event, argument: unknown) => {
      if (event.sender !== getMainWindow()?.webContents) throw new Error('dictation-sender-required')
      return (action as (argument: unknown) => unknown)(argument)
    })
  }
  const removeSettings = subscribeSettingsChanges(() => {
    applyShortcut()
    if (!getSettings().dictation.dimMediaDuringRecording) void controlOutput('restore')
    publish()
  })
  const removeModelPreparation = subscribeModelPreparation(publish)
  const onSuspend = () => void cancel()
  powerMonitor.on('suspend', onSuspend)
  void controlOutput('restore')
  applyShortcut()
  recorder.prewarm()
  prewarmSharedRecorder()

  return {
    state,
    completeNote,
    toggle,
    toggleVoiceNote: () => toggle(true),
    cancel,
    retry,
    copy: actions.copy,
    subscribe: (listener: (state: DictationState) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose: async () => {
      disposed = true
      removeHistorySource()
      removeHistoryChanges()
      await cancel(true)
      removeSettings()
      removeModelPreparation()
      if (shortcutWatchdog) clearTimeout(shortcutWatchdog)
      if (registeredShortcut) globalShortcut.unregister(registeredShortcut)
      powerMonitor.removeListener('suspend', onSuspend)
      for (const name of Object.keys(actions)) ipcMain.removeHandler(DICTATION_CHANNELS[name as keyof typeof actions])
      recorder.dispose()
      sharedRecorder.dispose()
      listeners.clear()
    },
  }
}
