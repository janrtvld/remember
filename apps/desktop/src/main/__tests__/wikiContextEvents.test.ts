import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as events from '../wikiContextEvents'

test('Wiki content refresh is separate from privacy invalidation and supports unsubscribe', () => {
  let contents = 0
  let invalidations = 0
  const unsubscribeInvalidation = events.subscribeWikiContextInvalidation(() => {
    invalidations += 1
  })
  const unsubscribeContent = events.subscribeWikiContentChanges(() => {
    contents += 1
  })
  try {
    events.emitWikiContentChanged()
    assert.equal(contents, 1)
    assert.equal(invalidations, 0)
    events.invalidateWikiContext()
    assert.equal(contents, 1)
    assert.equal(invalidations, 1)
    unsubscribeContent()
    events.emitWikiContentChanged()
    assert.equal(contents, 1)
    assert.equal(invalidations, 1)
  } finally {
    unsubscribeContent()
    unsubscribeInvalidation()
  }
})

test('Wiki content listener failure does not escape or prevent other renderer subscribers', (t) => {
  const calls: string[] = []
  const logged: unknown[][] = []
  t.mock.method(console, 'error', (...args: unknown[]) => {
    logged.push(args)
  })
  const error = new Error('fixture-listener-failure')
  const unsubscribers = [
    events.subscribeWikiContentChanges(() => {
      calls.push('first')
    }),
    events.subscribeWikiContentChanges(() => {
      calls.push('failed')
      throw error
    }),
    events.subscribeWikiContentChanges(() => {
      calls.push('last')
    }),
  ]
  try {
    assert.doesNotThrow(() => events.emitWikiContentChanged())
    assert.deepEqual(calls, ['first', 'failed', 'last'])
    assert.equal(logged.length, 1)
    assert.equal(logged[0]?.[1], error)
  } finally {
    for (const unsubscribe of unsubscribers) unsubscribe()
  }
})
