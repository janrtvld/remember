import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { WikiPageUpdate } from '@remember/shared'
import { materializeDayWikiEdits } from '../dayWikiEdits'
import {
  dayWikiAnalysisWindow,
  ensureDayWikiReviewTarget,
  generateOptionalDayWikiUpdates,
  hasUnacceptedDayWikiEdit,
} from '../dayWikiUpdates'
import { reconcileWikiPageUpdates, wikiMaintenanceIdentityPages } from '../wikiReconcile'
import { reviewedWikiSuggestions, wikiSuggestionSources } from '../wikiSuggestionPolicy'

const suggestion: WikiPageUpdate = {
  slug: 'projects/remember',
  title: 'Remember',
  content: 'Use pnpm.',
  summary: 'Use pnpm for this project.',
  changeType: 'updated',
}

test('a rejected materialized correction retains its Wiki evidence while a no-op or accepted edit completes', () => {
  const currentBody = 'Use npm. Preserve the existing budget.'
  const materialized = materializeDayWikiEdits(suggestion, currentBody, {
    summary: 'Use pnpm.',
    edits: [{ oldText: 'Use npm.', newText: 'Use pnpm.' }],
  })
  assert.ok(materialized)
  const rejected = reviewedWikiSuggestions({ accepted: [] }, [materialized], [])
  const previousWikiThrough = 500
  const coveredThrough = 1_000
  const wikiCoveredThrough = hasUnacceptedDayWikiEdit(materialized, rejected) ? previousWikiThrough : coveredThrough
  assert.equal(wikiCoveredThrough, previousWikiThrough)
  assert.equal(dayWikiAnalysisWindow(100, { coveredThrough, wikiCoveredThrough }, 'active-interval').after, 500)

  const noOp = materializeDayWikiEdits(suggestion, currentBody, { summary: '', edits: [] })
  assert.equal(noOp, null)
  assert.equal(hasUnacceptedDayWikiEdit(noOp, []), false)
  const source = { id: 'source', kind: 'screen-context', observedAt: 600, text: 'Use pnpm.' }
  const accepted = reviewedWikiSuggestions(
    { accepted: [{ index: 0, sourceId: source.id, quote: source.text }] },
    [materialized],
    [source]
  )
  assert.equal(hasUnacceptedDayWikiEdit(materialized, accepted), false)
})

test('no Wiki candidates completes without a deferral', async () => {
  const result = await generateOptionalDayWikiUpdates({
    suggestions: [],
    review: async (candidates) => {
      assert.deepEqual(candidates, [])
      return []
    },
    onDeferred: () => assert.fail('An empty candidate set must not schedule a retry'),
  })
  assert.deepEqual(result, [])
})

test('a proposal created during review cannot retarget a materialized Day update', async () => {
  const materialized = {
    ...suggestion,
    slug: 'projects/trip-guide',
    title: 'Trip guide',
    content: 'Checkout becomes October Monday.',
  }
  const newProposal = {
    slug: 'projects/trip',
    title: 'Trip',
    content: materialized.content,
    status: 'pending' as const,
  }
  const deferred: string[] = []
  const result = await generateOptionalDayWikiUpdates({
    suggestions: [materialized],
    review: async () => {
      const accepted = reconcileWikiPageUpdates(wikiMaintenanceIdentityPages([], [newProposal]), [materialized]).updates
      assert.equal(accepted[0]?.slug, 'projects/trip')
      return ensureDayWikiReviewTarget(materialized, accepted)
    },
    onDeferred: (stage, code) => deferred.push(`${stage}:${code}`),
  })
  assert.deepEqual(result, [])
  assert.deepEqual(deferred, ['review:agent-invalid-response'])
  assert.deepEqual(ensureDayWikiReviewTarget(materialized, []), [])
  assert.deepEqual(ensureDayWikiReviewTarget(materialized, [materialized]), [materialized])
})

test('manual and end-of-day refresh review the same earlier evidence that synthesis can use', () => {
  for (const reason of ['manual', 'end-of-day'] as const) {
    const window = dayWikiAnalysisWindow(100, { coveredThrough: 900, wikiCoveredThrough: 900 }, reason)
    assert.equal(window.after, null)
    const sources = wikiSuggestionSources(
      [{ kind: 'screen-context', evidenceId: 'morning-decision', timestamp: 200, text: 'Use pnpm.' }],
      [],
      window.wikiAfter,
      1_000
    )
    assert.equal(sources[0]?.id, 'morning-decision')
  }
})

test('existing Days without Wiki coverage revisit captured evidence once', () => {
  const recovered = dayWikiAnalysisWindow(100, { coveredThrough: 900 }, 'active-interval')
  assert.equal(recovered.after, 99)
  assert.equal(recovered.wikiAfter, 99)
  const incremental = dayWikiAnalysisWindow(
    100,
    { coveredThrough: 1_000, wikiCoveredThrough: 1_000 },
    'active-interval'
  )
  assert.equal(incremental.after, 1_000)
  assert.equal(incremental.wikiAfter, 1_000)
})

test('a deferred Wiki review preserves the evidence needed by the next successful Day refresh', async () => {
  const window = dayWikiAnalysisWindow(100, { coveredThrough: 900, wikiCoveredThrough: 500 }, 'active-interval')
  let wikiCoveredThrough = 1_000
  const updates = await generateOptionalDayWikiUpdates({
    suggestions: [suggestion],
    review: async () => {
      throw new Error('agent-rate-limited')
    },
    onDeferred: () => {
      wikiCoveredThrough = window.previousWikiThrough
    },
  })
  assert.deepEqual(updates, [])
  const next = dayWikiAnalysisWindow(100, { coveredThrough: 1_000, wikiCoveredThrough }, 'active-interval')
  assert.equal(next.after, 500)
  const sources = wikiSuggestionSources(
    [{ kind: 'screen-context', evidenceId: 'decision', timestamp: 600, text: 'Use pnpm.' }],
    [],
    next.wikiAfter,
    1_100
  )
  assert.equal(
    reviewedWikiSuggestions(
      { accepted: [{ index: 0, sourceId: 'decision', quote: 'Use pnpm.' }] },
      [suggestion],
      sources
    ).length,
    1
  )
})

