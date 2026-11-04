import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  completedEvidenceThrough,
  frequentRefreshIntervalMs,
  hasPendingDayWikiReview,
  nextDayWithPendingWikiReview,
  shouldRefreshDuringDowntime,
  shouldRefreshDuringFrequentInterval,
} from '../dayRefreshPolicy'

const ready = {
  isRecording: true,
  isRefreshing: false,
  hasPendingTranscription: false,
  userIdleSeconds: 600,
  lastMeaningfulSpeechAt: 0,
  now: 2_000_000,
  latestEvidenceAt: 1_000_000,
  coveredThrough: 0,
  requiredIdleSeconds: 600,
  requiredSpeechSilenceMs: 240_000,
  requiredNewEvidenceMs: 900_000,
}

describe('downtime Day refresh policy', () => {
  it('refreshes only after enough idle time and new evidence', () => {
    assert.equal(shouldRefreshDuringDowntime(ready), true)
    assert.equal(shouldRefreshDuringDowntime({ ...ready, userIdleSeconds: 599 }), false)
    assert.equal(shouldRefreshDuringDowntime({ ...ready, latestEvidenceAt: 899_999 }), false)
  })

  it('waits until conversation speech and transcription have settled', () => {
    assert.equal(shouldRefreshDuringDowntime({ ...ready, lastMeaningfulSpeechAt: ready.now - 239_999 }), false)
    assert.equal(shouldRefreshDuringDowntime({ ...ready, hasPendingTranscription: true }), false)
  })

  it('does not overlap another refresh or run outside active capture', () => {
    assert.equal(shouldRefreshDuringDowntime({ ...ready, isRefreshing: true }), false)
    assert.equal(shouldRefreshDuringDowntime({ ...ready, isRecording: false }), false)
  })
})

describe('frequent interval Day refresh policy', () => {
  const due = {
    isRefreshing: false,
    now: 2_000_000,
    lastRefreshAt: 200_000,
    refreshIntervalMs: 1_800_000,
    latestEvidenceAt: 1_000_000,
    coveredThrough: 0,
    requiredNewEvidenceMs: 900_000,
  }

  it('refreshes when the interval has elapsed and enough new evidence exists', () => {
    assert.equal(shouldRefreshDuringFrequentInterval(due), true)
  })

  it('does not spend a full refresh on a negligible evidence delta', () => {
    assert.equal(shouldRefreshDuringFrequentInterval({ ...due, latestEvidenceAt: 899_999 }), false)
  })

  it('does not refresh too soon', () => {
    assert.equal(shouldRefreshDuringFrequentInterval({ ...due, lastRefreshAt: 200_001 }), false)
  })

  it('does not overlap another refresh', () => {
    assert.equal(shouldRefreshDuringFrequentInterval({ ...due, isRefreshing: true }), false)
  })

  it('supports normalized minute intervals', () => {
    assert.equal(frequentRefreshIntervalMs(1), 60_000)
    assert.equal(frequentRefreshIntervalMs(30), 1_800_000)
  })

  it('never allows a frequent refresh interval below one minute', () => {
    assert.equal(frequentRefreshIntervalMs(0), 60_000)
  })
})

describe('automatic refresh during continuous audio capture', () => {
  it('refreshes completed evidence while both audio sources retain an unfinished chunk', () => {
    const now = 1_200_000
    const through = completedEvidenceThrough(now, [
      { status: 'ready', startedAt: 600_000 },
      { status: 'transcribing', startedAt: 1_080_000 },
      { status: 'transcribing', startedAt: 1_100_000 },
    ])
    assert.equal(through, 1_079_999)
    assert.equal(
      shouldRefreshDuringFrequentInterval({
        isRefreshing: false,
        now,
        lastRefreshAt: 0,
        refreshIntervalMs: 600_000,
        latestEvidenceAt: through,
        coveredThrough: 0,
        requiredNewEvidenceMs: 600_000,
      }),
      true
    )
    // Once the retained chunk finishes, its timestamp remains beyond the
    // previous coverage cursor and it can enter the next incremental analysis.
    assert.ok(1_080_000 > through)
    assert.equal(completedEvidenceThrough(now, [{ status: 'ready', startedAt: 1_080_000 }]), now)
  })

  it('does not advance coverage past older pending audio or beyond the current time', () => {
    assert.equal(
      completedEvidenceThrough(1_200_000, [
        { status: 'transcribing', startedAt: 500_000 },
        { status: 'transcribing', startedAt: 1_100_000 },
      ]),
      499_999
    )
    assert.equal(completedEvidenceThrough(1_200_000, []), 1_200_000)
  })
})

