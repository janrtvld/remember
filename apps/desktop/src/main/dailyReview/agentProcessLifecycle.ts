import type { ChildProcess } from 'node:child_process'

const DEFAULT_GRACE_PERIOD_MS = 2_000
const POLL_INTERVAL_MS = 50

type AgentProcess = {
  pid?: ChildProcess['pid']
  once: (event: 'error' | 'exit', listener: () => void) => unknown
}

type ProcessGroupOperations = {
  signal: (processId: number, signal: NodeJS.Signals) => boolean
  isRunning: (processId: number) => boolean
  now: () => number
  wait: (durationMs: number) => Promise<void>
}

function signalProcessGroup(processId: number, signal: NodeJS.Signals) {
  try {
    process.kill(process.platform === 'win32' ? processId : -processId, signal)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    return true
  }
}

function isProcessGroupRunning(processId: number) {
  try {
    process.kill(process.platform === 'win32' ? processId : -processId, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

const defaultOperations: ProcessGroupOperations = {
  signal: signalProcessGroup,
  isRunning: isProcessGroupRunning,
  now: Date.now,
  wait: (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)),
}

export function createAgentProcessController(operations = defaultOperations) {
  const activeProcessIds = new Set<number>()
  const activeCancellations = new Set<() => void>()
  let isShuttingDown = false
  let cancelPromise: Promise<void> | null = null
  let shutdownPromise: Promise<void> | null = null

  const track = <T extends AgentProcess>(child: T, options: { retainProcessGroup?: boolean } = {}) => {
    const processId = child.pid
    if (processId == null) return child
    if (isShuttingDown) {
      operations.signal(processId, 'SIGTERM')
      return child
    }

    activeProcessIds.add(processId)
    const release = () => {
      if (!options.retainProcessGroup || !operations.isRunning(processId)) activeProcessIds.delete(processId)
    }
    child.once('error', release)
    child.once('exit', release)
    return child
  }

  const terminate = (child: AgentProcess, signal: NodeJS.Signals = 'SIGTERM') => {
    if (child.pid == null) return false
    return operations.signal(child.pid, signal)
  }

  const untrack = (child: AgentProcess) => {
    if (child.pid != null) activeProcessIds.delete(child.pid)
  }

  const trackCancellation = (cancel: () => void) => {
    if (isShuttingDown) {
      cancel()
      return () => {}
    }
    activeCancellations.add(cancel)
    return () => activeCancellations.delete(cancel)
  }

  const cancelActive = (gracePeriodMs = DEFAULT_GRACE_PERIOD_MS) => {
    if (cancelPromise) return cancelPromise
    for (const cancel of activeCancellations) cancel()
    activeCancellations.clear()
    const processIds = [...activeProcessIds]
    for (const processId of processIds) operations.signal(processId, 'SIGTERM')
    cancelPromise = (async () => {
      const deadline = operations.now() + gracePeriodMs
      while (processIds.some(operations.isRunning) && operations.now() < deadline) {
        await operations.wait(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - operations.now())))
      }
      for (const processId of processIds) {
        if (operations.isRunning(processId)) operations.signal(processId, 'SIGKILL')
        activeProcessIds.delete(processId)
      }
    })().finally(() => {
      cancelPromise = null
    })
    return cancelPromise
  }

  const shutdown = (gracePeriodMs = DEFAULT_GRACE_PERIOD_MS) => {
    if (shutdownPromise) return shutdownPromise
    isShuttingDown = true
    shutdownPromise = (async () => {
      for (const cancel of activeCancellations) cancel()
      activeCancellations.clear()
      const processIds = [...activeProcessIds]
      for (const processId of processIds) operations.signal(processId, 'SIGTERM')

      const deadline = operations.now() + gracePeriodMs
      while (processIds.some(operations.isRunning) && operations.now() < deadline) {
        await operations.wait(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - operations.now())))
      }

      for (const processId of processIds) {
        if (operations.isRunning(processId)) operations.signal(processId, 'SIGKILL')
      }
      activeProcessIds.clear()
    })()
    return shutdownPromise
  }

  return { cancelActive, shutdown, terminate, track, trackCancellation, untrack }
}

const agentProcessController = createAgentProcessController()

export const shutdownAgentProcesses = agentProcessController.shutdown
export const cancelActiveAgentProcesses = agentProcessController.cancelActive
export const terminateAgentProcess = agentProcessController.terminate
export const trackAgentProcess = agentProcessController.track
export const trackAgentCancellation = agentProcessController.trackCancellation
export const untrackAgentProcess = agentProcessController.untrack
