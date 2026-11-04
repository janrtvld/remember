import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createAudioHelperStartupGuard, createSystemAudioVerificationCompletion } from './systemAudioLifecycle'

describe('system audio helper lifecycle', () => {
  it('reports a silent startup once so the caller schedules one retry', async () => {
    let retries = 0
    let releaseTimeout: (() => void) | null = null
    const timedOut = new Promise<void>((resolve) => {
      releaseTimeout = resolve
    })
    const startup = createAudioHelperStartupGuard({
      timeoutMs: 5,
      onTimeout: () => {
        retries += 1
        releaseTimeout?.()
      },
    })

    await timedOut

    assert.equal(retries, 1)
    assert.equal(startup.markReady(), false)
    assert.equal(startup.markFailed(), false)
  })

  it('cancels the startup timeout once the helper reports ready', async () => {
    let retries = 0
    const startup = createAudioHelperStartupGuard({
      timeoutMs: 5,
      onTimeout: () => {
        retries += 1
      },
    })

    assert.equal(startup.markReady(), true)
    await new Promise((resolve) => setTimeout(resolve, 15))

    assert.equal(retries, 0)
  })

  it('cancels the startup timeout once the helper reports an error', async () => {
    let timeouts = 0
    const startup = createAudioHelperStartupGuard({
      timeoutMs: 5,
      onTimeout: () => {
        timeouts += 1
      },
    })

    assert.equal(startup.markFailed(), true)
    await new Promise((resolve) => setTimeout(resolve, 15))

    assert.equal(timeouts, 0)
  })

  it('cleans up a closed verification helper before resolving success', () => {
    const events: string[] = []
    let resolved: { ok: boolean; error: string | null } | null = null
    const completion = createSystemAudioVerificationCompletion({
      cleanup: () => events.push('cleanup'),
      resolve: (result) => {
        events.push('resolve')
        resolved = result
      },
    })

    assert.equal(completion.settle({ ok: true, error: null }), true)
    assert.equal(completion.settle({ ok: false, error: 'late close' }), false)
    assert.deepEqual(events, [])

    completion.close()

    assert.deepEqual(events, ['cleanup', 'resolve'])
    assert.deepEqual(resolved, { ok: true, error: null })
  })
})
