import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import { createAgentProcessController } from '../agentProcessLifecycle'

function fakeProcess(processId: number) {
  const events = new EventEmitter()
  return {
    pid: processId,
    once: events.once.bind(events),
    emit: events.emit.bind(events),
  }
}

describe('agent process lifecycle', () => {
  it('retains a running group after a cancellation error or leader exit', async () => {
    const signals: Array<[number, NodeJS.Signals]> = []
    const running = new Set([91, 92])
    const controller = createAgentProcessController({
      signal: (processId, signal) => {
        signals.push([processId, signal])
        running.delete(processId)
        return true
      },
      isRunning: (processId) => running.has(processId),
      now: Date.now,
      wait: () => Promise.resolve(),
    })
    const aborted = controller.track(fakeProcess(91), { retainProcessGroup: true })
    const exitedLeader = controller.track(fakeProcess(92), { retainProcessGroup: true })
    aborted.emit('error')
    exitedLeader.emit('exit')

    await controller.cancelActive()

    assert.deepEqual(signals, [
      [91, 'SIGTERM'],
      [92, 'SIGTERM'],
    ])
  })

  it('releases a process once its whole group has exited', async () => {
    const signals: NodeJS.Signals[] = []
    const controller = createAgentProcessController({
      signal: (_processId, signal) => {
        signals.push(signal)
        return false
      },
      isRunning: () => false,
      now: Date.now,
      wait: () => Promise.resolve(),
    })
    const exited = controller.track(fakeProcess(93), { retainProcessGroup: true })
    exited.emit('exit')

    await controller.cancelActive()

    assert.deepEqual(signals, [])
  })

  it('untracks an owned group after another controller completes its cleanup', async () => {
    const signals: NodeJS.Signals[] = []
    const controller = createAgentProcessController({
      signal: (_processId, signal) => {
        signals.push(signal)
        return false
      },
      isRunning: () => true,
      now: Date.now,
      wait: () => Promise.resolve(),
    })
    const exitedLeader = controller.track(fakeProcess(94), { retainProcessGroup: true })
    exitedLeader.emit('exit')
    controller.untrack(exitedLeader)

    await controller.cancelActive(0)

    assert.deepEqual(signals, [])
  })

  it('gracefully terminates every tracked process group', async () => {
    const running = new Set([101, 102])
    const signals: Array<[number, NodeJS.Signals]> = []
    const controller = createAgentProcessController({
      signal: (processId, signal) => {
        signals.push([processId, signal])
        running.delete(processId)
        return true
      },
      isRunning: (processId) => running.has(processId),
      now: Date.now,
      wait: () => Promise.resolve(),
    })

    controller.track(fakeProcess(101))
    controller.track(fakeProcess(102))
    await controller.shutdown()

    assert.deepEqual(signals, [
      [101, 'SIGTERM'],
      [102, 'SIGTERM'],
    ])
  })

  it('force kills a process group that ignores the grace period', async () => {
    let now = 0
    const signals: NodeJS.Signals[] = []
    const controller = createAgentProcessController({
      signal: (_processId, signal) => {
        signals.push(signal)
        return true
      },
      isRunning: () => true,
      now: () => now,
      wait: async (durationMs) => {
        now += durationMs
      },
    })

    controller.track(fakeProcess(201))
    await controller.shutdown(100)

    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
  })

  it('immediately terminates an agent started during shutdown', async () => {
    const signals: Array<[number, NodeJS.Signals]> = []
    const controller = createAgentProcessController({
      signal: (processId, signal) => {
        signals.push([processId, signal])
        return true
      },
      isRunning: () => false,
      now: Date.now,
      wait: () => Promise.resolve(),
    })

    await controller.shutdown()
    controller.track(fakeProcess(301))

    assert.deepEqual(signals, [[301, 'SIGTERM']])
  })

  it('cancels SDK-owned processes during shutdown unless their run already finished', async () => {
    const cancellations: string[] = []
    const controller = createAgentProcessController()
    const releaseFinishedRun = controller.trackCancellation(() => cancellations.push('finished'))
    controller.trackCancellation(() => cancellations.push('active'))
    releaseFinishedRun()

    await controller.shutdown()

    assert.deepEqual(cancellations, ['active'])
  })

  it('immediately cancels an SDK run started during shutdown', async () => {
    const cancellations: string[] = []
    const controller = createAgentProcessController()

    await controller.shutdown()
    controller.trackCancellation(() => cancellations.push('late'))

    assert.deepEqual(cancellations, ['late'])
  })

  it('cancels active work without preventing later agent runs', async () => {
    const signals: Array<[number, NodeJS.Signals]> = []
    const cancellations: string[] = []
    const controller = createAgentProcessController({
      signal: (processId, signal) => {
        signals.push([processId, signal])
        return true
      },
      isRunning: () => false,
      now: Date.now,
      wait: () => Promise.resolve(),
    })

    controller.track(fakeProcess(401))
    controller.trackCancellation(() => cancellations.push('active'))
    await controller.cancelActive()
    controller.track(fakeProcess(402))
    await controller.cancelActive()

    assert.deepEqual(cancellations, ['active'])
    assert.deepEqual(signals, [
      [401, 'SIGTERM'],
      [402, 'SIGTERM'],
    ])
  })

  it('force kills an active agent that ignores offline cancellation', async () => {
    let now = 0
    const signals: NodeJS.Signals[] = []
    const controller = createAgentProcessController({
      signal: (_processId, signal) => {
        signals.push(signal)
        return true
      },
      isRunning: () => true,
      now: () => now,
      wait: async (durationMs) => {
        now += durationMs
      },
    })

    controller.track(fakeProcess(501))
    await controller.cancelActive(100)

    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
  })

  it('terminates a real detached process and its descendant', { skip: process.platform === 'win32' }, async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); setInterval(() => {}, 1000)",
      ],
      { detached: true, stdio: 'ignore' }
    )
    const processId = child.pid
    assert.ok(processId)
    const controller = createAgentProcessController()
    controller.track(child)

    try {
      await controller.shutdown(1_000)
      assert.throws(() => process.kill(-processId, 0), { code: 'ESRCH' })
    } finally {
      try {
        process.kill(-processId, 'SIGKILL')
      } catch {}
    }
  })
})