describe('pending Day Wiki review retries', () => {
  const pendingDay = {
    id: 'active-day',
    startedAt: 0,
    endedAt: null as number | null,
    memory: { coveredThrough: 1_000, wikiCoveredThrough: 500, refreshedAt: 1_100 },
    moments: [],
    refresh: { status: 'idle' as const, run: { startedAt: 1_000, completedAt: 1_100 } },
  }

  it('recognizes explicitly incomplete Wiki coverage without new Day evidence', () => {
    assert.equal(hasPendingDayWikiReview(pendingDay.memory), true)
    assert.equal(hasPendingDayWikiReview({ coveredThrough: 1_000, wikiCoveredThrough: 1_000 }), false)
    assert.equal(hasPendingDayWikiReview({ coveredThrough: 1_000, wikiCoveredThrough: 1_100 }), false)
  })

  it('does not automatically backfill legacy Days or Days that have not been analyzed', () => {
    assert.equal(hasPendingDayWikiReview(null), false)
    assert.equal(hasPendingDayWikiReview({ coveredThrough: 1_000 }), false)
    assert.equal(nextDayWithPendingWikiReview([{ ...pendingDay, memory: null }], 10_000, 600), null)
    assert.equal(
      nextDayWithPendingWikiReview(
        [{ ...pendingDay, memory: { coveredThrough: 1_000, refreshedAt: 1_100 } }],
        10_000,
        600
      ),
      null
    )
  })

  it('retries both active and ended Days after the configured interval', () => {
    const endedDay = { ...pendingDay, id: 'ended-day', endedAt: 1_000 }
    assert.equal(nextDayWithPendingWikiReview([pendingDay], 1_699, 600), null)
    assert.equal(nextDayWithPendingWikiReview([pendingDay], 1_700, 600), pendingDay)
    assert.equal(nextDayWithPendingWikiReview([endedDay], 1_700, 600), endedDay)
  })

  it('waits after a long failed retry completes instead of retrying immediately', () => {
    const failedDay = {
      ...pendingDay,
      refresh: { status: 'failed' as const, run: { startedAt: 2_000, completedAt: 5_000 } },
    }
    assert.equal(nextDayWithPendingWikiReview([failedDay], 5_599, 600), null)
    assert.equal(nextDayWithPendingWikiReview([failedDay], 5_600, 600), failedDay)
  })

  it('stops scheduling retries once Wiki coverage catches up', () => {
    const reviewedDay = { ...pendingDay, memory: { ...pendingDay.memory, wikiCoveredThrough: 1_000 } }
    assert.equal(nextDayWithPendingWikiReview([reviewedDay], 10_000, 600), null)
  })

  it('does not start a retry while any Day refresh is running', () => {
    const refreshingDay = {
      ...pendingDay,
      id: 'other-day',
      refresh: { status: 'refreshing' as const, run: { startedAt: 1_000, completedAt: null } },
    }
    assert.equal(nextDayWithPendingWikiReview([pendingDay, refreshingDay], 10_000, 600), null)
  })

  it('selects one oldest due attempt so a repeatedly deferred Day does not starve other Days', () => {
    const olderDay = {
      ...pendingDay,
      id: 'older-day',
      endedAt: 500,
      memory: { ...pendingDay.memory, refreshedAt: 800 },
      refresh: { status: 'idle' as const, run: { startedAt: 500, completedAt: 800 } },
    }
    assert.equal(nextDayWithPendingWikiReview([pendingDay, olderDay], 1_700, 600), olderDay)
    const retriedDay = { ...olderDay, refresh: { ...olderDay.refresh, run: { startedAt: 1_700, completedAt: 1_800 } } }
    assert.equal(nextDayWithPendingWikiReview([retriedDay, pendingDay], 1_800, 600), pendingDay)
  })

  it('waits for ended-Day transcription while allowing active-Day completed evidence to retry', () => {
    const transcribingDay = {
      ...pendingDay,
      moments: [{ status: 'transcribing' as const }],
    }
    const endedDay = { ...transcribingDay, id: 'ended-day', endedAt: 1_000 }
    assert.equal(nextDayWithPendingWikiReview([endedDay], 1_700, 600), null)
    assert.equal(nextDayWithPendingWikiReview([endedDay, transcribingDay], 1_700, 600), transcribingDay)
  })
})
