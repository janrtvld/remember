import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { KnowledgeSuggestion } from '@remember/shared'
import { contextSourceKey } from '../../contextImportChanges'
import type { AgentContextDocument } from '../../contextImportSources'
import {
  agentKnowledgePagesWithProposals,
  consideredAgentKnowledgeSources,
  rankAgentKnowledgePages,
  retainPendingProposalEvidence,
  selectAgentKnowledgeDocuments,
} from '../agentKnowledgeSelection'
import { type AnalysisWikiPage, filterWikiUpdatesToSafePromptSelection, wikiPagesForPrompt } from '../wikiPromptSafety'

function document(sourceId: string, content: string): AgentContextDocument {
  return {
    provider: 'codex',
    kind: 'session',
    sourceId,
    project: 'Remember',
    updatedAt: 10,
    content,
    messages: [{ role: 'user', content, observedAt: 10 }],
  }
}

function page(slug: string, title: string, content: string, updatedAt = 1): AnalysisWikiPage {
  return { slug, title, content, updatedAt, excerpt: content, sourceCount: 1, spaceId: 'personal' }
}

test('budget excludes complete documents without acknowledging them or clipping source passages', () => {
  const first = document('one', 'a'.repeat(50))
  const second = document('two', 'b'.repeat(60))
  const third = document('three', 'c'.repeat(10))
  const result = selectAgentKnowledgeDocuments([first, second, third], 60)
  assert.deepEqual(result.documents.map(contextSourceKey), [contextSourceKey(first), contextSourceKey(third)])
  assert.deepEqual(result.deferredSourceKeys, [contextSourceKey(second)])
  assert.equal(result.documents[0]?.messages?.[0]?.content, first.content)
  assert.deepEqual(selectAgentKnowledgeDocuments([second], 60).deferredSourceKeys, [])
})

test('unknown, missing and conflicting source dispositions never count as processed', () => {
  const first = document('one', 'First.')
  const documents = [first, document('two', 'Second.')]
  assert.deepEqual(
    consideredAgentKnowledgeSources(
      [
        { sourceKey: contextSourceKey(first), disposition: 'considered' },
        { sourceKey: 'invented', disposition: 'considered' },
      ],
      documents
    ),
    [contextSourceKey(first)]
  )
  assert.deepEqual(
    consideredAgentKnowledgeSources(
      [
        { sourceKey: contextSourceKey(first), disposition: 'considered' },
        { sourceKey: contextSourceKey(first), disposition: 'deferred' },
      ],
      documents
    ),
    []
  )
})

test('relevant older page and its project root precede forty unrelated recent pages', () => {
  const pages = [
    ...Array.from({ length: 40 }, (_, index) =>
      page(`projects/other-${index}`, `Other ${index}`, 'Unrelated delivery dates.', 200)
    ),
    page('projects/remember', 'Remember', 'Current product direction.'),
    page('projects/remember/customer-promises', 'Customer promises', 'The older customer requests direction.'),
  ]
  const ranked = rankAgentKnowledgePages(
    [document('correction', 'Remember is personal knowledge. Reject the customer promises direction.')],
    pages
  )
  const promptPages = wikiPagesForPrompt(ranked, 40, 180_000, { preserveOrder: true })
  assert.deepEqual(
    promptPages.slice(0, 2).map((entry) => entry.slug),
    ['projects/remember', 'projects/remember/customer-promises']
  )
  assert.equal(promptPages[0]?.rewriteAllowed, true)
  const updates = [
    {
      slug: 'projects/remember',
      title: 'Remember',
      content: 'Personal knowledge.',
      summary: 'Corrected purpose.',
      changeType: 'updated' as const,
    },
  ]
  assert.equal(filterWikiUpdatesToSafePromptSelection(updates, pages, promptPages).length, 1)
})

