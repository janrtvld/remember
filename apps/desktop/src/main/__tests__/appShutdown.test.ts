import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createAppExitStrategy, createAppShutdown } from '../appShutdown'

describe('app shutdown', () => {
  it('uses a direct exit after cleanup for an ordinary quit', () => {
    let exitCount = 0
    const quitCount = 0
    const strategy = createAppExitStrategy({
      exit: () => {
        exitCount += 1
      },
    })

    assert.equal(strategy.shouldPreventQuit(), true)
    strategy.finishShutdown()
    assert.equal(exitCount, 1)
    assert.equal(quitCount, 0)
  })

  it('hands off to the updater only after cleanup and allows its quit', () => {
    let exitCount = 0
    let quitCount = 0
    const strategy = createAppExitStrategy({
      exit: () => {
        exitCount += 1
      },
    })

    strategy.prepareForUpdate(() => {
      quitCount += 1
    })
    assert.equal(strategy.shouldPreventQuit(), true)
    strategy.finishShutdown()
    assert.equal(strategy.shouldPreventQuit(), false)
    assert.equal(exitCount, 0)
    assert.equal(quitCount, 1)

    strategy.finishShutdown()
    assert.equal(quitCount, 1)
  })

  it('runs once and always exits after process and cleanup failures', async () => {
    const calls: string[] = []
    const errors: string[] = []
    const shutdown = createAppShutdown({
      stopProcesses: async () => {
        calls.push('stop')
        throw new Error('stop failed')
      },
      cleanup: [
        () => {
          calls.push('first cleanup')
          throw new Error('cleanup failed')
        },
        () => {
          calls.push('second cleanup')
        },
      ],
      exit: () => calls.push('exit'),
      reportError: (message) => errors.push(message),
    })

    const first = shutdown()
    const second = shutdown()
    assert.equal(first, second)
    await Promise.all([first, second])

    assert.deepEqual(calls, ['stop', 'first cleanup', 'second cleanup', 'exit'])
    assert.deepEqual(errors, ['could not stop agent processes', 'cleanup failed'])
  })
})

it('stops capture while agent shutdown is still pending, before updater handoff', async () => {
  const calls: string[] = []
  let release!: () => void
  const agents = new Promise<void>((resolve) => {
    release = resolve
  })
  const strategy = createAppExitStrategy({ exit: () => assert.fail('unexpected direct exit') })
  strategy.prepareForUpdate(() => {
    assert.equal(strategy.shouldPreventQuit(), false)
    calls.push('install')
  })
  const shutdown = createAppShutdown({
    stopCapture: [
      () => {
        calls.push('capture stopped')
      },
    ],
    stopProcesses: () => agents,
    cleanup: [
      () => {
        calls.push('capture destroyed')
      },
    ],
    exit: strategy.finishShutdown,
    reportError: () => assert.fail('unexpected error'),
  })
  const pending = shutdown()
  assert.deepEqual(calls, ['capture stopped'])
  release()
  await pending
  assert.deepEqual(calls, ['capture stopped', 'capture destroyed', 'install'])
})
