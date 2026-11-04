import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { CHANNELS } from '@remember/shared'
import { app, BrowserWindow, ipcMain, nativeImage, screen, shell } from 'electron'
import { readContextPermissions } from './dailyReview/context'

type PermissionGuideOptions = {
  getRendererBaseUrl: () => string | null
  onPermissionGranted: () => Promise<void>
}

type WindowBounds = {
  x: number
  y: number
  width: number
  height: number
}

const GUIDE_WIDTH = 500
const GUIDE_HEIGHT = 190
const SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
const WINDOW_LOOKUP_TIMEOUT_MS = 1_000
const MAX_POSITION_ATTEMPTS = 12
const GUIDE_HORIZONTAL_OFFSET = -6
const SETTINGS_POLL_INTERVAL_MS = 250
const COMPLETION_DELAY_MS = 100

let permissionGuideWindow: BrowserWindow | null = null
let positionTimer: ReturnType<typeof setTimeout> | null = null
let permissionCompletionHandled = false

export function registerPermissionGuideIpc({ getRendererBaseUrl, onPermissionGranted }: PermissionGuideOptions) {
  ipcMain.handle(CHANNELS.showAccessibilityPermissionGuide, async () => {
    if (process.platform !== 'darwin') return

    await shell.openExternal(SETTINGS_URL)
    const rendererBaseUrl = getRendererBaseUrl()
    if (!rendererBaseUrl) return
    const settingsBounds = await waitForSystemSettingsWindow()
    showPermissionGuide(rendererBaseUrl, settingsBounds)
  })

  ipcMain.handle(CHANNELS.getAccessibilityPermissionStatus, async () => {
    const isGranted = process.platform !== 'darwin' || (await readContextPermissions()).accessibility === 'granted'
    if (isGranted && !permissionCompletionHandled) {
      permissionCompletionHandled = true
      setTimeout(() => void completePermissionGuide(onPermissionGranted), COMPLETION_DELAY_MS)
    }
    return isGranted
  })

  ipcMain.on(CHANNELS.closePermissionGuide, (event) => {
    if (event.sender !== permissionGuideWindow?.webContents) return
    closePermissionGuide()
  })

  ipcMain.on(CHANNELS.startPermissionGuideDrag, (event, previewDataUrl: unknown) => {
    if (event.sender !== permissionGuideWindow?.webContents) return
    const bundlePath = applicationBundlePath()
    event.sender.startDrag({
      file: bundlePath,
      icon: dragPreview(previewDataUrl) ?? dragIcon(bundlePath),
    })
  })
}

async function completePermissionGuide(onPermissionGranted: () => Promise<void>) {
  closePermissionGuide()
  await closeSystemSettings()
  try {
    await onPermissionGranted()
  } catch (error) {
    console.error('[permission-guide] could not finish accessibility setup', error)
  }
}

export function closePermissionGuide() {
  clearPositionTimer()
  if (!permissionGuideWindow || permissionGuideWindow.isDestroyed()) {
    permissionGuideWindow = null
    return
  }
  permissionGuideWindow.close()
  permissionGuideWindow = null
}

