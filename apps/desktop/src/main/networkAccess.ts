import { chmodSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { createNetworkRequestController } from './networkRequestController'
import { isRemoteNetworkRequest } from './offlineNetworkPolicy'
import { getSettings } from './settings'

export const OFFLINE_MODE_ERROR = 'offline-mode-enabled'

const networkRequests = createNetworkRequestController()
let forcedOffline = false
const networkAccessListeners = new Set<() => void>()

export function subscribeNetworkAccessChanges(listener: () => void) {
  networkAccessListeners.add(listener)
  return () => {
    networkAccessListeners.delete(listener)
  }
}

export function isOfflineMode() {
  return forcedOffline || getSettings().offlineMode
}

export function setForcedOfflineMode(enabled: boolean) {
  if (forcedOffline === enabled) return
  forcedOffline = enabled
  for (const listener of networkAccessListeners) listener()
}

export function requireNetworkAccess(signal?: AbortSignal) {
  if (isOfflineMode()) throw new Error(OFFLINE_MODE_ERROR)
  if (signal?.aborted) throw new Error('network-request-cancelled')
}

export function offlineModeSentinelPath() {
  return join(app.getPath('userData'), '.offline-mode')
}

export function syncOfflineModeSentinel(offlineMode: boolean) {
  const sentinelPath = offlineModeSentinelPath()
  if (!offlineMode) {
    rmSync(sentinelPath, { force: true })
    return
  }
  writeFileSync(sentinelPath, 'offline\n', { mode: 0o600 })
  chmodSync(sentinelPath, 0o600)
}

export function shouldBlockNetworkRequest(value: string) {
  return isOfflineMode() && isRemoteNetworkRequest(value)
}

export async function runNetworkRequest<T>(request: (signal: AbortSignal) => Promise<T>, timeoutMs?: number) {
  requireNetworkAccess()
  return networkRequests.run(request, timeoutMs)
}

export function cancelNetworkRequests() {
  networkRequests.cancel(new Error(OFFLINE_MODE_ERROR))
}
