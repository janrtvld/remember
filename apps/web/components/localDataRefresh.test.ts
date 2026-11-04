import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { WorkItem } from '@remember/shared'
import { coalesceRefresh, pollConversationProcessing, reconcileWorkItems } from './localDataRefresh'

const flushPromises = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('conversation processing polling', () => {
  it('keeps reading until stopped, even after temporary failures', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    let reads = 0
    const stop = pollConversationProcessing(async () => {
      if (++reads === 2) throw new Error('temporary read failure')
    })
    context.after(stop)
    await flushPromises()
    assert.equal(reads, 1)
    for (let attempt = 2; attempt <= 4; attempt += 1) {
      context.mock.timers.tick(10_000)
      await flushPromises()
      assert.equal(reads, attempt)
    }
    stop()
    context.mock.timers.tick(60_000)
    await flushPromises()
    assert.equal(reads, 4)
  })

  it('does not overlap slow reads or continue after unmount during a read', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    let reads = 0
    let resolveRead = () => {}
    const stop = pollConversationProcessing(async () => {
      reads += 1
      await new Promise<void>((resolve) => {
        resolveRead = resolve
      })
    })
    context.after(stop)
    context.mock.timers.tick(60_000)
    await flushPromises()
    assert.equal(reads, 1)
    stop()
    resolveRead()
    await flushPromises()
    context.mock.timers.tick(60_000)
    assert.equal(reads, 1)
  })

  it('continues reading local processing without a cloud sync in offline mode', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    let reads = 0
    const stop = pollConversationProcessing(async () => {
      reads += 1
    })
    context.after(stop)
    await flushPromises()
    context.mock.timers.tick(10_000)
    await flushPromises()
    assert.equal(reads, 2)
  })
})

function item(id: string, updatedAt: number, lifecycle: WorkItem['lifecycle'] = 'open'): WorkItem {
  return {
    id,
    updatedAt,
    lifecycle,
    title: id,
    description: '',
    prompt: '',
    context: '',
    returnPoint: { lastMove: '', unresolved: '', nextMove: '' },
    status: 'todo',
    priority: 'none',
    dueAt: null,
    attention: 'idle',
    createdAt: 1,
    closedAt: lifecycle === 'open' ? null : updatedAt,
    userEditedTitle: false,
    userEditedDescription: false,
    sources: [],
    facts: [],
    observations: [],
    agentSessions: [],
  }
}

describe('local data refresh', () => {
  it('coalesces a burst and follows an in-flight read with one fresh read', async () => {
    let calls = 0
    let release = () => {}
    const refresh = coalesceRefresh(async () => {
      calls += 1
      if (calls === 1)
        await new Promise<void>((resolve) => {
          release = resolve
        })
    })
    const first = refresh()
    for (let index = 0; index < 100; index += 1) assert.equal(refresh(), first)
    await Promise.resolve()
    assert.equal(calls, 1)
    for (let index = 0; index < 100; index += 1) assert.equal(refresh(), first)
    release()
    await first
    assert.equal(calls, 2)
    await refresh()
    assert.equal(calls, 3)
  })

  it('allows a retry after a failed read', async () => {
    let calls = 0
    const refresh = coalesceRefresh(async () => {
      if (++calls === 1) throw new Error('offline')
    })
    await assert.rejects(refresh(), /offline/)
    await refresh()
    assert.equal(calls, 2)
  })

  it('does not lose an invalidation arriving as the previous refresh completes', async () => {
    let calls = 0
    const refresh = coalesceRefresh(async () => {
      calls += 1
    })
    const first = refresh()
    const next = Promise.resolve()
      .then(() => {})
      .then(() => refresh())
    await Promise.all([first, next])
    assert.equal(calls, 2)
  })

  it('does not undo completion or lose a task created while a list read was in flight', () => {
    const completed = item('existing', 3, 'completed')
    const created = item('created', 4)
    assert.deepEqual(
      reconcileWorkItems([completed, created], [item('existing', 2)], new Set(['existing', 'created'])),
      [created, completed]
    )
  })

  it('accepts refreshed items and removes absent items when no local write raced the read', () => {
    const refreshed = item('existing', 5)
    assert.deepEqual(reconcileWorkItems([item('existing', 2), item('deleted', 3)], [refreshed], new Set()), [refreshed])
  })
})
