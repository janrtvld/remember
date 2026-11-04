import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type InboxReadState, markInboxTaskRead, markInboxTasksUnread, parseInboxReadState } from './inboxReadState'

describe('Inbox read state', () => {
  const baseline: InboxReadState = {
    version: 1,
    seenUpdatedAtByTask: { first: 20, second: 30 },
    manuallyUnreadTaskKeys: [],
  }

  it('migrates existing read markers without marking older tasks unread', () => {
    assert.deepEqual(parseInboxReadState({ version: 1, seenUpdatedAtByTask: { first: 20 } }), {
      version: 1,
      seenUpdatedAtByTask: { first: 20 },
      manuallyUnreadTaskKeys: [],
    })
  })

  it('keeps the displayed task unread through refresh, focus, new activity and reload', () => {
    const marked = markInboxTasksUnread(baseline, ['first', 'second'])
    const reloaded = parseInboxReadState(JSON.parse(JSON.stringify(marked)))
    assert.ok(reloaded)
    assert.strictEqual(markInboxTaskRead(reloaded, 'first', 20), reloaded)
    assert.strictEqual(markInboxTaskRead(reloaded, 'first', 40), reloaded)
    assert.deepEqual(reloaded.manuallyUnreadTaskKeys, ['first', 'second'])
  })

  it('clears only the deliberately reopened task and records its latest version', () => {
    const marked = markInboxTasksUnread(baseline, ['first', 'second'])
    const opened = markInboxTaskRead(marked, 'first', 40, true)
    assert.deepEqual(opened.manuallyUnreadTaskKeys, ['second'])
    assert.deepEqual(opened.seenUpdatedAtByTask, { first: 40, second: 30 })
  })

  it('keeps automatic read behavior for tasks that were not manually marked unread', () => {
    const read = markInboxTaskRead(baseline, 'first', 40)
    assert.equal(read.seenUpdatedAtByTask.first, 40)
    assert.strictEqual(markInboxTaskRead(read, 'first', 40), read)
  })

  it('tolerates malformed saved entries and repeated mark-unread actions', () => {
    const parsed = parseInboxReadState({
      version: 1,
      seenUpdatedAtByTask: { first: 20, invalid: 'broken' },
      manuallyUnreadTaskKeys: ['first', 'first', null, 4],
    })
    assert.ok(parsed)
    assert.deepEqual(parsed, { ...baseline, seenUpdatedAtByTask: { first: 20 }, manuallyUnreadTaskKeys: ['first'] })
    assert.strictEqual(markInboxTasksUnread(parsed, ['first']), parsed)
  })
})