test('Wiki generation failure retains day suggestions and still requires evidence review', async () => {
  const source = { id: 'source', kind: 'screen-context', observedAt: 100, text: 'Use pnpm.' }
  const candidates = [suggestion, { ...suggestion, slug: 'unsupported' }]
  const deferred: string[] = []
  const updates = await generateOptionalDayWikiUpdates({
    suggestions: candidates,
    generate: async () => {
      throw new Error('Claude Code process exited with code 1')
    },
    review: async (suggestions) => {
      assert.deepEqual(suggestions, candidates)
      return reviewedWikiSuggestions(
        { accepted: [{ index: 0, sourceId: source.id, quote: source.text }] },
        suggestions,
        [source]
      )
    },
    onDeferred: (stage, errorCode) => deferred.push(`${stage}:${errorCode}`),
  })

  assert.deepEqual(updates, [
    {
      ...suggestion,
      evidence: [{ sourceId: source.id, kind: source.kind, observedAt: source.observedAt, quote: source.text }],
    },
  ])
  assert.deepEqual(candidates, [suggestion, { ...suggestion, slug: 'unsupported' }])
  assert.deepEqual(deferred, ['generation:agent-failed'])
})

test('Wiki review failure returns no unreviewed writes and leaves day candidates unchanged', async () => {
  const candidates = [suggestion]
  const deferred: string[] = []
  const updates = await generateOptionalDayWikiUpdates({
    suggestions: candidates,
    generate: async () => [{ ...suggestion, slug: 'projects/other' }],
    review: async (suggestions) => {
      assert.equal(suggestions.length, 2)
      throw new Error('agent-rate-limited')
    },
    onDeferred: (stage, errorCode) => deferred.push(`${stage}:${errorCode}`),
  })

  assert.deepEqual(updates, [])
  assert.deepEqual(candidates, [suggestion])
  assert.deepEqual(deferred, ['review:agent-rate-limited'])
})

test('successful generation combines at most sixteen candidates and returns only the reviewed result', async () => {
  const candidates = Array.from({ length: 15 }, (_, index) => ({ ...suggestion, slug: `projects/${index}` }))
  const contextUpdate = { ...suggestion, slug: 'projects/context' }
  const updates = await generateOptionalDayWikiUpdates({
    suggestions: candidates,
    generate: async () => [contextUpdate, { ...suggestion, slug: 'projects/overflow' }],
    review: async (suggestions) => {
      assert.deepEqual(suggestions, [...candidates, contextUpdate])
      return [contextUpdate]
    },
    onDeferred: () => assert.fail('Successful Wiki updates must not be deferred'),
  })
  assert.deepEqual(updates, [contextUpdate])
})

test('known provider failures during review let the day complete without new Wiki writes', async () => {
  for (const message of [
    'agent-failed',
    'agent-invalid-response',
    'claude-timeout',
    'agent-cli-missing',
    'claude-auth-required',
    'Codex Exec exited with code 1: provider failure',
    'Selected model is at capacity. Please try a different model.',
  ]) {
    const deferred: string[] = []
    const updates = await generateOptionalDayWikiUpdates({
      suggestions: [suggestion],
      review: async () => {
        throw new Error(message)
      },
      onDeferred: (stage) => deferred.push(stage),
    })
    assert.deepEqual(updates, [], message)
    assert.deepEqual(deferred, ['review'], message)
  }
})

test('cancellation, policy and unexpected errors remain fatal through both optional stages', async () => {
  const boundaries = [
    new DOMException('The operation was aborted', 'AbortError'),
    Object.assign(new Error('The operation failed'), { code: 'ABORT_ERR' }),
    new Error('network-request-cancelled'),
    new Error('agent-interrupted'),
    new Error('day-refresh-invalidated-by-deletion'),
    new Error('agent-analysis-consent-required'),
    new Error('offline-mode-enabled'),
    new Error('agent-learning-invalid-review-evidence'),
    new TypeError('Cannot read network settings'),
  ]
  for (const boundary of boundaries) {
    const errors = [boundary, new Error('agent-failed', { cause: new Error('provider wrapper', { cause: boundary }) })]
    for (const error of errors) {
      for (const stage of ['generation', 'review'] as const) {
        const fail = async () => {
          throw error
        }
        await assert.rejects(
          generateOptionalDayWikiUpdates({
            suggestions: [suggestion],
            generate: stage === 'generation' ? fail : undefined,
            review: stage === 'review' ? fail : async () => assert.fail('Review ran after fatal generation failure'),
            onDeferred: () => assert.fail('Fatal errors must not be deferred'),
          }),
          (failure: unknown) => failure === error
        )
      }
    }
  }
})

test('unknown errors are propagated instead of being assumed to be provider failures', async () => {
  for (const message of [
    'unexpected-evidence-store-failure',
    'EACCES: permission denied, open /private/network/data',
  ]) {
    const error = new Error(message)
    await assert.rejects(
      generateOptionalDayWikiUpdates({
        suggestions: [suggestion],
        review: async () => {
          throw error
        },
        onDeferred: () => assert.fail('Unknown failures must not be deferred'),
      }),
      (failure: unknown) => failure === error
    )
  }
})
