import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { WikiMaintenanceMode, WikiPageUpdate, WikiProjectAssignment, WikiSpace } from '@remember/shared'
import {
  hasWikiProjectNamespaceConflict,
  isWikiProjectPage,
  orderWikiProjectPagesForDeletion,
  routeWikiProjectUpdates,
  wikiProjectUpdateRoutingMatches,
} from '../wikiProjectRouting'

const updates: WikiPageUpdate[] = [
  {
    slug: 'projects/woub',
    title: 'Woub',
    content: 'Current project context.',
    summary: 'Updated Woub.',
    changeType: 'updated',
    suggestedSpaceId: 'untrusted-space',
  },
  {
    slug: 'projects/remember',
    title: 'Remember',
    content: 'Private project context.',
    summary: 'Updated Remember.',
    changeType: 'updated',
    suggestedSpaceId: null,
  },
]

function assignment(): WikiProjectAssignment {
  return { projectSlug: 'projects/woub', spaceId: 'woub', createdAt: 1 }
}

function space(id: string, maintenanceMode: WikiMaintenanceMode): WikiSpace {
  return { id, name: id, description: '', icon: 'folder', color: 'slate', maintenanceMode }
}

const personal = space('personal', 'auto')
const woubUpdate = updates[0]
assert.ok(woubUpdate)

