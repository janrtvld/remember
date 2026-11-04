import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ConversationEpisode, ConversationSummary } from '@remember/shared'
import { privacySafeError, sanitizeSentryEvent } from '../errorReportingSanitizer'
import {
  automaticRevinoteCandidates,
  automaticRevinoteFailureReport,
  automaticRevinoteSummarySkipEpisodeIds,
  failedAutomaticRevinoteConversation,
  isTerminalAutomaticRevinoteError,
  preserveAutomaticRevinoteExclusions,
  routeNewFinishedConversationsToRevinote,
} from './automaticRevinoteProcessing'

function episode(id: string, state: ConversationEpisode['state'] = 'final'): ConversationEpisode {
  return {
    id,
    workdayId: 'day-1',
    startedAt: 1_000,
    endedAt: 2_000,
    state,
    surfaceKey: 'zoom:call',
    provider: 'zoom',
    boundaryReason: state === 'final' ? 'call-ended' : 'open',
    segmentIds: ['segment-1'],
    deletedAt: null,
    automaticRevinoteProcessingBlocked: false,
    userDecision: 'confirmed',
  }
}

function conversation(episodeId: string, patch: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    episodeId,
    startTime: '10:00',
    endTime: '10:15',
    title: 'Design review',
    description: 'The generated local result.',
    summary: 'A local summary.',
    actionPoints: ['Ship it'],
    ...patch,
  }
}

