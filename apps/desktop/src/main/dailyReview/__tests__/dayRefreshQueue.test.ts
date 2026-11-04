import assert from 'node:assert/strict'
import { it } from 'node:test'
import type { ConversationSummary } from '@remember/shared'
import { reconcileEpisodeConversationSummaries } from '../conversationReconciliation'
import { createDayRefreshQueue } from '../dayRefreshQueue'

function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it('keeps a second selection visible while the first refresh saves, then processes it', async () => {
  const started = deferred()
  const finishFirst = deferred()
  const dayStartedAt = new Date(2026, 8, 10, 8).getTime()
  const first: ConversationSummary = {
    episodeId: 'first',
    startTime: '10:20',
    endTime: '10:33',
    title: 'First',
    description: '',
    processing: 'processing',
  }
  const second: ConversationSummary = {
    episodeId: 'second',
    startTime: '10:19',
    endTime: '12:27',
    title: 'Second',
    description: '',
    processing: 'processing',
  }
  let conversations = [first]
  const analyzed: string[][] = []
  const queue = createDayRefreshQueue(async () => {
    const snapshot = [...conversations]
    analyzed.push(snapshot.map((conversation) => conversation.episodeId as string))
    if (analyzed.length === 1) {
      started.resolve()
      await finishFirst.promise
    }
    const generated = snapshot.map((conversation) => ({ ...conversation, processing: undefined }))
    conversations = reconcileEpisodeConversationSummaries(dayStartedAt, conversations, generated) ?? []
    return [...conversations]
  })
  const firstRun = queue.refresh('day', 'manual', 'en')
  await started.promise
  conversations.push(second)
  const secondRun = queue.refresh('day', 'manual', 'en')
  assert.deepEqual(analyzed, [['first']])
  finishFirst.resolve()
  assert.deepEqual(
    (await firstRun).map((conversation) => [conversation.episodeId, conversation.processing]),
    [
      ['second', 'processing'],
      ['first', undefined],
    ]
  )
  assert.equal(
    (await secondRun).some((conversation) => conversation.processing),
    false
  )
  assert.deepEqual(analyzed, [['first'], ['second', 'first']])
  assert.equal(queue.has('day'), false)
})

it('allows another day to run and does not let a failed run discard queued manual work', async () => {
  const finish = deferred()
  let calls = 0
  const queue = createDayRefreshQueue(async (id) => {
    calls += 1
    if (calls === 1) {
      await finish.promise
      throw new Error('agent-failed')
    }
    return id
  })
  const first = queue.refresh('day', 'manual', 'en')
  const rejected = assert.rejects(first, /agent-failed/)
  assert.equal(queue.refresh('day', 'active-interval', 'en'), first)
  const second = queue.refresh('day', 'manual', 'nl')
  assert.equal(await queue.refresh('other', 'manual', 'en'), 'other')
  assert.equal(calls, 2)
  finish.resolve()
  await rejected
  assert.equal(await second, 'day')
  await queue.drain()
  assert.equal(calls, 3)
  assert.equal(queue.has('day'), false)
})