test('unavailable or oversized relevant pages remain read-only, preserving human changes', () => {
  const pages = [
    {
      ...page('projects/remember', 'Remember', 'Human content.'.repeat(300)),
      analysisReadOnlyReason: 'source-content-unavailable',
    },
  ]
  const selected = wikiPagesForPrompt(
    rankAgentKnowledgePages([document('correction', 'Remember should change.')], pages),
    40,
    100,
    { preserveOrder: true }
  )
  assert.equal(selected[0]?.rewriteAllowed, false)
  assert.deepEqual(
    filterWikiUpdatesToSafePromptSelection(
      [
        {
          slug: 'projects/remember',
          title: 'Remember',
          summary: 'Changed.',
          content: 'New body.',
          changeType: 'updated',
        },
      ],
      pages,
      selected
    ),
    []
  )
})

test('an explicit project binding ranks the canonical project despite an unrelated checkout name', () => {
  const source = {
    ...document('binding', 'Keep the current project purpose.'),
    project: 'react-native-app',
    wikiProject: { spaceId: 'team', projectSlug: 'projects/woub' },
  }
  const pages = [
    ...Array.from({ length: 50 }, (_, index) =>
      page(`projects/react-native-${index}`, `React native ${index}`, 'Current project purpose.', 200)
    ),
    { ...page('projects/woub', 'Woub', 'Shared current direction.'), spaceId: 'team' },
    page('projects/woub', 'Private Woub draft', 'Private exploration.'),
  ]
  const ranked = rankAgentKnowledgePages([source], pages)
  assert.equal(ranked[0]?.spaceId, 'team')
  assert.equal(ranked[0]?.slug, 'projects/woub')
})

test('company names rank general knowledge without a project association', () => {
  const relevant = {
    ...page('research/retention', 'Retention', 'Current findings.'),
    spaceId: 'acme',
    spaceName: 'Acme',
  }
  const unrelated = { ...relevant, spaceId: 'atlas', spaceName: 'Atlas', updatedAt: 200 }
  const source = { ...document('company-research', 'Acme needs a longer retention window.'), project: 'General' }

  assert.deepEqual(rankAgentKnowledgePages([source], [unrelated, relevant]), [relevant, unrelated])
})

test('a relevant child boosts only its own project root when another space has the same slug', () => {
  const root = { ...page('projects/service', 'Service', 'Current direction.'), spaceId: 'team' }
  const child = {
    ...page('projects/service/retention', 'Retention', 'Keep original source material for audit.'),
    spaceId: 'team',
  }
  const otherRoot = { ...root, spaceId: 'other-team', updatedAt: 200 }
  const otherChild = { ...child, spaceId: 'other-team', content: 'An unrelated policy.', updatedAt: 200 }
  const source = { ...document('research', 'Retain original source material for audit.'), project: 'General' }

  const ranked = rankAgentKnowledgePages([source], [otherRoot, otherChild, root, child])
  assert.equal(ranked[0], root)
  assert.equal(ranked[1], child)
  assert(ranked.indexOf(otherRoot) > ranked.indexOf(child))
})

