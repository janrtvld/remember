import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DailyReviewSession, WikiPageUpdate } from '@remember/shared'
import { agentKnowledgeRoutingPrompt } from '../dailyReview/agentKnowledgeRouting'
import { buildFinalPrompt } from '../dailyReview/dayAnalysisPrompts'
import { reviewedWikiSuggestions, WIKI_SUGGESTION_REVIEW_INSTRUCTIONS } from '../dailyReview/wikiSuggestionPolicy'
import { knowledgeOrganizationFeedbackPermitted, validateKnowledgeOrganizationTargets } from '../knowledgeMaintenance'
import {
  KNOWLEDGE_ORGANIZATION_INSTRUCTIONS,
  KNOWLEDGE_ORGANIZATION_REVIEW_INSTRUCTIONS,
} from '../knowledgeOrganization'

test('Day and direct agent learning receive the same page ownership and privacy policy', () => {
  const session: DailyReviewSession = {
    id: 'day',
    startedAt: 1_000,
    endedAt: null,
    activeDurationMs: 0,
    moments: [],
    appActivity: [],
    contextMoments: [],
    memory: null,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  }
  const dayPrompt = buildFinalPrompt(session, [], null, 'manual', 2_000, 'en', 'en-US', [], [], [])
  const agentPrompt = agentKnowledgeRoutingPrompt([])
  for (const prompt of [dayPrompt, agentPrompt]) {
    assert.ok(prompt.includes(KNOWLEDGE_ORGANIZATION_INSTRUCTIONS))
    assert.equal(prompt.split(KNOWLEDGE_ORGANIZATION_INSTRUCTIONS).length, 2)
  }
  assert.ok(WIKI_SUGGESTION_REVIEW_INSTRUCTIONS.includes(KNOWLEDGE_ORGANIZATION_REVIEW_INSTRUCTIONS))
})

test('a supported collaborator orientation can retain original evidence alongside a project page', () => {
  const quote = 'Tom is my Woub collaborator; he coordinates the customer rollout while I build the mobile app.'
  const person: WikiPageUpdate = {
    slug: 'people/tom',
    title: 'Tom',
    content: 'Woub collaborator coordinating customer rollout. See [Woub](projects/woub).',
    summary: 'Connected Tom to Woub responsibilities.',
    changeType: 'created',
    suggestedSpaceId: 'personal',
  }
  const source = {
    id: 'original-user-message',
    kind: 'agent-session',
    observedAt: 1_000,
    role: 'user' as const,
    text: quote,
  }
  const accepted = reviewedWikiSuggestions(
    { accepted: [{ index: 0, sourceId: source.id, quote }] },
    [person],
    [source],
    [{ slug: 'projects/woub', content: quote }]
  )
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0]?.slug, person.slug)
  assert.deepEqual(accepted[0]?.evidence, [
    { sourceId: source.id, quote, kind: source.kind, observedAt: source.observedAt, role: 'user' },
  ])
})

test('a person page link cannot substitute for an exact original supporting quote', () => {
  const candidate: WikiPageUpdate = {
    slug: 'people/tom',
    title: 'Tom',
    content: 'Coordinates [Woub](projects/woub).',
    summary: 'Recorded responsibility.',
    changeType: 'created',
  }
  const source = {
    id: 'original',
    kind: 'screen-context',
    observedAt: 1_000,
    text: 'A message recipient is named Tom.',
  }
  assert.deepEqual(
    reviewedWikiSuggestions(
      { accepted: [{ index: 0, sourceId: 'projects/woub', quote: 'Tom coordinates Woub.' }] },
      [candidate],
      [source]
    ),
    []
  )
  assert.deepEqual(
    reviewedWikiSuggestions(
      { accepted: [{ index: 0, sourceId: source.id, quote: 'Tom coordinates Woub.' }] },
      [candidate],
      [source]
    ),
    []
  )
})

test('maintenance pending drafts and review feedback require every original source to remain permitted', () => {
  const source = {
    id: 'visible-original',
    kind: 'screen-context',
    observedAt: 1_000,
    text: 'Tom coordinates the Woub customer rollout.',
  }
  const evidence = { sourceId: source.id, kind: source.kind, observedAt: source.observedAt, quote: source.text }
  assert.equal(knowledgeOrganizationFeedbackPermitted({ evidence: [evidence] }, [source]), true)
  assert.equal(knowledgeOrganizationFeedbackPermitted({ evidence: [evidence] }, []), false)
  assert.equal(
    knowledgeOrganizationFeedbackPermitted({ evidence: [evidence, { ...evidence, sourceId: 'revoked-original' }] }, [
      source,
    ]),
    false
  )
  assert.equal(knowledgeOrganizationFeedbackPermitted({ evidence: [{ ...evidence, role: 'user' }] }, [source]), false)
  assert.equal(knowledgeOrganizationFeedbackPermitted({}, [source]), false)
})

test('generation and persistence share strict targets including one self identity and no nested person pages', () => {
  const person: WikiPageUpdate = {
    slug: 'people/tom',
    title: 'Tom',
    content: 'Supported relationship.',
    summary: 'Relationship.',
    changeType: 'created',
    suggestedSpaceId: 'personal',
  }
  const self = { ...person, slug: 'people/me', title: 'Me' }
  const pages = [
    {
      slug: 'people/work-profile',
      title: 'My profile',
      content: 'Existing context.',
      excerpt: '',
      sourceCount: 1,
      updatedAt: 1,
    },
  ]
  assert.doesNotThrow(() => validateKnowledgeOrganizationTargets([person], pages))
  for (const candidate of [
    self,
    { ...person, slug: 'people/tom/woub' },
    { ...person, suggestedSpaceId: 'shared-company' },
  ]) {
    assert.throws(() => validateKnowledgeOrganizationTargets([candidate], pages), /invalid-target/)
  }
})