describe('automatic Revinote processing', () => {
  it('reports known automatic failures with bounded codes and the actual retry decision', () => {
    for (const code of [
      'conversation-audio-not-found',
      'revinote-permission-required',
      'revinote-authentication-failed',
      'revinote-automatic-processing-unavailable',
      'revinote-minutes-required',
      'revinote-plan-required',
      'revinote-post-process-upload-failed',
      'revinote-post-process-response-invalid',
      'revinote-post-process-state-unknown',
      'revinote-post-process-failed',
      'network-request-timeout',
    ]) {
      const error = new Error(code)
      const retryAutomatically = !isTerminalAutomaticRevinoteError(error)
      assert.deepEqual(
        automaticRevinoteFailureReport(error, { retryAutomatically, elapsedMs: 250, interrupted: false }),
        {
          area: 'revinote-post-process',
          code: code === 'network-request-timeout' ? 'revinote-post-process-timeout' : code,
          tags: { provider: 'revinote', phase: 'automatic', reason: retryAutomatically ? 'retryable' : 'terminal' },
          diagnostics: { elapsed_ms: 250 },
        }
      )
    }
  })

  it('does not report deliberate offline, disconnect, cancellation, or disposal', () => {
    const input = { retryAutomatically: false, elapsedMs: 250, interrupted: false }
    for (const error of [
      new Error('offline-mode-enabled'),
      new Error('network-request-cancelled'),
      new Error('revinote-not-connected'),
      Object.assign(new Error('Cancelled'), { name: 'AbortError' }),
      Object.assign(new Error('Cancelled'), { code: 'ABORT_ERR' }),
    ]) {
      assert.equal(automaticRevinoteFailureReport(error, input), null)
    }
    assert.equal(
      automaticRevinoteFailureReport(new Error('revinote-post-process-upload-failed'), { ...input, interrupted: true }),
      null
    )
  })

  it('never places arbitrary backend or user content in telemetry codes or diagnostics', () => {
    const privateMessage = 'Confidential meeting with private@example.com https://storage.example/audio?token=secret'
    for (const error of [
      new Error(privateMessage),
      new Error(`revinote-post-process-upload-failed: ${privateMessage}`),
      privateMessage,
      { message: privateMessage },
    ]) {
      const report = automaticRevinoteFailureReport(error, {
        retryAutomatically: true,
        elapsedMs: 250,
        interrupted: false,
      })
      assert.ok(report)
      assert.equal(report.code, 'revinote-post-process-failed')
      assert.deepEqual(report.diagnostics, { elapsed_ms: 250 })
      const safeError = privacySafeError(error, report.code)
      const event = sanitizeSentryEvent({
        tags: { app_area: report.area, error_code: report.code, ...report.tags },
        extra: { diagnostics: report.diagnostics },
        exception: { values: [{ type: safeError.name, value: safeError.message }] },
      })
      assert.deepEqual(event.tags, {
        app_area: 'revinote-post-process',
        error_code: 'revinote-post-process-failed',
        provider: 'revinote',
        phase: 'automatic',
        reason: 'retryable',
      })
      assert.deepEqual(event.extra, { diagnostics: { elapsed_ms: 250 } })
      assert.doesNotMatch(JSON.stringify({ report, event }), /Confidential|private@|storage\.example|secret/)
    }
  })

  it('waits for user approval before routing a recognized conversation', () => {
    const unconfirmed = { ...episode('episode-new'), userDecision: null }
    const [result] = routeNewFinishedConversationsToRevinote({
      enabled: true,
      previous: [],
      generated: [conversation('episode-new')],
      episodes: [unconfirmed],
    })

    assert.equal(result?.processingProvider, undefined)
    assert.deepEqual([...automaticRevinoteSummarySkipEpisodeIds([unconfirmed], new Set())], [])
  })

  it('routes only newly recognized finished conversations and retains local content for terminal fallback', () => {
    const existing = conversation('episode-existing')
    const generated = [existing, conversation('episode-new'), conversation('episode-active')]

    const result = routeNewFinishedConversationsToRevinote({
      enabled: true,
      previous: [existing],
      generated,
      episodes: [episode('episode-existing'), episode('episode-new'), episode('episode-active', 'provisional')],
    })

    assert.equal(result[0]?.processingProvider, undefined)
    assert.equal(result[1]?.processingProvider, 'revinote')
    assert.equal(result[1]?.processing, 'processing')
    assert.equal(result[1]?.title, 'Design review')
    assert.equal(result[1]?.description, 'The generated local result.')
    assert.equal(result[1]?.summary, 'A local summary.')
    assert.deepEqual(result[1]?.actionPoints, ['Ship it'])
    assert.equal(result[2]?.processingProvider, undefined)
  })

  it('keeps a durable Revinote placeholder routed after the setting is disabled', () => {
    const pending = conversation('episode-new', {
      processing: 'processing',
      processingProvider: 'revinote',
    })
    const [result] = routeNewFinishedConversationsToRevinote({
      enabled: false,
      previous: [pending],
      generated: [conversation('episode-new')],
      episodes: [episode('episode-new')],
    })

    assert.equal(result?.processingProvider, 'revinote')
    assert.equal(automaticRevinoteCandidates([result as ConversationSummary], [episode('episode-new')]).length, 1)
  })

  it('keeps failed uploads visible and retryable after restart and a Day refresh', () => {
    const failed = failedAutomaticRevinoteConversation(
      conversation('episode-new', { processing: 'processing', processingProvider: 'revinote' }),
      true
    )
    const restored = JSON.parse(JSON.stringify(failed)) as ConversationSummary
    const [refreshed] = routeNewFinishedConversationsToRevinote({
      enabled: false,
      previous: [restored],
      generated: [conversation('episode-new')],
      episodes: [episode('episode-new')],
    })

    assert.equal(refreshed?.processing, undefined)
    assert.equal(refreshed?.processingError, 'revinote')
    assert.equal(refreshed?.summary, 'A local summary.')
    assert.equal(automaticRevinoteCandidates([refreshed as ConversationSummary], [episode('episode-new')]).length, 1)
  })

  it('does not retry ambiguous uploaded completions automatically or discard the local result', () => {
    const error = new Error('revinote-post-process-state-unknown')
    assert.equal(isTerminalAutomaticRevinoteError(error), true)
    assert.equal(isTerminalAutomaticRevinoteError(new Error('revinote-post-process-upload-failed')), false)
    const failed = failedAutomaticRevinoteConversation(
      conversation('episode-new', { processing: 'processing', processingProvider: 'revinote' }),
      !isTerminalAutomaticRevinoteError(error)
    )

    assert.equal(failed.processing, undefined)
    assert.equal(failed.processingError, 'revinote')
    assert.equal(failed.summary, 'A local summary.')
    assert.deepEqual(automaticRevinoteCandidates([failed], [episode('episode-new')]), [])
    const [refreshed] = routeNewFinishedConversationsToRevinote({
      enabled: true,
      previous: [failed],
      generated: [conversation('episode-new')],
      episodes: [episode('episode-new')],
    })
    assert.equal(refreshed?.processingError, 'revinote')
    assert.equal(refreshed?.processingProvider, undefined)
  })

  it('retries an explicitly recorded manual meeting without requiring the always-on confirmation step', () => {
    const manual = { ...episode('episode-manual'), surfaceKey: 'manual:meeting-1', userDecision: null }
    const failed = failedAutomaticRevinoteConversation(
      conversation(manual.id, { manualMeetingId: 'meeting-1', processingProvider: 'revinote' }),
      true
    )
    assert.equal(automaticRevinoteCandidates([failed], [manual]).length, 1)
    assert.deepEqual(automaticRevinoteCandidates([{ ...failed, manualMeetingId: 'other-meeting' }], [manual]), [])
    assert.deepEqual(
      automaticRevinoteCandidates([failed], [{ ...manual, automaticRevinoteProcessingBlocked: true }]),
      []
    )
  })

  it('keeps an episode finalized offline out of later automatic upload and gives it a local summary', () => {
    const provisional = preserveAutomaticRevinoteExclusions(
      [episode('episode-offline', 'provisional')],
      []
    )[0] as ConversationEpisode
    const finalized = preserveAutomaticRevinoteExclusions(
      [{ ...provisional, state: 'final', boundaryReason: 'call-ended' }],
      [provisional],
      new Set(['episode-offline'])
    )[0] as ConversationEpisode
    const [result] = routeNewFinishedConversationsToRevinote({
      enabled: true,
      previous: [],
      generated: [conversation('episode-offline')],
      episodes: [finalized],
    })

    assert.equal(provisional.automaticRevinoteProcessingBlocked, false)
    assert.equal(finalized.automaticRevinoteProcessingBlocked, true)
    assert.equal(result?.processing, undefined)
    assert.equal(result?.processingProvider, undefined)
    assert.equal(
      automaticRevinoteCandidates([conversation('episode-offline', { processingProvider: 'revinote' })], [finalized])
        .length,
      0
    )
    assert.deepEqual([...automaticRevinoteSummarySkipEpisodeIds([finalized], new Set())], [])
    assert.equal(
      preserveAutomaticRevinoteExclusions([finalized], [finalized])[0]?.automaticRevinoteProcessingBlocked,
      true
    )
  })
})