describe('Wiki project routing', () => {
  it('rejects changed destinations or Auto/Suggest modes during analysis', () => {
    const original = routeWikiProjectUpdates([], [personal, space('woub', 'suggest')], updates)
    const unchanged = routeWikiProjectUpdates([], [personal, space('woub', 'suggest')], [...updates].reverse())
    assert.equal(wikiProjectUpdateRoutingMatches(original, unchanged), true)
    const moved = routeWikiProjectUpdates([assignment()], [personal, space('woub', 'suggest')], updates)
    assert.equal(wikiProjectUpdateRoutingMatches(original, moved), false)
    const automatic = routeWikiProjectUpdates([assignment()], [personal, space('woub', 'auto')], updates)
    assert.equal(wikiProjectUpdateRoutingMatches(moved, automatic), false)
    assert.equal(wikiProjectUpdateRoutingMatches(automatic, moved), false)
  })

  it('matches only the selected project root and its real descendants', () => {
    assert.equal(isWikiProjectPage('projects/woub', 'projects/woub'), true)
    assert.equal(isWikiProjectPage('projects/woub/releases', 'projects/woub'), true)
    assert.equal(isWikiProjectPage('projects/woub-private', 'projects/woub'), false)
    assert.equal(isWikiProjectPage('projects/woubled', 'projects/woub'), false)
  })

  it('routes a moved project from its canonical space maintenance policy', () => {
    const routed = routeWikiProjectUpdates([assignment()], [personal, space('woub', 'suggest')], updates)

    assert.deepEqual(
      routed.proposalsBySpace.get('woub')?.map((update) => update.slug),
      ['projects/woub']
    )
    assert.deepEqual(
      routed.automaticBySpace.get('personal')?.map((update) => update.slug),
      ['projects/remember']
    )
  })

  it('writes automatically when the canonical Wiki is in Auto mode', () => {
    const routed = routeWikiProjectUpdates([assignment()], [personal, space('woub', 'auto')], updates)

    assert.deepEqual(
      routed.automaticBySpace.get('woub')?.map((update) => [update.slug, update.suggestedSpaceId]),
      [['projects/woub', null]]
    )
  })

  it('allows a private Wiki to use Suggest mode', () => {
    const routed = routeWikiProjectUpdates([assignment()], [personal, space('woub', 'suggest')], updates)

    assert.deepEqual(
      routed.proposalsBySpace.get('woub')?.map((update) => [update.slug, update.suggestedSpaceId]),
      [['projects/woub', null]]
    )
  })

  it('allows the Personal Wiki to use Suggest mode', () => {
    const routed = routeWikiProjectUpdates([], [space('personal', 'suggest')], updates)

    assert.deepEqual(
      routed.proposalsBySpace.get('personal')?.map((update) => update.slug),
      ['projects/woub', 'projects/remember']
    )
    assert.equal(routed.automaticBySpace.size, 0)
  })

  it('maintains a project page in its actual unique space without a move record', () => {
    const routed = routeWikiProjectUpdates(
      [],
      [personal, space('company-brain', 'auto')],
      updates.filter((update) => update.slug === 'projects/woub'),
      new Map([['projects/woub', ['company-brain']]])
    )

    assert.deepEqual(
      routed.automaticBySpace.get('company-brain')?.map((update) => update.slug),
      ['projects/woub']
    )
    assert.equal(routed.automaticBySpace.has('personal'), false)
  })

  it('fails ambiguous duplicate locations closed to Personal without an explicit project location', () => {
    const routed = routeWikiProjectUpdates(
      [],
      [personal, space('one', 'auto'), space('two', 'auto')],
      updates.filter((update) => update.slug === 'projects/woub'),
      new Map([['projects/woub', ['one', 'two']]])
    )

    assert.deepEqual(
      routed.automaticBySpace.get('personal')?.map((update) => update.slug),
      ['projects/woub']
    )
  })

  it('maintains a new child in the unique local project', () => {
    const child = { ...woubUpdate, slug: 'projects/woub/transcription', changeType: 'created' as const }
    const routed = routeWikiProjectUpdates(
      [],
      [personal, space('team', 'auto')],
      [child],
      new Map([['projects/woub', ['team']]])
    )
    assert.equal(routed.automaticBySpace.get('team')?.[0]?.slug, child.slug)
    assert.equal(routed.proposalsBySpace.size, 0)
  })

  it('honors explicit Auto project placement for new children', () => {
    const child = { ...woubUpdate, slug: 'projects/woub/transcription', changeType: 'created' as const }
    const routed = routeWikiProjectUpdates([assignment()], [personal, space('woub', 'auto')], [child])
    assert.equal(routed.automaticBySpace.get('woub')?.[0]?.slug, child.slug)
    assert.equal(routed.proposalsBySpace.size, 0)
  })

  it('does not cross an ambiguous nearest parent or infer placement from a similar slug', () => {
    const child = { ...woubUpdate, slug: 'projects/woub/transcription/research', changeType: 'created' as const }
    const routed = routeWikiProjectUpdates(
      [],
      [personal, space('team', 'auto')],
      [child],
      new Map([
        ['projects/woub', ['team']],
        ['projects/woub/transcription', ['personal', 'team']],
      ])
    )
    assert.equal(routed.automaticBySpace.get('personal')?.[0]?.slug, child.slug)
    const unrelated = routeWikiProjectUpdates(
      [],
      [personal, space('team', 'auto')],
      [{ ...child, slug: 'projects/woub-private/research' }],
      new Map([['projects/woub', ['team']]])
    )
    assert.equal(unrelated.automaticBySpace.get('personal')?.length, 1)
  })

  it('routes the same slug independently to the explicitly selected Wiki spaces', () => {
    const routed = routeWikiProjectUpdates(
      [assignment()],
      [personal, space('woub', 'auto'), space('company', 'suggest')],
      [
        { ...woubUpdate, suggestedSpaceId: 'personal', content: 'My personal project context.' },
        { ...woubUpdate, suggestedSpaceId: 'company', content: 'Reviewed company project context.' },
      ],
      new Map([['projects/woub', ['personal', 'woub', 'company']]]),
      { explicitDestinations: true }
    )
    assert.equal(routed.automaticBySpace.get('personal')?.[0]?.content, 'My personal project context.')
    assert.equal(routed.proposalsBySpace.get('company')?.[0]?.content, 'Reviewed company project context.')
    assert.equal(routed.automaticBySpace.has('woub'), false)
    assert.equal(routed.proposalsBySpace.get('company')?.[0]?.suggestedSpaceId, null)
  })

  it('allows new knowledge in any category without a project root or folder mapping', () => {
    const slugs = ['research/competitor-pricing', 'people/new-teammate', 'processes/hiring', 'strategy', 'projects/new']
    const routed = routeWikiProjectUpdates(
      [],
      [personal, space('company', 'suggest')],
      slugs.map((slug) => ({ ...woubUpdate, slug, changeType: 'created', suggestedSpaceId: 'company' })),
      new Map(),
      { explicitDestinations: true }
    )
    assert.deepEqual(
      routed.proposalsBySpace.get('company')?.map((update) => update.slug),
      slugs
    )
    assert.equal(routed.automaticBySpace.size, 0)
  })

  it('uses the selected space Auto policy even for new project children', () => {
    const routed = routeWikiProjectUpdates(
      [assignment()],
      [personal, space('woub', 'auto')],
      [{ ...woubUpdate, slug: 'projects/woub/research', changeType: 'created', suggestedSpaceId: 'woub' }],
      new Map([['projects/woub', ['woub']]]),
      { explicitDestinations: true }
    )
    assert.equal(routed.automaticBySpace.get('woub')?.[0]?.slug, 'projects/woub/research')
    assert.equal(routed.proposalsBySpace.size, 0)
  })

  it('uses explicit Suggest policy for Personal as well as other Wikis', () => {
    const routed = routeWikiProjectUpdates(
      [],
      [space('personal', 'suggest'), space('company', 'suggest')],
      ['personal', 'company'].map((suggestedSpaceId) => ({ ...woubUpdate, suggestedSpaceId })),
      new Map(),
      { explicitDestinations: true }
    )
    assert.deepEqual([...routed.proposalsBySpace.keys()], ['personal', 'company'])
    assert.equal(routed.automaticBySpace.size, 0)
  })

  it('rejects a missing or removed explicit destination instead of rerouting the batch to Personal', () => {
    for (const suggestedSpaceId of [undefined, null, '', 'removed-wiki']) {
      assert.throws(
        () =>
          routeWikiProjectUpdates(
            [assignment()],
            [personal, space('woub', 'auto')],
            [
              { ...woubUpdate, suggestedSpaceId: 'personal' },
              { ...woubUpdate, suggestedSpaceId },
            ],
            new Map([['projects/woub', ['woub']]]),
            { explicitDestinations: true }
          ),
        { message: 'wiki-space-unavailable' }
      )
    }
  })

  it('continues to ignore even valid model destination hints for Day and import routing', () => {
    const routed = routeWikiProjectUpdates(
      [],
      [personal, space('company', 'auto')],
      [{ ...woubUpdate, suggestedSpaceId: 'company' }]
    )
    assert.equal(routed.automaticBySpace.get('personal')?.[0]?.slug, 'projects/woub')
    assert.equal(routed.automaticBySpace.has('company'), false)
  })

  it('does not merge a local move into an occupied project namespace', () => {
    assert.equal(hasWikiProjectNamespaceConflict('projects/remember', ['projects/remember/private-notes']), true)
    assert.equal(hasWikiProjectNamespaceConflict('projects/remember', ['projects/remembered']), false)
  })

  it('keeps the project root as the retry marker until every child is deleted', () => {
    assert.deepEqual(
      orderWikiProjectPagesForDeletion([
        { slug: 'projects/remember' },
        { slug: 'projects/remember/wiki' },
        { slug: 'projects/remember/wiki/conflicts' },
        { slug: 'projects/remember/capture' },
      ]).map((page) => page.slug),
      ['projects/remember/wiki/conflicts', 'projects/remember/capture', 'projects/remember/wiki', 'projects/remember']
    )
  })
})