test('a second finding sees the complete pending first finding and preserves its evidence in the combined proposal', () => {
  const firstEvidence = { sourceId: 'finding-1', quote: 'Keep original research sources.', observedAt: 1 }
  const secondEvidence = {
    sourceId: 'finding-2',
    quote: "Explain research in each colleague's own agent.",
    observedAt: 2,
  }
  const current = { ...page('projects/remember', 'Remember', 'Current project.'), revision: 'base' }
  const pending: KnowledgeSuggestion = {
    id: 'pending-1',
    dayId: 'day',
    dayStartedAt: 1,
    slug: current.slug,
    title: current.title,
    content: 'Current project.\n\nKeep original research sources.',
    summary: 'First finding.',
    baseRevision: 'base',
    sourceId: 'agent-learning://first',
    suggestedSpaceId: 'personal',
    status: 'pending',
    destinationSpaceId: null,
    appliedAt: null,
    evidence: [firstEvidence],
  }
  const pages = agentKnowledgePagesWithProposals([current], [pending])
  const prompt = wikiPagesForPrompt(pages, 40, 180_000)
  assert.equal(prompt[0]?.pendingProposal?.content, pending.content)
  assert.equal(prompt[0]?.pendingProposal?.baseMatchesCurrent, true)
  assert.equal(prompt[0]?.content, current.content, 'Pending knowledge stays distinct from committed content')
  const combined = retainPendingProposalEvidence(
    {
      slug: current.slug,
      title: current.title,
      content: `${pending.content}\n\nExplain research in each colleague's own agent.`,
      summary: 'Second finding.',
      changeType: 'updated',
      evidence: [secondEvidence],
    },
    pages
  )
  assert(combined.content?.includes('Keep original research sources.'))
  assert(combined.content?.includes("Explain research in each colleague's own agent."))
  assert.deepEqual(combined.evidence, [firstEvidence, secondEvidence])
  const stale = agentKnowledgePagesWithProposals(
    [{ ...current, revision: 'human-edited', content: 'Keep private drafts private.' }],
    [pending]
  )
  assert.equal(stale[0]?.pendingProposal?.baseMatchesCurrent, false)
  assert.equal(stale[0]?.content, 'Keep private drafts private.')
  const bounded = wikiPagesForPrompt(pages, 40, current.content.length + 512)
  assert.equal(
    bounded[0]?.rewriteAllowed,
    false,
    'The pending draft must fit in full; budget exclusions remain read-only'
  )
  assert.equal(bounded[0]?.pendingProposal, undefined)
})

test('pending new subjects keep their exact identity without exposing unrelated spaces or dismissed drafts', () => {
  const proposal = {
    id: 'pending',
    dayId: 'day',
    dayStartedAt: 1,
    slug: 'projects/remember/new-research',
    title: 'New research',
    content: 'Useful new finding.',
    summary: 'Finding.',
    baseRevision: null,
    sourceId: 'agent-learning://first',
    suggestedSpaceId: 'team',
    status: 'pending' as const,
    destinationSpaceId: null,
    appliedAt: null,
  }
  const root = { ...page('projects/remember', 'Remember', 'Project.'), spaceId: 'team' }
  const pages = agentKnowledgePagesWithProposals(
    [root],
    [
      proposal,
      { ...proposal, suggestedSpaceId: 'unrelated-team' },
      { ...proposal, id: 'dismissed', slug: 'projects/remember/dismissed', status: 'dismissed' },
    ]
  )
  assert.equal(pages.length, 2)
  assert.equal(pages[1]?.slug, proposal.slug)
  assert.equal(pages[1]?.pendingProposal?.pageExists, false)
})

test('pending general knowledge in an empty local space requires an explicitly listed destination', () => {
  const proposal: KnowledgeSuggestion = {
    id: 'company-research',
    dayId: 'day',
    dayStartedAt: 1,
    slug: 'research/agent-adoption',
    title: 'Agent adoption',
    content: 'Teams use different agents for research.',
    summary: 'Research finding.',
    baseRevision: null,
    sourceId: 'agent-learning://company-research',
    suggestedSpaceId: 'company',
    status: 'pending',
    destinationSpaceId: null,
    appliedAt: null,
  }
  const proposals = [
    proposal,
    { ...proposal, id: 'other-company', suggestedSpaceId: 'other-company' },
    { ...proposal, id: 'dismissed', slug: 'research/dismissed', status: 'dismissed' as const },
  ]

  assert.deepEqual(agentKnowledgePagesWithProposals([], proposals), [])
  const pages = agentKnowledgePagesWithProposals([], proposals, [
    {
      id: 'company',
      name: 'Company',
      maintenanceMode: 'suggest',
    },
  ])
  assert.equal(pages.length, 1)
  assert.equal(pages[0]?.spaceId, 'company')
  assert.equal(pages[0]?.spaceName, 'Company')
  assert.equal(pages[0]?.maintenanceMode, 'suggest')
  assert.equal(pages[0]?.slug, proposal.slug)
  assert.equal(pages[0]?.content, '')
  assert.equal(pages[0]?.pendingProposal?.content, proposal.content)
  assert.equal(pages[0]?.pendingProposal?.pageExists, false)
  assert.equal(pages[0]?.pendingProposal?.baseMatchesCurrent, true)
})

