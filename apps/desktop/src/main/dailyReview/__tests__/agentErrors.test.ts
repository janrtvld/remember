import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  agentErrorDetail,
  classifyAgentError,
  createAgentError,
  isAgentCancellation,
  isRecoverableCodexResponseError,
  isRetryableAgentResponseError,
  redactAgentCredentials,
} from '../agentErrors'

describe('agent errors', () => {
  it('preserves policy, network, and SDK cancellations instead of reporting provider failures', () => {
    const abort = new Error('The operation was aborted')
    abort.name = 'AbortError'
    for (const error of [
      new Error('agent-cancelled'),
      new Error('agent-interrupted'),
      new Error('network-request-cancelled'),
      abort,
      Object.assign(new Error('Operation stopped'), { code: 'ABORT_ERR' }),
      new Error('Codex execution failed', { cause: abort }),
    ]) {
      assert.equal(isAgentCancellation(error), true)
      assert.equal(classifyAgentError(error), 'agent-cancelled')
      assert.equal(isRetryableAgentResponseError(error), false)
    }
  })

  it('keeps real timeouts and provider failures even when they retain an abort cause', () => {
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    for (const code of ['claude-timeout', 'agent-timeout', 'claude-output-too-large', 'agent-network-error']) {
      const error = new Error(code, { cause: abort })
      assert.equal(isAgentCancellation(error), false)
      assert.equal(classifyAgentError(error), code)
    }
    assert.equal(isAgentCancellation(new Error('The network request was interrupted by a socket failure')), false)
    assert.equal(
      classifyAgentError(new Error('The network request was interrupted by a socket failure')),
      'agent-network-error'
    )
    const cyclic = new Error('Provider failed')
    cyclic.cause = cyclic
    assert.equal(isAgentCancellation(cyclic), false)
  })

  it('classifies details retained behind a generic Claude error', () => {
    const error = createAgentError('claude-failed', 'OAuth session expired. Please authenticate again.')

    assert.equal(classifyAgentError(error), 'agent-auth-required')
    assert.equal(agentErrorDetail(error, 'agent-auth-required'), 'OAuth session expired. Please authenticate again.')
  })

  it('keeps a public response code while exposing only its operational detail', () => {
    const responseError = createAgentError('claude-structured-output-failed', 'Output does not match required schema')
    const error = new Error('agent-invalid-response', { cause: responseError })

    assert.equal(classifyAgentError(error), 'agent-invalid-response')
    assert.equal(agentErrorDetail(error, 'agent-invalid-response'), 'Output does not match required schema')
  })

  it('recognizes Codex response validation failures as recoverable', () => {
    assert.equal(isRecoverableCodexResponseError('Model output did not match the provided schema'), true)
    assert.equal(isRecoverableCodexResponseError('Failed to parse model response as valid JSON'), true)
    assert.equal(isRecoverableCodexResponseError('Network connection closed'), false)
  })

  it('retries only response-shape failures', () => {
    assert.equal(isRetryableAgentResponseError(new Error('agent-invalid-response')), true)
    assert.equal(isRetryableAgentResponseError(new Error('claude-structured-output-failed')), true)
    assert.equal(isRetryableAgentResponseError(new Error('agent-rate-limited')), false)
  })

  it('redacts credentials before retaining an operational detail', () => {
    const error = createAgentError(
      'claude-failed',
      'Request failed with Bearer secret-token-value and access_token="token-value"'
    )

    assert.equal(
      agentErrorDetail(error, 'agent-failed'),
      'Request failed with Bearer [redacted] and [token]=[redacted]'
    )
  })

  it('redacts credentials from raw output without flattening its structure', () => {
    assert.equal(
      redactAgentCredentials('first line\nAuthorization: Bearer secret-token-value\naccess_token="token-value"'),
      'first line\nAuthorization: Bearer [redacted]\n[token]=[redacted]'
    )
  })
})
