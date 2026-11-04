export const GUARDED_NETWORK_PARTITIONS = ['sentry-electron', 'electron-updater'] as const

type RequestDetails = { url: string }
type RequestCallback = (response: { cancel: boolean }) => void

type GuardedSession = {
  webRequest: {
    onBeforeRequest: (listener: (details: RequestDetails, callback: RequestCallback) => void) => void
  }
  closeAllConnections: () => Promise<void>
}

export function installElectronNetworkPolicy(input: {
  defaultSession: GuardedSession
  fromPartition: (partition: string) => GuardedSession
  shouldBlock: (url: string) => boolean
}) {
  const remoteSessions = GUARDED_NETWORK_PARTITIONS.map((partition) => input.fromPartition(partition))
  const sessions = [input.defaultSession, ...remoteSessions]
  for (const guardedSession of sessions) {
    guardedSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: input.shouldBlock(details.url) })
    })
  }

  return {
    closeAllConnections: () =>
      Promise.allSettled(remoteSessions.map((guardedSession) => guardedSession.closeAllConnections())),
  }
}
