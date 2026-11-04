import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isContextCaptureStale, shouldMonitorContextCapture } from '../contextCaptureHealth'

describe('context capture health', () => {
  it('uses helper start time until the first heartbeat arrives', () => {
    assert.equal(isContextCaptureStale({ now: 46_000, lastEventAt: null, startedAt: 0, staleAfterMs: 45_000 }), true)
  })

  it('keeps a helper healthy while native heartbeats arrive within the deadline', () => {
    assert.equal(isContextCaptureStale({ now: 60_000, lastEventAt: 30_000, startedAt: 0, staleAfterMs: 45_000 }), false)
  })

  it('does not restart a helper that has not started yet', () => {
    assert.equal(
      isContextCaptureStale({ now: 60_000, lastEventAt: null, startedAt: null, staleAfterMs: 45_000 }),
      false
    )
  })

  it('monitors the helper while the user is idle', () => {
    assert.equal(
      shouldMonitorContextCapture({ hasActiveSession: true, status: 'recording', capturePaused: false }),
      true
    )
  })

  it('does not monitor capture while its source is paused', () => {
    assert.equal(
      shouldMonitorContextCapture({ hasActiveSession: true, status: 'recording', capturePaused: true }),
      false
    )
  })
})
