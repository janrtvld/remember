import assert from 'node:assert/strict'
import test from 'node:test'
import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import { readClaudeAnalysisResult } from '../claudeAnalysisQuery'

const success = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: '{"summary":"Done"}',
} as SDKResultMessage

function pendingQuery() {
  let closeCount = 0
  let nextCount = 0
  let deliver: (value: IteratorResult<SDKMessage>) => void = () => {}
  const pending = new Promise<IteratorResult<SDKMessage>>((resolve) => {
    deliver = resolve
  })
  return {
    query: {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          nextCount += 1
          return pending
        },
      }),
      close: () => {
        closeCount += 1
      },
    },
    deliver,
    get closeCount() {
      return closeCount
    },
    get nextCount() {
      return nextCount
    },
  }
}

test('accepts a terminal result without waiting for SDK stdout or process exit', async () => {
  const pending = pendingQuery()
  const messages: SDKMessage[] = []
  const completed = readClaudeAnalysisResult(pending.query, {
    signal: new AbortController().signal,
    onMessage: (message) => messages.push(message),
  })
  pending.deliver({ done: false, value: success })

  assert.equal(await completed, success)
  assert.deepEqual(messages, [success])
  assert.equal(pending.nextCount, 1)
  assert.equal(pending.closeCount, 1)
})

test('returns an error result for the existing provider error classifier', async () => {
  const pending = pendingQuery()
  const failed = {
    type: 'result',
    subtype: 'error_max_structured_output_retries',
    errors: ['Invalid schema'],
  } as SDKResultMessage
  pending.deliver({ done: false, value: failed })

  assert.equal(
    await readClaudeAnalysisResult(pending.query, {
      signal: new AbortController().signal,
      onMessage: () => {},
    }),
    failed
  )
  assert.equal(pending.closeCount, 1)
})

test('timeout settles even when the SDK iterator ignores cancellation', async () => {
  const pending = pendingQuery()
  const controller = new AbortController()
  const timeout = new Error('claude-timeout')
  const completed = readClaudeAnalysisResult(pending.query, { signal: controller.signal, onMessage: () => {} })
  const rejection = assert.rejects(completed, (error) => error === timeout)
  controller.abort(timeout)

  await rejection
  assert.equal(pending.closeCount, 1)
})

test('preserves the caller cancellation reason and discards a late success', async () => {
  const pending = pendingQuery()
  const controller = new AbortController()
  const cancelled = new Error('remember-request-preparation-stopped')
  const messages: SDKMessage[] = []
  const completed = readClaudeAnalysisResult(pending.query, {
    signal: controller.signal,
    onMessage: (message) => messages.push(message),
  })
  const rejection = assert.rejects(completed, (error) => error === cancelled)
  pending.deliver({ done: false, value: success })
  controller.abort(cancelled)

  await rejection
  assert.deepEqual(messages, [])
  assert.equal(pending.closeCount, 1)
})

test('does not read an already cancelled query', async () => {
  const pending = pendingQuery()
  const cancelled = new Error('network-request-cancelled')

  await assert.rejects(
    readClaudeAnalysisResult(pending.query, { signal: AbortSignal.abort(cancelled), onMessage: () => {} }),
    (error) => error === cancelled
  )
  assert.equal(pending.nextCount, 0)
  assert.equal(pending.closeCount, 1)
})

test('closes the query when output processing fails', async () => {
  const pending = pendingQuery()
  const tooLarge = new Error('claude-output-too-large')
  pending.deliver({ done: false, value: success })

  await assert.rejects(
    readClaudeAnalysisResult(pending.query, {
      signal: new AbortController().signal,
      onMessage: () => {
        throw tooLarge
      },
    }),
    (error) => error === tooLarge
  )
  assert.equal(pending.closeCount, 1)
})

test('preserves stream errors and detects an empty stream', async () => {
  const failure = new Error('Process exited with code 1')
  let closeCount = 0
  const query = {
    [Symbol.asyncIterator]: () => ({ next: (): Promise<IteratorResult<SDKMessage>> => Promise.reject(failure) }),
    close: () => {
      closeCount += 1
    },
  }
  const options = { signal: new AbortController().signal, onMessage: () => {} }

  await assert.rejects(readClaudeAnalysisResult(query, options), (error) => error === failure)
  assert.equal(
    await readClaudeAnalysisResult(
      {
        ...query,
        [Symbol.asyncIterator]: () => ({
          next: (): Promise<IteratorResult<SDKMessage>> => Promise.resolve({ done: true, value: undefined }),
        }),
      },
      options
    ),
    null
  )
  assert.equal(closeCount, 2)
})
