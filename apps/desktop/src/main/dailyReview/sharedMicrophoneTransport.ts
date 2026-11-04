import { join } from 'node:path'
import { BrowserWindow, ipcMain, session } from 'electron'
import { publishRecordingAudioLevel } from '../recordingAudioMeter'
import { pcmRms } from '../recordingAudioMeterCore'
import { prepareMicrophoneMode } from './microphoneMode'
import type { CreateMicrophoneTransport, MicrophoneMessage } from './sharedMicrophoneService'
import { StreamingMicrophoneWriter } from './streamingMicrophoneWriter'

const commandChannel = 'remember:microphone:command'
const eventChannel = 'remember:microphone:event'
const consumedChannel = 'remember:microphone:consumed'

export const createSharedMicrophoneTransport: CreateMicrophoneTransport = (onMessage, onFailure) => {
  let disposed = false
  let disposal: Promise<void> | null = null
  let failed = false
  let internalCommandId = 0
  let receivingAudio = false
  let lastAudioAt = performance.now()
  const captureSession = session.fromPartition('persist:remember-microphone')
  const window = new BrowserWindow({
    title: 'Remember microphone capture',
    show: false,
    skipTaskbar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/sharedMicrophone.cjs'),
      partition: 'persist:remember-microphone',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  })
  const allowed = new Set(['media', 'audioCapture'])
  captureSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(contents === window.webContents && allowed.has(permission))
  })
  captureSession.setPermissionCheckHandler(
    (contents, permission) => contents === window.webContents && allowed.has(permission)
  )
  const fail = (error: Error) => {
    if (disposed || failed) return
    failed = true
    // Deliver the valid prefix while the subscriber and transport generation
    // still exist. A failed Voice note remains an error, never a partial result.
    void writer.dispose(true).then(() => onFailure(error))
  }
  const send = (command: MicrophoneMessage) => {
    if (disposed || window.isDestroyed()) throw new Error('Microphone capture window closed')
    void writer.register(command)
    window.webContents.send(commandChannel, command)
  }
  const writer = new StreamingMicrophoneWriter(onMessage, fail, (sessionId) => {
    send({ type: 'dictation-stop', id: --internalCommandId, session_id: sessionId })
  })
  const listener = async (event: Electron.IpcMainEvent, message: MicrophoneMessage) => {
    if (disposed || failed || event.sender !== window.webContents || !message || typeof message !== 'object') return
    try {
      if (message.type === 'pcm' || message.type === 'boundary') {
        if (message.type === 'boundary') receivingAudio = message.route !== 'idle'
        lastAudioAt = performance.now()
        await writer.handle(message)
        if (failed || disposed) return
        if (message.type === 'pcm' && message.samples instanceof ArrayBuffer)
          publishRecordingAudioLevel('microphone', pcmRms(new Float32Array(message.samples, 0, Number(message.count))))
        if (message.type === 'pcm') window.webContents.send(consumedChannel, message.packet_id)
      } else if (message.type === 'error') {
        fail(new Error(String(message.message ?? 'Microphone capture failed')))
      } else {
        if (message.type === 'response' && typeof message.id === 'number') await writer.acknowledge(message.id)
        if (failed || disposed) return
        onMessage(message)
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
    }
  }
  ipcMain.on(eventChannel, listener)
  let lastWatchdogAt = performance.now()
  const audioWatchdog = setInterval(() => {
    const now = performance.now()
    const delayed = now - lastWatchdogAt > 2000
    lastWatchdogAt = now
    // A delayed main loop must drain queued PCM before diagnosing capture failure.
    if (delayed) return
    if (receivingAudio && now - lastAudioAt > 2000) fail(new Error('Microphone stopped delivering audio'))
  }, 1000)
  audioWatchdog.unref()
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('render-process-gone', () => fail(new Error('Microphone capture process failed')))
  window.on('closed', () => fail(new Error('Microphone capture window closed')))
  void prepareMicrophoneMode()
    .then(() => {
      if (!disposed && !window.isDestroyed())
        return window.loadFile(join(__dirname, '../../resources/microphone-capture.html'))
    })
    .catch(fail)
  return {
    send,
    dispose: () => {
      if (disposal) return disposal
      disposed = true
      clearInterval(audioWatchdog)
      ipcMain.removeListener(eventChannel, listener)
      disposal = (async () => {
        await writer.dispose()
        if (!window.isDestroyed()) {
          const closed = new Promise<void>((resolve) => window.once('closed', () => resolve()))
          window.destroy()
          await closed
        }
      })()
      return disposal
    },
  }
}
