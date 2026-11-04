import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createRendererRecovery } from '../rendererRecovery'

describe('renderer recovery', () => {
  it('defers one reload and limits repeated crashes, including after a successful load', (context) => {
    context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 })
    let reloads = 0
    const recovery = createRendererRecovery({
      canRecover: () => true,
      reload: async () => {
        reloads += 1
      },
      onError: (error) => assert.fail(String(error)),
    })

    assert.equal(recovery.recover('crashed'), true)
    assert.equal(recovery.recover('crashed'), false)
    assert.equal(reloads, 0)
    context.mock.timers.tick(250)
    assert.equal(reloads, 1)
    assert.equal(recovery.recover('crashed'), false)
    context.mock.timers.tick(5 * 60_000)
    assert.equal(recovery.recover('oom'), true)
    context.mock.timers.tick(250)
    assert.equal(reloads, 2)
  })

  it('does not reload normal exits or a renderer that cannot launch safely', (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    const recovery = createRendererRecovery({
      canRecover: () => true,
      reload: async () => assert.fail('Unexpected reload'),
      onError: (error) => assert.fail(String(error)),
    })
    assert.equal(recovery.recover('clean-exit'), false)
    assert.equal(recovery.recover('launch-failed'), false)
    assert.equal(recovery.recover('integrity-failure'), false)
    context.mock.timers.runAll()
  })

  it('does not reload during shutdown or after window replacement', (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    let available = false
    const recovery = createRendererRecovery({
      canRecover: () => available,
      reload: async () => assert.fail('Unexpected reload'),
      onError: (error) => assert.fail(String(error)),
    })
    assert.equal(recovery.recover('crashed'), false)
    available = true
    assert.equal(recovery.recover('crashed'), true)
    available = false
    context.mock.timers.runAll()
  })

  it('cancels queued recovery when the window is destroyed', (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    const recovery = createRendererRecovery({
      canRecover: () => true,
      reload: async () => assert.fail('Unexpected reload'),
      onError: (error) => assert.fail(String(error)),
    })
    assert.equal(recovery.recover('crashed'), true)
    recovery.dispose()
    context.mock.timers.runAll()
    assert.equal(recovery.recover('crashed'), false)
  })

  it('observes reload failures without retrying in a loop', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    const failure = new Error('renderer-load-failed')
    const errors: unknown[] = []
    const recovery = createRendererRecovery({
      canRecover: () => true,
      reload: async () => {
        throw failure
      },
      onError: (error) => errors.push(error),
    })
    assert.equal(recovery.recover('crashed'), true)
    context.mock.timers.runAll()
    await Promise.resolve()
    assert.deepEqual(errors, [failure])
    assert.equal(recovery.recover('crashed'), false)
  })
})
