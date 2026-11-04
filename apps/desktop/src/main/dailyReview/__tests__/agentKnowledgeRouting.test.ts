import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { WikiPageUpdate } from '@remember/shared'
import {
  type AgentKnowledgeSpace,
  agentKnowledgeReviewRejections,
  groupAgentKnowledgeUpdatesBySpace,
} from '../agentKnowledgeRouting'
import { filterWikiUpdatesToSafePromptSelection } from '../wikiPromptSafety'

const spaces: AgentKnowledgeSpace[] = [
  {
    id: 'personal',
    name: 'Personal',
    description: 'My knowledge',
    maintenanceMode: 'auto',
  },
  {
    id: 'aurora',
    name: 'Aurora',
    description: 'Company knowledge',
    maintenanceMode: 'suggest',
  },
]

function update(spaceId: string): WikiPageUpdate {
  return {
    slug: 'research/storage',
    title: 'Storage',
    content: `${spaceId} findings.`,
    summary: 'Preserved storage research.',
    changeType: 'created',
    suggestedSpaceId: spaceId,
  }
}

test('one conversation can yield independent personal and company findings with identical slugs', () => {
  const personal = update('personal')
  const company = update('aurora')
  const groups = groupAgentKnowledgeUpdatesBySpace([personal, company], spaces)
  assert.deepEqual(groups.get('personal'), [personal])
  assert.deepEqual(groups.get('aurora'), [company])
})

test('unknown and missing destinations never fall back to Personal', () => {
  assert.throws(() => groupAgentKnowledgeUpdatesBySpace([update('other-company')], spaces), /invalid-destination/)
  assert.throws(
    () => groupAgentKnowledgeUpdatesBySpace([{ ...update('personal'), suggestedSpaceId: null }], spaces),
    /invalid-destination/
  )
})

test('review accounts for each candidate and keeps the reason for an explicit rejection', () => {
  assert.deepEqual(
    agentKnowledgeReviewRejections(
      {
        accepted: [{ index: 0, sourceId: 'source', quote: 'Original evidence.' }],
        rejected: [{ index: 1, reason: 'Already recorded.' }],
      },
      2
    ),
    [{ index: 1, reason: 'Already recorded.' }]
  )
})

test('silent omissions, conflicting verdicts and unexplained rejection cannot consume a source', () => {
  for (const verdict of [
    { accepted: [] },
    { accepted: [], rejected: [] },
    { accepted: [{ index: 0 }], rejected: [{ index: 0, reason: 'Conflicting outcome.' }] },
    { accepted: [], rejected: [{ index: 0, reason: '' }] },
    { accepted: [], rejected: [{ index: 9, reason: 'Unknown candidate.' }] },
  ]) {
    assert.throws(() => agentKnowledgeReviewRejections(verdict, 1), /incomplete-review/)
  }
})

test('a writable same-slug page in another space cannot authorize a clipped company rewrite', () => {
  const updates = [update('personal'), update('aurora')]
  const pages = spaces.map((space) => ({
    slug: 'research/storage',
    title: 'Storage',
    content: `${space.id} existing knowledge.`,
    excerpt: '',
    updatedAt: 1,
    sourceCount: 1,
    spaceId: space.id,
  }))
  const promptPages = pages.map((page) => ({ ...page, rewriteAllowed: page.spaceId === 'personal' }))
  const groups = groupAgentKnowledgeUpdatesBySpace(updates, spaces)
  const safe = [...groups].flatMap(([spaceId, candidates]) =>
    filterWikiUpdatesToSafePromptSelection(
      candidates,
      pages.filter((page) => page.spaceId === spaceId),
      promptPages.filter((page) => page.spaceId === spaceId)
    )
  )
  assert.deepEqual(safe, [updates[0]])
})
