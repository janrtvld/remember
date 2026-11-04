import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  changedRevinoteMeetingIds,
  failedRevinotePostProcessEpisodes,
  hasPendingRevinotePostProcesses,
  mergeRevinoteSyncMeetings,
  preparedUploadCanRestart,
} from './revinoteSyncState'

const imported = (id: string, status: string) => ({ id, status, updatedAt: id })

describe('Revinote sync persistence', () => {
  it('polls outstanding submissions after restart and stops for imported or settled meetings', () => {
    const submissions = { first: { meetingId: 'meeting-first' }, second: { meetingId: 'meeting-second', settledAt: 1 } }
    assert.equal(hasPendingRevinotePostProcesses(JSON.parse(JSON.stringify(submissions)), {}), true)
    assert.equal(
      hasPendingRevinotePostProcesses(submissions, { 'meeting-first': imported('meeting-first', 'finished') }),
      false
    )
    assert.equal(hasPendingRevinotePostProcesses({ second: submissions.second }, {}), false)
    assert.equal(hasPendingRevinotePostProcesses({}, {}), false)
  })
  it('replaces an authoritative snapshot but preserves missing meetings during incremental sync', () => {
    const existing = {
      retained: imported('retained', 'finished'),
      deleted: imported('deleted', 'finished'),
    }

    assert.deepEqual(mergeRevinoteSyncMeetings(existing, [imported('retained', 'finished')], true), {
      retained: imported('retained', 'finished'),
    })
    assert.deepEqual(mergeRevinoteSyncMeetings(existing, [imported('retained', 'finished')], false), existing)
  })

  it('removes a failed meeting and releases its matching post-process submission', () => {
    const submissions = {
      'episode-failed': { meetingId: 'meeting-failed' },
      'episode-finished': { meetingId: 'meeting-finished' },
    }
    const page = [imported('meeting-failed', 'failed'), imported('meeting-finished', 'finished')]

    assert.deepEqual(
      mergeRevinoteSyncMeetings({ 'meeting-failed': imported('meeting-failed', 'finished') }, page, false),
      { 'meeting-finished': imported('meeting-finished', 'finished') }
    )
    assert.deepEqual(failedRevinotePostProcessEpisodes(submissions, page), [
      { episodeId: 'episode-failed', meetingId: 'meeting-failed' },
    ])
  })

  it('excludes processed meetings from full and incremental imports, including old cached records', () => {
    const existing = { old: imported('old', 'processed'), handled: imported('handled', 'finished') }
    const page = [imported('handled', 'processed'), imported('new', 'finished'), imported('busy', 'processing')]
    for (const authoritative of [true, false]) {
      assert.deepEqual(mergeRevinoteSyncMeetings(existing, page, authoritative), { new: imported('new', 'finished') })
    }
  })

  it('never replaces an uploaded key after an ambiguous complete response', () => {
    assert.equal(preparedUploadCanRestart('prepared', 400), true)
    assert.equal(preparedUploadCanRestart('uploaded', 400), false)
    assert.equal(preparedUploadCanRestart('prepared', 500), false)
  })

  it('promotes action points only for new or changed meeting snapshots', () => {
    const known = new Map([
      ['unchanged', 'v1'],
      ['changed', 'v1'],
    ])

    assert.deepEqual(
      [
        ...changedRevinoteMeetingIds(known, [
          { id: 'unchanged', updatedAt: 'v1' },
          { id: 'changed', updatedAt: 'v2' },
          { id: 'new', updatedAt: 'v1' },
        ]),
      ],
      ['changed', 'new']
    )
  })
})
