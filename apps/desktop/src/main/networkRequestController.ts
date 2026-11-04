export function createNetworkRequestController() {
  const activeRequests = new Set<AbortController>()

  async function run<T>(request: (signal: AbortSignal) => Promise<T>, timeoutMs?: number) {
    const controller = new AbortController()
    const timeout = timeoutMs
      ? setTimeout(() => controller.abort(new Error('network-request-timeout')), timeoutMs)
      : null
    timeout?.unref()
    activeRequests.add(controller)
    try {
      return await request(controller.signal)
    } catch (error) {
      if (controller.signal.reason instanceof Error) throw controller.signal.reason
      throw error
    } finally {
      if (timeout) clearTimeout(timeout)
      activeRequests.delete(controller)
    }
  }

  function cancel(reason: Error) {
    for (const controller of activeRequests) controller.abort(reason)
    activeRequests.clear()
  }

  return { cancel, run }
}
