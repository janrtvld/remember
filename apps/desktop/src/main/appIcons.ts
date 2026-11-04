import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { CHANNELS, type InstalledApp } from '@remember/shared'
import { app, ipcMain } from 'electron'

const MAX_APP_ICONS = 20
const MAX_ICON_BYTES = 512 * 1024
const ICON_TIMEOUT_MS = 3_000
const BUNDLE_ID_PATTERN = /^[a-zA-Z0-9._-]+$/
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const iconCache = new Map<string, Promise<string | null>>()
let installedAppsCache: Promise<InstalledApp[]> | null = null

export function registerAppIconIpc() {
  ipcMain.handle(CHANNELS.getAppIcons, async (_event, requestedBundleIds: unknown) => {
    if (!Array.isArray(requestedBundleIds)) return {}

    const bundleIds = Array.from(
      new Set(
        requestedBundleIds.filter(
          (bundleId): bundleId is string => typeof bundleId === 'string' && BUNDLE_ID_PATTERN.test(bundleId)
        )
      )
    ).slice(0, MAX_APP_ICONS)
    const entries = await Promise.all(
      bundleIds.map(async (bundleId) => [bundleId, await getAppIcon(bundleId)] as const)
    )

    return Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => entry[1] !== null))
  })
  ipcMain.handle(CHANNELS.listInstalledApps, () => listInstalledApps())
}

function listHelperPath() {
  const packaged = path.join(process.resourcesPath, 'app-list')
  if (app.isPackaged && existsSync(packaged)) return packaged
  return path.join(app.getAppPath(), 'native', 'app-list')
}

function listInstalledApps() {
  if (installedAppsCache) return installedAppsCache
  installedAppsCache = new Promise<InstalledApp[]>((resolve) => {
    const helper = listHelperPath()
    if (process.platform !== 'darwin' || !existsSync(helper)) {
      resolve([])
      return
    }
    execFile(helper, [], { encoding: 'utf8', timeout: 10_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        resolve([])
        return
      }
      try {
        const parsed = JSON.parse(stdout) as unknown
        if (!Array.isArray(parsed)) {
          resolve([])
          return
        }
        resolve(
          parsed
            .filter(
              (item): item is InstalledApp =>
                typeof item === 'object' &&
                item !== null &&
                typeof (item as InstalledApp).name === 'string' &&
                typeof (item as InstalledApp).bundleId === 'string'
            )
            .slice(0, 1_000)
        )
      } catch {
        resolve([])
      }
    })
  })
  return installedAppsCache
}

function helperPath() {
  const packaged = path.join(process.resourcesPath, 'app-icon')
  if (app.isPackaged && existsSync(packaged)) return packaged
  return path.join(app.getAppPath(), 'native', 'app-icon')
}

function loadAppIcon(bundleId: string) {
  if (process.platform !== 'darwin' || !existsSync(helperPath())) return Promise.resolve(null)

  return new Promise<string | null>((resolve) => {
    execFile(
      helperPath(),
      [bundleId],
      { encoding: 'utf8', timeout: ICON_TIMEOUT_MS, maxBuffer: MAX_ICON_BYTES },
      (error, stdout) => {
        if (error) {
          resolve(null)
          return
        }

        const encodedIcon = stdout.trim()
        const icon = Buffer.from(encodedIcon, 'base64')
        if (icon.length === 0 || !icon.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
          resolve(null)
          return
        }
        resolve(`data:image/png;base64,${encodedIcon}`)
      }
    )
  })
}

function getAppIcon(bundleId: string) {
  const cachedIcon = iconCache.get(bundleId)
  if (cachedIcon) return cachedIcon

  const icon = loadAppIcon(bundleId)
  iconCache.set(bundleId, icon)
  return icon
}
