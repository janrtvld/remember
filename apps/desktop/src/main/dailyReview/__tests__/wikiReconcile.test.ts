import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { dayWikiManagedBody, materializeDayWikiEdits } from '../dayWikiEdits'
import { reconcileWikiPageUpdates, wikiMaintenanceIdentityPages } from '../wikiReconcile'

// Real generated pages from 2026-08-25: one refresh created both of these
// about the same subject in a single batch.
const CONVERSATION_TRANSCRIPTION_BODY = `## Direction

Improve conversation quality through a privacy-preserving hybrid pipeline: local capture and conversation gating, followed by batch cloud transcription only for accepted conversation episodes, then existing conversation-aware analysis.

## Current state

Conversation episode grouping now survives call-window churn. A replay of the captured Woub meeting produced one 92-minute episode, and Revinote deduplication reduced duplicate conversation cards to one canonical meeting.

Current raw WAV audio is deleted after local transcription, so accepted conversations still cannot be sent to a cloud provider for a quality pass.

## Decisions

- Keep accepted episode audio in an encrypted temporary spool rather than deleting it immediately.
- Preserve original local evidence separately from cloud-derived transcript output.
- Submit audio only after the episode closes, with short boundary padding.
- Preserve timestamped, speaker-attributed provider output as the canonical transcript.

## Constraints

Do not stream a full day of audio to the cloud or purchase generic cloud audio cleanup. Cloud transcription cannot restore speech never captured, and broad upload is a poor privacy boundary.

## Provider evaluation

Run a private bake-off using ten real conversations between ElevenLabs Scribe v2 and Deepgram Nova-3. Evaluate Dutch and code-switched speech, far-field and noisy audio, diarization, keyterms, timestamps, cost, and retention terms.

## Remaining work

- Define the bounded retention policy, cleanup-job model, consent flow, and UI copy before any cloud upload ships.
- Run the provider bake-off and select a provider.`

const CLOUD_TRANSCRIPTION_BODY = `## Direction

Remember should use cloud transcription only for conversations the user has accepted for retention. The cloud path must receive the retained conversation audio, not only the imperfect local transcript, so it can materially improve transcription quality.

## Constraints

- Preserve privacy boundaries through explicit acceptance and retention.
- Evaluate providers for quality, retention terms, Dutch performance, and code-switching performance.
- Reliable grouping of local audio into conversations is still required before the cloud path can be well defined.

## Remaining work

- Run a privacy and quality bake-off using real accepted Remember conversations.
- Decide conversation-grouping behavior and whether to offer an opt-in clean-up action.
- Select a provider after the evaluation.`

const WIKI_ARCHITECTURE_BODY = `## Direction

Wiki pages are plain readable Markdown files with one managed region per page. Human-authored sections stay outside the managed markers and are never rewritten by generated updates.

## Decisions

- Slugs express the visible hierarchy; a project overview is the root page and durable topics are child pages.
- The index is regenerated from page files instead of being edited directly.

## Remaining work

- Decide how page renames should preserve inbound links.`

const CLOUD_SYNC_BODY = `## Direction

Shared spaces sync through Remember's hosted API so teammates can edit the same Wiki. The local cache keeps pages available between successful synchronisations.

## Decisions

- Page updates include the last synced version so stale changes cannot overwrite newer edits.
- Failed uploads stay pending for the next sync attempt.

## Remaining work

- Surface a visible sync-failure state instead of a silent stale cache.`

function update(slug: string, title: string, content: string, changeType: 'created' | 'updated' = 'created') {
  return { slug, title, content, summary: `Reconciled ${title}.`, changeType }
}