test('pending general knowledge is included only for an existing Space', () => {
  const proposal: KnowledgeSuggestion = {
    id: 'confidential-research',
    dayId: 'day',
    dayStartedAt: 1,
    slug: 'research/pricing',
    title: 'Pricing research',
    content: 'Confidential company pricing research.',
    summary: 'Pricing finding.',
    baseRevision: null,
    sourceId: 'agent-learning://pricing',
    suggestedSpaceId: 'company',
    status: 'pending',
    destinationSpaceId: null,
    appliedAt: null,
    evidence: [{ sourceId: 'private-conversation', quote: 'Private pricing discussion.', observedAt: 1 }],
  }
  const metadata = { id: 'company', name: 'Company', maintenanceMode: 'suggest' as const }
  assert.deepEqual(agentKnowledgePagesWithProposals([], [proposal], []), [])
  const local = agentKnowledgePagesWithProposals([], [proposal], [metadata])
  assert.equal(local[0]?.pendingProposal?.content, proposal.content)
})

test('a parent excluded from rewriting also keeps its pending child read-only', () => {
  const parent = {
    ...page('projects/company', 'Company project', 'Permitted cached project knowledge.'),
    spaceId: 'company',
    analysisReadOnlyReason: 'source-content-unavailable',
  }
  const proposal: KnowledgeSuggestion = {
    id: 'pending-child',
    dayId: 'day',
    dayStartedAt: 1,
    slug: 'projects/company/research',
    title: 'Research',
    content: 'Pending project research.',
    summary: 'Research finding.',
    baseRevision: null,
    sourceId: 'agent-learning://project',
    suggestedSpaceId: 'company',
    status: 'pending',
    destinationSpaceId: null,
    appliedAt: null,
  }
  for (const spaces of [
    [],
    [
      {
        id: 'company',
        name: 'Company',
        maintenanceMode: 'suggest' as const,
      },
    ],
  ]) {
    const pages = agentKnowledgePagesWithProposals([parent], [proposal], spaces)
    const prompt = wikiPagesForPrompt(pages, 40, 180_000)
    assert.equal(pages.length, 2)
    assert.equal(pages[1]?.analysisReadOnlyReason, parent.analysisReadOnlyReason)
    assert.equal(prompt[1]?.rewriteAllowed, false)
    assert.equal(prompt[1]?.pendingProposal, undefined)
  }
})

test('pending evidence comes only from the explicit destination when spaces share a page slug', () => {
  const privateEvidence = { sourceId: 'private-chat', quote: 'Private supporting passage.', observedAt: 1 }
  const teamEvidence = { sourceId: 'team-chat', quote: 'Company supporting passage.', observedAt: 2 }
  const pending = {
    id: 'private-draft',
    content: 'Keep research sources.',
    summary: 'Retain sources.',
    baseRevision: null,
    baseMatchesCurrent: true,
    pageExists: false,
    evidence: [privateEvidence],
  }
  const privatePage = { ...page('research/sources', 'Sources', ''), pendingProposal: pending }
  const teamPage = {
    ...privatePage,
    spaceId: 'team',
    pendingProposal: { ...pending, id: 'team-draft', evidence: [teamEvidence] },
  }
  const update = {
    slug: privatePage.slug,
    title: privatePage.title,
    content: 'Keep research sources. Cite them in later findings.',
    summary: 'Preserve citations.',
    changeType: 'created' as const,
    suggestedSpaceId: 'team',
  }

  assert.deepEqual(retainPendingProposalEvidence(update, [privatePage, teamPage]).evidence, [teamEvidence])
  assert.equal(retainPendingProposalEvidence(update, [privatePage]), update)
})