function showPermissionGuide(rendererBaseUrl: string, settingsBounds: WindowBounds | null) {
  permissionCompletionHandled = false
  if (permissionGuideWindow && !permissionGuideWindow.isDestroyed()) {
    permissionGuideWindow.showInactive()
    if (settingsBounds) positionOverBounds(settingsBounds)
    else positionOverSystemSettings()
    return
  }

  permissionGuideWindow = new BrowserWindow({
    width: GUIDE_WIDTH,
    height: GUIDE_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  permissionGuideWindow.setAlwaysOnTop(true, 'floating')
  if (settingsBounds) positionOverBounds(settingsBounds)
  else positionOnCurrentDisplay()
  permissionGuideWindow.once('ready-to-show', () => {
    permissionGuideWindow?.showInactive()
    if (!settingsBounds) positionOverSystemSettings()
  })
  permissionGuideWindow.on('closed', () => {
    clearPositionTimer()
    permissionGuideWindow = null
  })
  void permissionGuideWindow.loadURL(new URL('/permission-overlay/', rendererBaseUrl).toString())
}

function positionOnCurrentDisplay() {
  if (!permissionGuideWindow || permissionGuideWindow.isDestroyed()) return
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const x = Math.round(display.workArea.x + (display.workArea.width - GUIDE_WIDTH) / 2)
  const y = Math.round(display.workArea.y + display.workArea.height * 0.58)
  permissionGuideWindow.setPosition(x, y, false)
}

function positionOverSystemSettings(attempt = 0) {
  readSystemSettingsBounds().then((bounds) => {
    if (!permissionGuideWindow || permissionGuideWindow.isDestroyed()) return
    if (!bounds) {
      if (attempt < MAX_POSITION_ATTEMPTS) {
        positionTimer = setTimeout(() => positionOverSystemSettings(attempt + 1), SETTINGS_POLL_INTERVAL_MS)
      }
      return
    }
    positionOverBounds(bounds)
  })
}

function positionOverBounds(bounds: WindowBounds) {
  if (!permissionGuideWindow || permissionGuideWindow.isDestroyed()) return
  const sidebarWidth = Math.min(320, Math.round(bounds.width * 0.33))
  const contentWidth = bounds.width - sidebarWidth
  const x = Math.round(bounds.x + sidebarWidth + (contentWidth - GUIDE_WIDTH) / 2 + GUIDE_HORIZONTAL_OFFSET)
  const y = Math.round(bounds.y + bounds.height - GUIDE_HEIGHT - 28)
  permissionGuideWindow.setPosition(x, y, true)
}

async function waitForSystemSettingsWindow() {
  for (let attempt = 0; attempt <= MAX_POSITION_ATTEMPTS; attempt += 1) {
    const bounds = await readSystemSettingsBounds()
    if (bounds) return bounds
    if (attempt < MAX_POSITION_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, SETTINGS_POLL_INTERVAL_MS))
    }
  }
  return null
}

function readSystemSettingsBounds() {
  if (process.platform !== 'darwin' || !existsSync(windowHelperPath())) {
    return Promise.resolve<WindowBounds | null>(null)
  }

  return new Promise<WindowBounds | null>((resolve) => {
    execFile(
      windowHelperPath(),
      [],
      { encoding: 'utf8', timeout: WINDOW_LOOKUP_TIMEOUT_MS, maxBuffer: 4_096 },
      (error, stdout) => {
        if (error) {
          resolve(null)
          return
        }

        try {
          const bounds = JSON.parse(stdout) as WindowBounds
          resolve([bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ? bounds : null)
        } catch {
          resolve(null)
        }
      }
    )
  })
}

function clearPositionTimer() {
  if (!positionTimer) return
  clearTimeout(positionTimer)
  positionTimer = null
}

function windowHelperPath() {
  const packaged = path.join(process.resourcesPath, 'system-settings-window')
  if (app.isPackaged && existsSync(packaged)) return packaged
  return path.join(app.getAppPath(), 'native', 'system-settings-window')
}

function closeSystemSettings() {
  if (process.platform !== 'darwin' || !existsSync(windowHelperPath())) return Promise.resolve()

  return new Promise<void>((resolve) => {
    execFile(windowHelperPath(), ['--close'], { timeout: WINDOW_LOOKUP_TIMEOUT_MS }, () => resolve())
  })
}

function applicationBundlePath() {
  let candidate = process.execPath
  while (candidate !== path.dirname(candidate)) {
    if (path.extname(candidate) === '.app') return candidate
    candidate = path.dirname(candidate)
  }
  return process.execPath
}

function dragIcon(bundlePath: string) {
  const bundleIcon = nativeImage.createFromPath(path.join(bundlePath, 'Contents', 'Resources', 'icon.icns'))
  if (!bundleIcon.isEmpty()) return bundleIcon.resize({ width: 64, height: 64 })

  const developmentIcon = nativeImage.createFromPath(path.join(app.getAppPath(), 'packaging', 'icon-source.png'))
  return developmentIcon.resize({ width: 64, height: 64 })
}

function dragPreview(value: unknown) {
  if (typeof value !== 'string') return null
  const encoded = value.match(/^data:image\/png;base64,(.+)$/)?.[1]
  if (!encoded) return null

  const image = nativeImage.createFromBuffer(Buffer.from(encoded, 'base64'), { scaleFactor: 2 })
  return image.isEmpty() ? null : image
}