describe('wiki reconcile', () => {
  it('does not identify people by similar names and overlapping project context', () => {
    const context = 'Works on Woub planning with Jan and discusses mobile releases and customer delivery.'
    const first = update('people/tom', 'Tom', context)
    const second = update('people/tom-jones', 'Tom Jones', context)
    const existing = [{ slug: first.slug, title: first.title, content: context }]

    assert.deepEqual(reconcileWikiPageUpdates(existing, [second]), { updates: [second], notes: [] })
    assert.deepEqual(reconcileWikiPageUpdates([], [first, second]), { updates: [first, second], notes: [] })
  })

  it('updates an explicitly selected person slug without merging another biography', () => {
    const context = 'Works on Woub planning with Jan and discusses mobile releases and customer delivery.'
    const current = update('people/tom', 'Tom', context, 'updated')
    const other = update('people/tom-jones', 'Tom Jones', context)
    const result = reconcileWikiPageUpdates(
      [
        { slug: current.slug, title: current.title, content: context },
        { slug: other.slug, title: other.title, content: context },
      ],
      [current, other]
    )
    assert.deepEqual(result, { updates: [current, other], notes: [] })
  })

  it('resolves a pending-proposal alias before materializing the existing page', () => {
    const body =
      'Camera budget remains four hundred euros. Flight reservations settled. Packing excludes checked luggage.'
    const pages = [
      {
        slug: 'projects/trip',
        title: 'Trip',
        content: `<!-- remember-managed:start -->\n${body}\n<!-- remember-managed:end -->`,
      },
    ]
    const proposal = {
      slug: 'projects/trip',
      title: 'Trip',
      content: 'Checkout becomes October Monday.',
      status: 'pending' as const,
    }
    const focused = update('projects/trip-guide', 'Trip guide', proposal.content, 'updated')
    assert.equal(reconcileWikiPageUpdates(pages, [focused]).updates[0]?.slug, focused.slug)

    const identities = wikiMaintenanceIdentityPages(pages, [proposal])
    const canonical = reconcileWikiPageUpdates(identities, [focused]).updates[0]
    assert.ok(canonical)
    const current = pages.find((page) => page.slug === canonical.slug)
    assert.ok(current)
    assert.equal(canonical.slug, current.slug)
    const managedBody = dayWikiManagedBody(current.content)
    assert.ok(managedBody)
    const materialized = materializeDayWikiEdits(canonical, managedBody, {
      summary: 'Confirm the checkout.',
      edits: [{ oldText: 'Flight reservations settled.', newText: `Flight reservations settled. ${proposal.content}` }],
    })
    assert.ok(materialized)
    assert.equal(
      materialized.content,
      body.replace('Flight reservations settled.', `Flight reservations settled. ${proposal.content}`)
    )
    assert.deepEqual(reconcileWikiPageUpdates(identities, [materialized]).updates, [materialized])
  })

  it('does not use dismissed or completed proposal bodies as new alias targets', () => {
    const proposal = { slug: 'projects/trip', title: 'Trip', content: 'Checkout becomes October Monday.' }
    const pages = [{ ...proposal, content: 'Flights and camera budget.' }]
    const focused = update('projects/trip-guide', 'Trip guide', proposal.content, 'updated')
    for (const status of ['applied', 'dismissed', 'superseded'] as const) {
      const identities = wikiMaintenanceIdentityPages(pages, [{ ...proposal, status }])
      assert.deepEqual(identities, pages)
      assert.deepEqual(reconcileWikiPageUpdates(identities, [focused]).updates, [focused])
    }
  })

  it('keeps one page when a single batch creates the same subject twice', () => {
    const { updates, notes } = reconcileWikiPageUpdates(
      [],
      [
        update('projects/remember/transcription', 'Cloud Transcription', CLOUD_TRANSCRIPTION_BODY),
        update(
          'projects/remember/conversation-transcription',
          'Conversation Transcription',
          CONVERSATION_TRANSCRIPTION_BODY
        ),
      ]
    )

    assert.equal(updates.length, 1)
    assert.equal(updates[0]?.slug, 'projects/remember/conversation-transcription')
    assert.deepEqual(notes, [
      {
        type: 'merged',
        keptSlug: 'projects/remember/conversation-transcription',
        droppedSlug: 'projects/remember/transcription',
      },
    ])
  })

  it('retargets a creation that duplicates an existing page under another slug', () => {
    const { updates, notes } = reconcileWikiPageUpdates(
      [{ slug: 'projects/remember/transcription', title: 'Cloud Transcription', content: CLOUD_TRANSCRIPTION_BODY }],
      [
        update(
          'projects/remember/conversation-transcription',
          'Conversation Transcription',
          CONVERSATION_TRANSCRIPTION_BODY
        ),
      ]
    )

    assert.equal(updates.length, 1)
    assert.equal(updates[0]?.slug, 'projects/remember/transcription')
    assert.equal(updates[0]?.changeType, 'updated')
    assert.equal(updates[0]?.content, CONVERSATION_TRANSCRIPTION_BODY)
    assert.deepEqual(notes, [
      {
        type: 'retargeted',
        fromSlug: 'projects/remember/conversation-transcription',
        toSlug: 'projects/remember/transcription',
      },
    ])
  })

  it('keeps genuinely distinct sibling pages separate despite related names', () => {
    const { updates, notes } = reconcileWikiPageUpdates(
      [],
      [
        update('projects/remember/wiki', 'Wiki', WIKI_ARCHITECTURE_BODY),
        update('projects/remember/wiki-sync', 'Wiki Sync', CLOUD_SYNC_BODY),
      ]
    )

    assert.equal(updates.length, 2)
    assert.deepEqual(notes, [])
  })

  it('never merges a child page into its parent project page', () => {
    const { updates, notes } = reconcileWikiPageUpdates(
      [{ slug: 'projects/remember', title: 'Remember', content: CONVERSATION_TRANSCRIPTION_BODY }],
      [
        update(
          'projects/remember/conversation-transcription',
          'Conversation Transcription',
          CONVERSATION_TRANSCRIPTION_BODY
        ),
      ]
    )

    assert.equal(updates.length, 1)
    assert.equal(updates[0]?.slug, 'projects/remember/conversation-transcription')
    assert.deepEqual(notes, [])
  })

  it('collapses exact duplicate slugs in one batch keeping the richer body', () => {
    const { updates, notes } = reconcileWikiPageUpdates(
      [],
      [
        update('projects/remember/transcription', 'Transcription', CLOUD_TRANSCRIPTION_BODY),
        update('projects/remember/transcription', 'Transcription', CONVERSATION_TRANSCRIPTION_BODY),
      ]
    )

    assert.equal(updates.length, 1)
    assert.equal(updates[0]?.content, CONVERSATION_TRANSCRIPTION_BODY)
    assert.equal(notes.length, 1)
    assert.equal(notes[0]?.type, 'merged')
  })

  it('leaves ordinary updates to existing pages untouched', () => {
    const input = [
      update('projects/remember/transcription', 'Cloud Transcription', CLOUD_TRANSCRIPTION_BODY, 'updated'),
    ]
    const { updates, notes } = reconcileWikiPageUpdates(
      [
        { slug: 'projects/remember/transcription', title: 'Cloud Transcription', content: CLOUD_TRANSCRIPTION_BODY },
        {
          slug: 'projects/remember/conversation-transcription',
          title: 'Conversation Transcription',
          content: CONVERSATION_TRANSCRIPTION_BODY,
        },
      ],
      input
    )

    assert.deepEqual(updates, input)
    assert.deepEqual(notes, [])
  })

  it('prefers the existing slug when an update and a creation cover the same subject', () => {
    const { updates, notes } = reconcileWikiPageUpdates(
      [{ slug: 'projects/remember/transcription', title: 'Cloud Transcription', content: CLOUD_TRANSCRIPTION_BODY }],
      [
        update('projects/remember/transcription', 'Cloud Transcription', CLOUD_TRANSCRIPTION_BODY, 'updated'),
        update(
          'projects/remember/conversation-transcription',
          'Conversation Transcription',
          CONVERSATION_TRANSCRIPTION_BODY
        ),
      ]
    )

    assert.equal(updates.length, 1)
    assert.equal(updates[0]?.slug, 'projects/remember/transcription')
    assert.equal(updates[0]?.content, CONVERSATION_TRANSCRIPTION_BODY)
    assert.equal(notes.length, 2)
    assert.equal(notes[0]?.type, 'retargeted')
    assert.equal(notes[1]?.type, 'merged')
  })

  it('does not merge unrelated new pages that only share a parent', () => {
    const { updates, notes } = reconcileWikiPageUpdates(
      [],
      [
        update('projects/remember/transcription', 'Cloud Transcription', CLOUD_TRANSCRIPTION_BODY),
        update('projects/remember/cloud-sync', 'Cloud Sync', CLOUD_SYNC_BODY),
      ]
    )

    assert.equal(updates.length, 2)
    assert.deepEqual(notes, [])
  })
})
