import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { UpdateState } from '@remember/shared'
import { CHANNELS } from '@remember/shared'
import { app, BrowserWindow, ipcMain } from 'electron'
import electronUpdater from 'electron-updater'
import { isOfflineMode } from './networkAccess'
import { getSettings } from './settings'
import { createUpdateState, reduceUpdateState, type UpdateAvailability } from './updaterState'

const { autoUpdater, CancellationToken } = electronUpdater
const INITIAL_CHECK_DELAY_MS = 10_000
const AUTOMATIC_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000

let state = createUpdateState('0.0.0', 'development')
let activeOperation: Promise<void> | null = null
let activeStage: 'check' | 'download' | null = null
let prepareToQuitForUpdate: ((install: () => void) => void) | null = null
let restartRequested = false
let activeCancellationToken: { cancel: () => void } | null = null
const stateListeners = new Set<(state: UpdateState) => void>()

function updateAvailability(): UpdateAvailability {
  if (!app.isPackaged) return 'development'
  if (!existsSync(join(process.resourcesPath, 'app-update.yml'))) return 'unconfigured'
  return 'supported'
}

function emit() {
  for (const listener of stateListeners) listener(state)
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(CHANNELS.updateStateChanged, state)
  }
}

function transition(event: Parameters<typeof reduceUpdateState>[1]) {
  state = reduceUpdateState(state, event)
  emit()
}

function failActiveOperation(stage: 'check' | 'download', error: unknown) {
  if (isOfflineMode()) {
    if (state.status !== 'downloaded') transition({ type: 'cancelled' })
    return
  }
  console.error(`[updater] ${stage} failed`, error)
  if (state.status !== 'error') transition({ type: 'failed', stage })
}

async function runOperation(stage: 'check' | 'download', operation: () => Promise<unknown>) {
  if (activeOperation) {
    await activeOperation
    return state
  }

  activeStage = stage
  activeOperation = (async () => {
    try {
      await operation()
    } catch (error) {
      failActiveOperation(activeStage ?? stage, error)
    } finally {
      activeOperation = null
      activeStage = null
    }
  })()
  await activeOperation
  return state
}

async function runUpdateCheck() {
  if (isOfflineMode()) return state
  if (state.availability !== 'supported') return state
  if (!['idle', 'up-to-date', 'error'].includes(state.status) || state.errorStage === 'download') return state

  transition({ type: 'check-started' })
  return runOperation('check', async () => {
    const result = await autoUpdater.checkForUpdates()
    activeCancellationToken = result?.cancellationToken ?? null
    if (isOfflineMode()) activeCancellationToken?.cancel()
    try {
      await result?.downloadPromise
    } finally {
      activeCancellationToken = null
    }
  })
}

export async function downloadUpdate() {
  if (isOfflineMode()) return state
  const canDownload = state.status === 'available' || (state.status === 'error' && state.errorStage === 'download')
  if (!canDownload) return state

  transition({ type: 'download-started' })
  return runOperation('download', async () => {
    const cancellationToken = new CancellationToken()
    activeCancellationToken = cancellationToken
    try {
      await autoUpdater.downloadUpdate(cancellationToken)
    } finally {
      if (activeCancellationToken === cancellationToken) activeCancellationToken = null
    }
  })
}

export function registerUpdater({ prepareToQuit }: { prepareToQuit: (install: () => void) => void }) {
  state = createUpdateState(app.getVersion(), updateAvailability())
  prepareToQuitForUpdate = prepareToQuit

  autoUpdater.autoDownload = getSettings().automaticUpdates && !isOfflineMode()
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false
  autoUpdater.channel = 'latest'

  autoUpdater.on('checking-for-update', () => {
    if (state.status !== 'checking') transition({ type: 'check-started' })
  })
  autoUpdater.on('update-not-available', () => transition({ type: 'update-not-available' }))
  autoUpdater.on('update-available', (info) => {
    transition({ type: 'update-available', version: info.version })
    if (!autoUpdater.autoDownload || isOfflineMode()) return
    activeStage = 'download'
    transition({ type: 'download-started' })
  })
  autoUpdater.on('download-progress', (progress) =>
    transition({ type: 'download-progress', progress: progress.percent / 100 })
  )
  autoUpdater.on('update-downloaded', (info) => transition({ type: 'update-downloaded', version: info.version }))
  autoUpdater.on('update-cancelled', () => {
    if (state.status !== 'downloaded') transition({ type: 'cancelled' })
  })
  autoUpdater.on('error', (error) => failActiveOperation(activeStage ?? 'check', error))

  ipcMain.handle(CHANNELS.updateGetState, () => state)
  ipcMain.handle(CHANNELS.updateCheck, () => runUpdateCheck())
  ipcMain.handle(CHANNELS.updateDownload, () => downloadUpdate())
  ipcMain.handle(CHANNELS.updateRestart, () => restartToUpdate())

  if (state.availability === 'supported') {
    setTimeout(() => {
      if (getSettings().automaticUpdates && !isOfflineMode()) void runUpdateCheck()
    }, INITIAL_CHECK_DELAY_MS).unref()
    setInterval(() => {
      if (getSettings().automaticUpdates && !isOfflineMode()) void runUpdateCheck()
    }, AUTOMATIC_CHECK_INTERVAL_MS).unref()
  }
}

export function applyAutomaticUpdatePolicy(enabled: boolean) {
  const canUseNetwork = enabled && !isOfflineMode()
  autoUpdater.autoDownload = canUseNetwork
  if (!canUseNetwork) {
    activeCancellationToken?.cancel()
    if (state.status === 'downloading') transition({ type: 'cancelled' })
  }
  if (canUseNetwork && state.status === 'available') void downloadUpdate()
}

export function applyOfflineUpdatePolicy(offline: boolean) {
  const enabled = getSettings().automaticUpdates && !offline
  autoUpdater.autoDownload = enabled
  if (offline) {
    activeCancellationToken?.cancel()
    if (state.status === 'checking' || state.status === 'downloading') transition({ type: 'cancelled' })
  }
  if (!enabled) return
  if (state.status === 'available') void downloadUpdate()
  else void runUpdateCheck()
}

export function checkForUpdates(): Promise<UpdateState> {
  return runUpdateCheck()
}

export function getUpdateState() {
  return state
}

export function onUpdateStateChange(listener: (state: UpdateState) => void) {
  stateListeners.add(listener)
  return () => stateListeners.delete(listener)
}

export function restartToUpdate() {
  if (state.status !== 'downloaded' || !prepareToQuitForUpdate) return false
  if (restartRequested) return true
  restartRequested = true
  prepareToQuitForUpdate(() => autoUpdater.quitAndInstall(false, true))
  return true
}
