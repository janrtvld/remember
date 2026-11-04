import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'

type ClaudeAnalysisQuery = AsyncIterable<SDKMessage> & { close: () => void }

export async function readClaudeAnalysisResult(
  query: ClaudeAnalysisQuery,
  options: { signal: AbortSignal; onMessage: (message: SDKMessage) => void }
) {
  const { signal } = options
  let abortRequested: () => void = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    abortRequested = () => reject(signal.reason)
    signal.addEventListener('abort', abortRequested, { once: true })
  })

  const readResult = async (): Promise<SDKResultMessage | null> => {
    const iterator = query[Symbol.asyncIterator]()
    while (true) {
      signal.throwIfAborted()
      const message = await iterator.next()
      signal.throwIfAborted()
      if (message.done) return null
      options.onMessage(message.value)
      if (message.value.type === 'result') return message.value
    }
  }

  try {
    signal.throwIfAborted()
    const result = await Promise.race([readResult(), aborted])
    signal.throwIfAborted()
    return result
  } finally {
    signal.removeEventListener('abort', abortRequested)
    // A completed single-turn result is final; SDK iteration can still wait for the child to exit.
    query.close()
  }
}
