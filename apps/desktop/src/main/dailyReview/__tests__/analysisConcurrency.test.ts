import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { mapWithConcurrency } from '../analysisConcurrency'

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('analysis concurrency', () => {
  it('fails promptly and stops launching shards after the running sibling finishes', async () => {
    const first = deferred<number>()
    const sibling = deferred<number>()
    const started: number[] = []
    const failure = new Error('synthetic-shard-failure')
    let settled = false
    const batch = mapWithConcurrency([0, 1, 2, 3], 2, async (index) => {
      started.push(index)
      return index === 0 ? first.promise : sibling.promise
    })
    const rejection = assert.rejects(batch, (error) => {
      settled = true
      return error === failure
    })

    assert.deepEqual(started, [0, 1])
    first.reject(failure)
    await rejection
    assert.equal(settled, true)
    assert.deepEqual(started, [0, 1])

    sibling.resolve(1)
    await setImmediate()
    assert.deepEqual(started, [0, 1])
  })

  it('handles a later sibling rejection while preserving the original failure', async () => {
    const first = deferred<number>()
    const sibling = deferred<number>()
    const failure = new Error('first-shard-failure')
    const batch = mapWithConcurrency([first.promise, sibling.promise], 2, (item) => item)
    const rejection = assert.rejects(batch, (error) => error === failure)

    first.reject(failure)
    await rejection
    sibling.reject(new Error('later-shard-failure'))
    await setImmediate()
  })

  it('preserves input order and the concurrency limit when shards finish out of order', async () => {
    const shards = Array.from({ length: 5 }, () => deferred<number>())
    const started: number[] = []
    let active = 0
    let peakActive = 0
    const batch = mapWithConcurrency(shards, 2, async (shard, index) => {
      started.push(index)
      active += 1
      peakActive = Math.max(peakActive, active)
      try {
        return await shard.promise
      } finally {
        active -= 1
      }
    })
    assert.deepEqual(started, [0, 1])
    for (const index of [1, 2, 0, 4, 3]) {
      shards[index]?.resolve(index * 10)
      await setImmediate()
    }

    assert.deepEqual(await batch, [0, 10, 20, 30, 40])
    assert.deepEqual(started, [0, 1, 2, 3, 4])
    assert.equal(peakActive, 2)
    assert.equal(active, 0)
  })
})
