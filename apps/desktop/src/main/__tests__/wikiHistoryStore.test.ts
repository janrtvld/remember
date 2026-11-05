import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, it } from 'node:test'
import { attributeAgentWikiSuggestionsToDays } from '../wikiDayAttribution'
import {
  abortWikiPageRevision,
  beginWikiPageRevision,
  closeWikiHistoryStore,
  createWikiProposal,
  getWikiPageAnalysisEditContext,
  getWikiPageHistory,
  getWikiPageRevision,
  getWikiProposal,
  initializeWikiHistoryStore,
  isWikiEvidenceRejected,
  listWikiProposals,
  moveWikiPageHistories,
  readWikiContextCheckpoints,
  reconcilePendingWikiPageRevision,
  recordWikiContextCheckpoints,
  recordWikiPageRevision,
  rejectWikiRevisionEvidence,
  setWikiProposalStatus,
  wikiProposalFeedback,
} from '../wikiHistoryStore'

const directories: string[] = []

afterEach(async () => {
  closeWikiHistoryStore()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function historyDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'remember-wiki-history-'))
  directories.push(directory)
  initializeWikiHistoryStore(directory)
  return directory
}

describe('wiki page history', () => {
  it('records actor, source and parent revision for complete snapshots', async () => {
    await historyDirectory()
    const created = recordWikiPageRevision({
      spaceId: 'personal',
      slug: 'projects/remember',
      title: 'Remember',
      content: 'Initial direction.',
      actor: 'remember',
      operation: 'created',
      sourceId: 'daily-review://day-1',
    })
    const updated = recordWikiPageRevision({
      spaceId: 'personal',
      slug: 'projects/remember',
      title: 'Remember',
      content: 'Corrected direction.',
      actor: 'user',
      operation: 'updated',
      sourceId: 'editor',
    })

    const history = getWikiPageHistory('personal', 'projects/remember')
    assert.ok(history)
    assert.equal(history.revisions.length, 2)
    assert.equal(history.headRevisionId, updated)
    assert.equal(history.revisions[0]?.actor, 'user')
    assert.equal(history.revisions[0]?.parentRevisionId, created)
    assert.equal(history.revisions[1]?.content, 'Initial direction.')
  })

  it('does not add a revision when title and content did not change', async () => {
    await historyDirectory()
    const first = recordWikiPageRevision({
      spaceId: 'personal',
      slug: 'projects/remember',
      title: 'Remember',
      content: 'Current direction.',
      actor: 'remember',
      operation: 'created',
    })
    const second = recordWikiPageRevision({
      spaceId: 'personal',
      slug: 'projects/remember',
      title: 'Remember',
      content: 'Current direction.',
      actor: 'remember',
      operation: 'updated',
    })

    assert.equal(second, first)
    assert.equal(getWikiPageHistory('personal', 'projects/remember')?.revisions.length, 1)
  })

  it('keeps a revision pending until the file write commits and recovers a completed write by hash', async () => {
    await historyDirectory()
    const pending = beginWikiPageRevision({
      spaceId: 'personal',
      slug: 'projects/remember',
      title: 'Remember',
      content: 'Crash-safe content.',
      actor: 'user',
      operation: 'created',
      sourceId: 'editor',
    })
    assert.equal(pending.pending, true)
    assert.deepEqual(getWikiPageHistory('personal', 'projects/remember')?.revisions, [])

    assert.equal(
      reconcilePendingWikiPageRevision('personal', 'projects/remember', 'Remember', 'Crash-safe content.'),
      true
    )
    assert.equal(getWikiPageHistory('personal', 'projects/remember')?.headRevisionId, pending.revisionId)
    assert.equal(getWikiPageHistory('personal', 'projects/remember')?.revisions[0]?.actor, 'user')
  })

  it('can abort a pending revision when the file write fails', async () => {
    await historyDirectory()
    const pending = beginWikiPageRevision({
      spaceId: 'personal',
      slug: 'projects/remember',
      title: 'Remember',
      content: 'Never written.',
      actor: 'remember',
      operation: 'created',
    })
    assert.equal(pending.pending, true)
    if (!pending.pending) throw new Error('expected-pending-revision')
    abortWikiPageRevision(pending.revisionId)
    assert.deepEqual(getWikiPageHistory('personal', 'projects/remember')?.revisions, [])
    assert.equal(reconcilePendingWikiPageRevision('personal', 'projects/remember', 'Remember', 'Never written.'), false)
  })

  it('keeps restore as a new revision even when restoring identical content', async () => {
    await historyDirectory()
    const original = recordWikiPageRevision({
      spaceId: 'personal',
      slug: 'projects/remember',
      title: 'Remember',
      content: 'Original.',
      actor: 'remember',
      operation: 'created',
    })
    recordWikiPageRevision({
      spaceId: 'personal',
      slug: 'projects/remember',
      title: 'Remember',
      content: 'Changed.',
      actor: 'user',
      operation: 'updated',
    })
    const restored = recordWikiPageRevision({
      spaceId: 'personal',
      slug: 'projects/remember',
      title: 'Remember',
      content: 'Original.',
      actor: 'user',
      operation: 'restored',
      sourceId: `restore://${original}`,
    })

    assert.notEqual(restored, original)
    assert.equal(getWikiPageRevision('personal', 'projects/remember', restored ?? '')?.operation, 'restored')
    assert.equal(getWikiPageHistory('personal', 'projects/remember')?.revisions.length, 3)
  })

  it('gives the analyzer the human changes made since Remember last rewrote the page', async () => {
    await historyDirectory()
    const rememberRevision = recordWikiPageRevision({
      spaceId: 'personal',
      slug: 'projects/remember/wiki',
      title: 'Wiki',
      content: 'Use automatic maintenance.',
      actor: 'remember',
      operation: 'created',
      sourceId: 'daily-review://day-1',
      createdAt: 10,
    })
    const userRevision = recordWikiPageRevision({
      spaceId: 'personal',
      slug: 'projects/remember/wiki',
      title: 'Wiki',
      content: 'Use automatic maintenance, with a per-space Suggest option.',
      actor: 'user',
      operation: 'updated',
      sourceId: 'editor',
      createdAt: 20,
    })

    const context = getWikiPageAnalysisEditContext('personal', 'projects/remember/wiki')
    assert.equal(context?.currentRevision.id, userRevision)
    assert.equal(context?.currentRevision.actor, 'user')
    assert.equal(context?.lastRememberRevision?.id, rememberRevision)
    assert.equal(context?.lastRememberRevision?.content, 'Use automatic maintenance.')
    assert.deepEqual(
      context?.changesSinceRemember.map(({ id, actor }) => ({ id, actor })),
      [{ id: userRevision, actor: 'user' }]
    )

    recordWikiPageRevision({
      spaceId: 'personal',
      slug: 'projects/remember/wiki',
      title: 'Wiki',
      content: 'Reconciled current direction.',
      actor: 'remember',
      operation: 'updated',
      sourceId: 'daily-review://day-2',
      createdAt: 30,
    })
    assert.deepEqual(getWikiPageAnalysisEditContext('personal', 'projects/remember/wiki')?.changesSinceRemember, [])
  })

  it('keeps the Remember baseline when replacing an identical imported destination during a move', async () => {
    await historyDirectory()
    const rememberRevision = recordWikiPageRevision({
      spaceId: 'personal',
      slug: 'projects/remember/wiki',
      title: 'Wiki',
      content: 'AI-maintained baseline.',
      actor: 'remember',
      operation: 'created',
      sourceId: 'daily-review://day-1',
      createdAt: 10,
    })
    const userRevision = recordWikiPageRevision({
      spaceId: 'personal',
      slug: 'projects/remember/wiki',
      title: 'Wiki',
      content: 'AI-maintained baseline with a human constraint.',
      actor: 'user',
      operation: 'updated',
      sourceId: 'editor',
      createdAt: 20,
    })
    recordWikiPageRevision({
      spaceId: 'team',
      slug: 'projects/remember/wiki',
      title: 'Wiki',
      content: 'AI-maintained baseline with a human constraint.',
      actor: 'external',
      operation: 'created',
      sourceId: 'drive://partial-retry',
      createdAt: 30,
    })

    moveWikiPageHistories('personal', 'team', ['projects/remember/wiki'], {
      replaceIdenticalDestination: true,
    })

    const history = getWikiPageHistory('team', 'projects/remember/wiki')
    assert.equal(history?.headRevisionId, userRevision)
    assert.deepEqual(
      history?.revisions.map(({ id, actor }) => ({ id, actor })),
      [
        { id: userRevision, actor: 'user' },
        { id: rememberRevision, actor: 'remember' },
      ]
    )
    const context = getWikiPageAnalysisEditContext('team', 'projects/remember/wiki')
    assert.equal(context?.lastRememberRevision?.id, rememberRevision)
    assert.deepEqual(
      context?.changesSinceRemember.map(({ id, actor }) => ({ id, actor })),
      [{ id: userRevision, actor: 'user' }]
    )
    assert.equal(getWikiPageHistory('personal', 'projects/remember/wiki'), null)
  })

  it('does not replace destination history when its current content differs', async () => {
    await historyDirectory()
    recordWikiPageRevision({
      spaceId: 'personal',
      slug: 'projects/remember',
      title: 'Remember',
      content: 'Private source.',
      actor: 'remember',
      operation: 'created',
    })
    recordWikiPageRevision({
      spaceId: 'team',
      slug: 'projects/remember',
      title: 'Remember',
      content: 'Coworker destination.',
      actor: 'external',
      operation: 'created',
    })

    assert.throws(
      () =>
        moveWikiPageHistories('personal', 'team', ['projects/remember'], {
          replaceIdenticalDestination: true,
        }),
      /wiki-project-move-conflict/
    )
    assert.equal(getWikiPageHistory('personal', 'projects/remember')?.revisions[0]?.content, 'Private source.')
    assert.equal(getWikiPageHistory('team', 'projects/remember')?.revisions[0]?.content, 'Coworker destination.')
  })

  it('stores an exact proposal and supersedes the older proposal for the same page', async () => {
    await historyDirectory()
    const first = createWikiProposal({
      dayId: 'day-1',
      dayStartedAt: 1,
      spaceId: 'team',
      slug: 'projects/remember',
      title: 'Remember',
      content: 'First candidate.',
      summary: 'First update.',
      baseRevision: 'revision-1',
      sourceId: 'daily-review://day-1',
      createdAt: 1,
    })
    const second = createWikiProposal({
      dayId: 'day-2',
      dayStartedAt: 2,
      spaceId: 'team',
      slug: 'projects/remember',
      title: 'Remember',
      content: 'Second candidate.',
      summary: 'Second update.',
      baseRevision: 'revision-1',
      sourceId: 'daily-review://day-2',
      createdAt: 2,
    })

    assert.equal(getWikiProposal(first.id)?.status, 'superseded')
    assert.deepEqual(
      listWikiProposals().map((proposal) => proposal.id),
      [second.id]
    )
    assert.equal(listWikiProposals()[0]?.content, 'Second candidate.')
    setWikiProposalStatus(second.id, 'dismissed')
    assert.equal(getWikiProposal(second.id)?.status, 'dismissed')
  })

  it('presents a historical agent proposal on its mutation Day while preserving persisted provenance', async () => {
    const directory = await historyDirectory()
    const generatedAt = new Date(2026, 8, 23, 0, 15).getTime()
    const proposal = createWikiProposal({
      dayId: 'historical-batch',
      dayStartedAt: generatedAt,
      spaceId: 'team',
      slug: 'projects/remember',
      title: 'Remember',
      content: 'Preserve the original transcript.',
      summary: 'Saved the source policy.',
      baseRevision: null,
      sourceId: 'agent-learning://historical-batch',
      createdAt: generatedAt,
      evidence: [
        {
          sourceId: 'original-message',
          observedAt: generatedAt - 86_400_000,
          quote: 'Preserve the original transcript.',
        },
      ],
    })
    closeWikiHistoryStore()
    initializeWikiHistoryStore(directory)

    const visible = attributeAgentWikiSuggestionsToDays(listWikiProposals(), [
      { id: 'day-22', startedAt: new Date(2026, 8, 22, 9).getTime() },
      { id: 'day-23', startedAt: new Date(2026, 8, 23, 9).getTime() },
    ])
    assert.deepEqual(visible, [{ ...proposal, dayId: 'day-23' }])
    assert.deepEqual(attributeAgentWikiSuggestionsToDays(listWikiProposals(), []), [proposal])
    assert.deepEqual(getWikiProposal(proposal.id), proposal)
  })

  it('keeps identical and reworded evidence dismissed across restarts but permits a new fact', async () => {
    const directory = await historyDirectory()
    const input = {
      dayId: 'day-1',
      dayStartedAt: 1,
      spaceId: 'team',
      slug: 'projects/usa',
      title: 'USA',
      content: 'Checkout is September 30.',
      summary: 'Confirmed checkout.',
      baseRevision: 'r1',
      sourceId: 'daily-review://day-1',
      evidence: [{ sourceId: 'message-1', observedAt: 1, quote: 'Our hotel checkout is confirmed for September 30.' }],
    }
    const first = createWikiProposal(input)
    assert.equal(createWikiProposal({ ...input, dayId: 'day-2', content: 'Checkout is  September 30.\n' }).id, first.id)
    setWikiProposalStatus(first.id, 'dismissed')
    closeWikiHistoryStore()
    initializeWikiHistoryStore(directory)
    assert.equal(createWikiProposal({ ...input, content: 'We leave the hotel on September 30.' }).id, first.id)
    assert.equal(
      createWikiProposal({
        ...input,
        content: 'September 30 is checkout day.',
        evidence: [{ sourceId: 'message-1', observedAt: 1, quote: 'checkout is confirmed for September 30.' }],
      }).id,
      first.id
    )
    assert.equal(listWikiProposals().length, 1)
    assert.equal(wikiProposalFeedback([{ spaceId: 'team', slug: 'projects/usa' }])[0]?.status, 'dismissed')
    const next = createWikiProposal({
      ...input,
      content: 'Checkout is October 1.',
      evidence: [{ sourceId: 'message-2', observedAt: 2, quote: 'I have changed the hotel checkout to October 1.' }],
    })
    assert.notEqual(next.id, first.id)
    assert.equal(next.status, 'pending')
    assert.notEqual(createWikiProposal({ ...input, spaceId: 'another-team' }).id, first.id)
  })

  it('suppresses legacy proposals without evidence after dismissal or application', async () => {
    await historyDirectory()
    for (const status of ['dismissed', 'applied'] as const) {
      const input = {
        dayId: 'day-1',
        dayStartedAt: 1,
        spaceId: 'team',
        slug: `projects/${status}`,
        title: 'Trip',
        content: 'Same proposal.',
        summary: 'Trip update.',
        baseRevision: null,
        sourceId: 'legacy',
      }
      const first = createWikiProposal(input)
      setWikiProposalStatus(first.id, status)
      assert.equal(createWikiProposal({ ...input, sourceId: 'later', dayId: 'day-2' }).id, first.id)
    }
    assert.equal(listWikiProposals().length, 2)
  })

  it('keeps dismissed suggestions out of automatic learning and copied-source proposals after restart', async (t) => {
    let now = 1_000
    t.mock.method(Date, 'now', () => now)
    const directory = await historyDirectory()
    const evidence = {
      sourceId: 'original-user-message',
      observedAt: 100,
      quote: 'Use npm for every project in this workspace.',
      role: 'user' as const,
    }
    const input = {
      dayId: 'day-1',
      dayStartedAt: 1,
      spaceId: 'personal',
      slug: 'processes/preferences',
      title: 'Preferences',
      content: 'Use npm for every project.',
      summary: 'Package-manager preference.',
      baseRevision: null,
      sourceId: 'agent-learning://batch-1',
      createdAt: 1,
      evidence: [evidence],
    }
    const first = createWikiProposal(input)
    setWikiProposalStatus(first.id, 'dismissed')
    closeWikiHistoryStore()
    initializeWikiHistoryStore(directory)

    const copiedEvidence = { ...evidence, sourceId: 'copied-assistant-message', role: 'assistant' as const }
    const replay = {
      ...input,
      content: 'All projects use npm.',
      evidence: [copiedEvidence],
    }
    assert.equal(isWikiEvidenceRejected(input.spaceId, input.slug, replay), true)
    assert.equal(createWikiProposal(replay).id, first.id)
    assert.equal(
      createWikiProposal({
        ...replay,
        evidence: [{ ...copiedEvidence, observedAt: 1_500 }],
      }).id,
      first.id
    )
    assert.equal(
      createWikiProposal({ ...replay, evidence: [{ ...evidence, sourceId: 'older-user-copy' }] }).id,
      first.id
    )
    assert.equal(
      isWikiEvidenceRejected(input.spaceId, input.slug, {
        ...input,
        evidence: [{ ...evidence, observedAt: 1_500 }],
      }),
      true,
      'a new observation time cannot make the original rejected event fresh'
    )
    assert.equal(
      isWikiEvidenceRejected(input.spaceId, input.slug, {
        ...input,
        evidence: [{ ...evidence, sourceId: 'before-dismissal-user-copy', observedAt: 900 }],
      }),
      true,
      'dismissal time, rather than proposal creation time, controls fresh evidence'
    )
    assert.equal(isWikiEvidenceRejected('another-space', input.slug, replay), false)
    assert.equal(isWikiEvidenceRejected(input.spaceId, 'processes/unrelated', replay), false)
    assert.equal(wikiProposalFeedback([{ spaceId: input.spaceId, slug: input.slug }]).length, 1)

    now = 2_000
    setWikiProposalStatus(first.id, 'dismissed')
    const correction = {
      ...input,
      evidence: [{ ...evidence, sourceId: 'later-user-reaffirmation', observedAt: 1_500 }],
    }
    assert.equal(isWikiEvidenceRejected(input.spaceId, input.slug, correction), false)
    assert.notEqual(createWikiProposal(correction).id, first.id)
    const distinctFinding = {
      ...input,
      content: 'Preserve private drafts locally.',
      evidence: [{ ...evidence, quote: 'Private drafts must remain on the local machine.' }],
    }
    assert.equal(isWikiEvidenceRejected(input.spaceId, input.slug, distinctFinding), false)
    assert.notEqual(createWikiProposal(distinctFinding).id, first.id)
  })

  it('preserves local provenance through restart and permits a different finding from the same source message', async () => {
    const directory = await historyDirectory()
    const evidence = {
      sourceId: 'long-agent-message',
      observedAt: 100,
      quote: 'Our transcription must retain the original audio source.',
      kind: 'agent-session',
      provider: 'codex' as const,
      project: 'Remember',
      documentSourceId: 'task-1',
      role: 'user' as const,
    }
    const input = {
      dayId: 'day',
      dayStartedAt: 100,
      spaceId: 'team',
      slug: 'projects/remember',
      title: 'Remember',
      content: 'Retain original audio.',
      summary: 'Audio provenance.',
      baseRevision: null,
      sourceId: 'agent-learning://batch',
      evidence: [evidence],
    }
    const first = createWikiProposal(input)
    setWikiProposalStatus(first.id, 'dismissed')
    const revision = recordWikiPageRevision({
      spaceId: 'personal',
      slug: input.slug,
      title: input.title,
      content: input.content,
      actor: 'remember',
      operation: 'created',
      evidence: [evidence],
    })
    closeWikiHistoryStore()
    initializeWikiHistoryStore(directory)
    assert.deepEqual(getWikiProposal(first.id)?.evidence, [evidence])
    assert.deepEqual(getWikiPageHistory('personal', input.slug)?.revisions[0]?.evidence, [evidence])
    assert.ok(revision)
    assert.deepEqual(getWikiPageRevision('personal', input.slug, revision)?.evidence, [evidence])
    const second = createWikiProposal({
      ...input,
      content: 'Preserve private drafts locally.',
      evidence: [{ ...evidence, quote: "Private drafts must stay on the author's own machine." }],
    })
    assert.notEqual(second.id, first.id)
    assert.equal(second.status, 'pending')
  })

  it('keeps undone learning rejected across restart without blocking a later explicit user correction', async () => {
    const directory = await historyDirectory()
    const evidence = {
      sourceId: 'original-user-event',
      observedAt: 100,
      quote: 'Use npm for every project in this workspace.',
      role: 'user' as const,
    }
    const update = {
      content: 'Use npm for every project.',
      summary: 'Package-manager preference.',
      evidence: [evidence],
    }
    const revision = recordWikiPageRevision({
      spaceId: 'personal',
      slug: 'processes/preferences',
      title: 'Preferences',
      content: update.content,
      actor: 'remember',
      operation: 'created',
      evidence: [evidence],
    })
    assert.ok(revision)
    rejectWikiRevisionEvidence('personal', 'processes/preferences', revision)
    closeWikiHistoryStore()
    initializeWikiHistoryStore(directory)
    assert.equal(isWikiEvidenceRejected('personal', 'processes/preferences', update), true)
    assert.equal(
      isWikiEvidenceRejected('personal', 'processes/preferences', { ...update, content: 'All projects use npm.' }),
      true
    )
    assert.equal(
      isWikiEvidenceRejected('personal', 'processes/preferences', {
        ...update,
        evidence: [{ ...evidence, sourceId: 'older-other-source' }],
      }),
      true
    )
    assert.equal(
      isWikiEvidenceRejected('personal', 'processes/preferences', {
        ...update,
        evidence: [
          { ...evidence, sourceId: 'new-assistant-paraphrase', role: 'assistant', observedAt: Date.now() + 10 },
        ],
      }),
      true
    )
    assert.equal(
      isWikiEvidenceRejected('personal', 'processes/preferences', {
        ...update,
        evidence: [{ ...evidence, sourceId: 'later-original-user-correction', observedAt: Date.now() + 10 }],
      }),
      false
    )
    assert.equal(isWikiEvidenceRejected('another-space', 'processes/preferences', update), false)
    assert.equal(wikiProposalFeedback([{ spaceId: 'personal', slug: 'processes/preferences' }])[0]?.status, 'dismissed')
    assert.deepEqual(wikiProposalFeedback([{ spaceId: 'personal', slug: 'processes/preferences' }])[0]?.evidence, [
      evidence,
    ])
    assert.throws(
      () => rejectWikiRevisionEvidence('another-space', 'processes/preferences', revision),
      /wiki-revision-has-no-learning-evidence/
    )
    moveWikiPageHistories('personal', 'moved-space', ['processes/preferences'])
    assert.equal(isWikiEvidenceRejected('moved-space', 'processes/preferences', update), true)
    assert.equal(isWikiEvidenceRejected('personal', 'processes/preferences', update), false)
  })

  it('persists source checkpoints and never moves a completed cursor backwards', async () => {
    const directory = await historyDirectory()
    recordWikiContextCheckpoints([{ sourceKey: 'codex:session:trip', fingerprints: ['old', 'new'], through: 200 }])
    closeWikiHistoryStore()
    initializeWikiHistoryStore(directory)
    recordWikiContextCheckpoints([{ sourceKey: 'codex:session:trip', fingerprints: ['old'], through: 100 }])
    assert.deepEqual(readWikiContextCheckpoints(), [
      { sourceKey: 'codex:session:trip', fingerprints: ['old', 'new'], through: 200 },
    ])
  })

  it('upgrades an existing Wiki database without losing prior dismissals', async () => {
    const directory = await historyDirectory()
    const first = createWikiProposal({
      dayId: 'old',
      dayStartedAt: 1,
      spaceId: 'team',
      slug: 'projects/usa',
      title: 'Trip',
      content: 'Old itinerary.',
      summary: 'Old route.',
      baseRevision: null,
      sourceId: 'old',
    })
    setWikiProposalStatus(first.id, 'dismissed')
    closeWikiHistoryStore()
    const oldDatabase = new DatabaseSync(join(directory, 'daily-review/wiki.sqlite'))
    oldDatabase.exec(
      'ALTER TABLE wiki_proposal DROP COLUMN evidence_json; ALTER TABLE wiki_page_revision DROP COLUMN evidence_json; DROP TABLE wiki_context_source;'
    )
    oldDatabase.close()
    initializeWikiHistoryStore(directory)
    assert.equal(getWikiProposal(first.id)?.status, 'dismissed')
    assert.deepEqual(readWikiContextCheckpoints(), [])
    assert.deepEqual(wikiProposalFeedback([{ spaceId: 'team', slug: 'projects/usa' }])[0]?.evidence, [])
  })
})
