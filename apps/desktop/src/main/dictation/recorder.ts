import { join } from 'node:path'
import { DICTATION_CHANNELS, type DictationRecorderCommand, type DictationRecorderEvent } from '@remember/shared'
import { BrowserWindow, ipcMain, session } from 'electron'

export function createDictationRecorder(onEvent: (event: DictationRecorderEvent) => void) {
  let window: BrowserWindow | null = null
  let ready = false
  let pending: DictationRecorderCommand | null = null
  let pendingSound: Extract<DictationRecorderCommand, { type: 'sound' }> | null = null
  let disposed = false
  const partition = 'persist:remember-dictation'
  const recorderSession = session.fromPartition(partition)
  const allowed = new Set(['media', 'audioCapture'])
  recorderSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(contents === window?.webContents && allowed.has(permission))
  })
  recorderSession.setPermissionCheckHandler(
    (contents, permission) => contents === window?.webContents && allowed.has(permission)
  )

  function ensureWindow() {
    if (window && !window.isDestroyed()) return window
    ready = false
    const current = new BrowserWindow({
      title: 'Remember dictation recorder',
      show: false,
      skipTaskbar: true,
      webPreferences: {
        preload: join(__dirname, '../preload/dictationRecorder.cjs'),
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    })
    window = current
    current.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    current.webContents.on('will-navigate', (event) => event.preventDefault())
    current.webContents.on('render-process-gone', () => {
      if (!current.isDestroyed()) current.destroy()
    })
    current.on('closed', () => {
      if (window !== current) return
      window = null
      ready = false
      pending = null
      pendingSound = null
      if (!disposed) onEvent({ type: 'error', sessionId: -1, message: 'Recorder closed' })
    })
    void current.loadFile(join(__dirname, '../../resources/dictation-recorder.html')).catch(() => current.destroy())
    return current
  }

  function send(command: DictationRecorderCommand) {
    const current = ensureWindow()
    if (command.type === 'cancel' && pending?.type === 'start' && pending.sessionId === command.sessionId)
      pending = null
    if (!ready) {
      if (command.type === 'start') pending = command
      if (command.type === 'sound') pendingSound = command
      return
    }
    current.webContents.send(DICTATION_CHANNELS.recorderCommand, command)
  }

  const listener = (event: Electron.IpcMainEvent, payload: DictationRecorderEvent) => {
    if (event.sender !== window?.webContents || !payload || typeof payload !== 'object') return
    if (payload.type === 'ready') {
      ready = true
      if (pending) {
        const command = pending
        pending = null
        send(command)
      }
      if (pendingSound) {
        const command = pendingSound
        pendingSound = null
        send(command)
      }
    }
    onEvent(payload)
  }
  ipcMain.on(DICTATION_CHANNELS.recorderEvent, listener)
  return {
    send,
    prewarm: ensureWindow,
    reset: () => {
      pending = null
      pendingSound = null
      const previous = window
      window = null
      ready = false
      previous?.destroy()
    },
    dispose: () => {
      disposed = true
      pendingSound = null
      ipcMain.removeListener(DICTATION_CHANNELS.recorderEvent, listener)
      window?.destroy()
      window = null
    },
  }
}
