import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { retryInvalidAgentResponse } from '../agentResponseRetry'

describe('retryInvalidAgentResponse', () => {
  it('retries one malformed agent response', async () => {
    const attempts: boolean[] = []
    const result = await retryInvalidAgentResponse(async (isRetry) => {
      attempts.push(isRetry)
      if (!isRetry) throw new Error('agent-invalid-response')
      return 'recovered'
    })

    assert.equal(result, 'recovered')
    assert.deepEqual(attempts, [false, true])
  })

  it('does not retry unrelated failures', async () => {
    let attempts = 0
    await assert.rejects(
      retryInvalidAgentResponse(async () => {
        attempts += 1
        throw new Error('agent-rate-limited')
      }),
      /agent-rate-limited/
    )
    assert.equal(attempts, 1)
  })

  it('retries a Claude structured-output failure once', async () => {
    const attempts: boolean[] = []
    const result = await retryInvalidAgentResponse(async (isRetry) => {
      attempts.push(isRetry)
      if (!isRetry) throw new Error('claude-structured-output-failed')
      return 'recovered'
    })

    assert.equal(result, 'recovered')
    assert.deepEqual(attempts, [false, true])
  })

  it('normalizes repeated recoverable failures to the public invalid-response code', async () => {
    const detail = new Error('Output did not match the required schema')
    const failure = new Error('claude-structured-output-failed', { cause: detail })

    await assert.rejects(
      retryInvalidAgentResponse(async () => Promise.reject(failure)),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error.message, 'agent-invalid-response')
        assert.equal(error.cause, failure)
        return true
      }
    )
  })
})
