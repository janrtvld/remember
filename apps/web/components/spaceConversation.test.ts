import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { WikiPage } from '@remember/shared'
import {
  discardableManualMeetingSource,
  discardedManualMeetingSourceUpdate,
  SPACE_CONVERSATION_PRIVACY_NOTE,
  spaceConversationSource,
} from './spaceConversation'

function stub(href: string, contentAfter = '') {
  return {
    slug: 'meetings/meeting-1',
    content: `[Open opname en transcript](${href})${contentAfter}`,
  }
}

test('an existing conversation source keeps its identity and uses the current Space context', () => {
  const source = spaceConversationSource(
    stub(
      '/conversations/conversation/?id=day%201&conversation=episode%3Aone%2Ftwo&space=old&document=documents%2Fold',
      `\n\n${SPACE_CONVERSATION_PRIVACY_NOTE}`
    ),
    'team / woub'
  )
  assert.equal(source?.kind, 'conversation')
  if (source?.kind !== 'conversation') return
  assert.equal(source.dayId, 'day 1')
  assert.equal(source.conversationReference, 'episode:one/two')
  const url = new URL(source.href, 'http://local')
  assert.equal(url.origin, 'http://local')
  assert.equal(url.pathname, '/conversations/conversation/')
  assert.equal(url.searchParams.get('id'), 'day 1')
  assert.equal(url.searchParams.get('conversation'), 'episode:one/two')
  assert.equal(url.searchParams.get('space'), 'team / woub')
  assert.equal(url.searchParams.get('document'), 'meetings/meeting-1')
})

test('a recording source opens its pending route with its source document context', () => {
  assert.deepEqual(spaceConversationSource(stub('/conversations/pending/?meeting=meeting-1'), 'woub'), {
    kind: 'pending',
    meetingId: 'meeting-1',
    href: '/conversations/pending/?meeting=meeting-1&space=woub&document=meetings%2Fmeeting-1',
  })
  assert.equal(spaceConversationSource(stub('/conversations/pending/?meeting=other-meeting'), 'woub'), null)
})

test('user content, edited source labels and child pages retain their document destination', () => {
  const page = stub('/conversations/conversation/?id=day-1&conversation=window%3A09%3A00-10%3A00')
  assert.equal(spaceConversationSource({ ...page, content: `${page.content}\n\nMijn eigen conclusie.` }, 'woub'), null)
  assert.equal(
    spaceConversationSource(
      { ...page, content: `${page.content}\n\n${SPACE_CONVERSATION_PRIVACY_NOTE}\n\nNotities` },
      'woub'
    ),
    null
  )
  assert.equal(
    spaceConversationSource({ ...page, content: page.content.replace('Open opname en transcript', 'Bron') }, 'woub'),
    null
  )
  assert.equal(spaceConversationSource({ ...page, slug: 'meetings/meeting-1/notities' }, 'woub'), null)
  assert.equal(spaceConversationSource({ ...page, slug: 'documents/meeting-1' }, 'woub'), null)
  assert.equal(spaceConversationSource(page, 'woub')?.kind, 'conversation')
})

test('only known internal routes and unambiguous source parameters are accepted', () => {
  const rejected = [
    'https://example.com/conversations/pending/?meeting=meeting-1',
    '//example.com/conversations/pending/?meeting=meeting-1',
    '/conversations/pending/../conversation/?id=day-1&conversation=episode%3A1',
    '/conversations/pending/?meeting=meeting-1#fragment',
    '/conversations/pending/?meeting=meeting-1&start=1',
    '/conversations/pending/?meeting=meeting-1&meeting=other',
    '/conversations/pending/?meeting=meeting-1&space=one&space=two',
    '/conversations/conversation/?id=day-1',
    '/conversations/conversation/?id=&conversation=episode%3A1',
    '/conversations/conversation/?id=day-1&conversation=',
    '/conversations/conversation/?id=day-1&conversation=episode%3A1&conversation=episode%3A2',
    '/conversations/conversation/?id=day-1&conversation=episode%3A1%0A',
    '/settings/?meeting=meeting-1',
  ]
  for (const href of rejected) {
    assert.equal(spaceConversationSource(stub(href), 'woub'), null, href)
  }
})

test('a source with child documents keeps its document classification', () => {
  const page = stub('/conversations/pending/?meeting=meeting-1')
  assert.equal(spaceConversationSource(page, 'woub', [page, { slug: `${page.slug}/notes` }]), null)
  assert.equal(spaceConversationSource(page, 'woub', [page, { slug: `${page.slug}-other/notes` }])?.kind, 'pending')
})

test('generated stubs tolerate surrounding whitespace and Windows line endings', () => {
  const page = stub('/conversations/pending/?meeting=meeting-1', `\r\n\r\n${SPACE_CONVERSATION_PRIVACY_NOTE}`)
  assert.equal(spaceConversationSource({ ...page, content: `\r\n${page.content}\r\n` }, 'woub')?.kind, 'pending')
})

test('discard cleanup selects only its original untouched leaf source', () => {
  const page: WikiPage = {
    ...stub('/conversations/pending/?meeting=meeting-1'),
    title: 'Meeting',
    excerpt: '',
    updatedAt: 1,
    sourceCount: 0,
    revision: 'source-revision',
  }
  const context = { spaceId: 'woub', pageSlug: page.slug, sourceRevision: page.revision }
  assert.deepEqual(discardableManualMeetingSource('meeting-1', context, [page]), {
    spaceId: 'woub',
    slug: page.slug,
    expectedRevision: page.revision,
    onlyIfLeaf: true,
  })
  assert.equal(discardableManualMeetingSource('meeting-2', context, [page]), null)
  assert.equal(discardableManualMeetingSource('meeting-1', { ...context, sourceRevision: undefined }, [page]), null)
  assert.equal(discardableManualMeetingSource('meeting-1', context, [{ ...page, revision: 'edited' }]), null)
  assert.equal(
    discardableManualMeetingSource('meeting-1', context, [{ ...page, content: `${page.content}\n\nEigen notities.` }]),
    null
  )
  assert.equal(
    discardableManualMeetingSource('meeting-1', context, [page, { ...page, slug: `${page.slug}/notities` }]),
    null
  )
})

test('discard marks the generated link unavailable while preserving current notes, title and child documents', () => {
  const page: WikiPage = {
    ...stub(
      '/conversations/pending/?meeting=meeting-1&space=woub&document=meetings%2Fmeeting-1',
      '\n\nEigen notities.'
    ),
    title: 'Mijn aangepaste titel',
    excerpt: '',
    updatedAt: 1,
    sourceCount: 0,
    revision: 'current-edited-revision',
  }
  const context = { spaceId: 'woub', pageSlug: page.slug }
  const pages = [page, { ...page, slug: `${page.slug}/notities` }]
  const expected = {
    spaceId: 'woub',
    slug: page.slug,
    title: page.title,
    content: 'Opname weggegooid\n\nEigen notities.',
    expectedRevision: page.revision,
    strictRevision: true,
  }
  assert.deepEqual(discardedManualMeetingSourceUpdate('meeting-1', context, pages, 'Opname weggegooid'), expected)
  assert.deepEqual(
    discardedManualMeetingSourceUpdate(
      'meeting-1',
      { ...context, sourceRevision: 'outdated-source-revision' },
      pages,
      'Opname weggegooid'
    ),
    expected
  )
  assert.equal(pages[1]?.content, page.content, 'The child document must remain untouched')
})

test('discard source updates require the exact generated link, matching origin and a guarded current revision', () => {
  const page: WikiPage = {
    ...stub(
      '/conversations/pending/?meeting=meeting-1&space=woub&document=meetings%2Fmeeting-1',
      '\n\nEigen notities.'
    ),
    title: 'Meeting',
    excerpt: '',
    updatedAt: 1,
    sourceCount: 0,
    revision: 'current-revision',
  }
  const context = { spaceId: 'woub', pageSlug: page.slug }
  assert.equal(discardedManualMeetingSourceUpdate('meeting-2', context, [page], 'Opname weggegooid'), null)
  assert.equal(discardedManualMeetingSourceUpdate('meeting-1', null, [page], 'Opname weggegooid'), null)
  assert.equal(
    discardedManualMeetingSourceUpdate(
      'meeting-1',
      { ...context, spaceId: 'other-space' },
      [page],
      'Opname weggegooid'
    ),
    null
  )
  for (const candidate of [
    { ...page, revision: undefined },
    { ...page, content: page.content.replace('Open opname en transcript', 'Mijn eigen bronlabel') },
    { ...page, content: page.content.replace('meeting=meeting-1', 'meeting=other-meeting') },
    { ...page, content: 'Opname weggegooid\n\nEigen notities.' },
  ]) {
    assert.equal(discardedManualMeetingSourceUpdate('meeting-1', context, [candidate], 'Opname weggegooid'), null)
  }
})

test('discard removes only the exact generated availability paragraph immediately after its source', () => {
  const source =
    '[Open opname en transcript](/conversations/pending/?meeting=meeting-1&space=woub&document=meetings%2Fmeeting-1)'
  const page: WikiPage = {
    slug: 'meetings/meeting-1',
    content: `${source}\n\n${SPACE_CONVERSATION_PRIVACY_NOTE}\n\nEigen notities.`,
    title: 'Meeting',
    excerpt: '',
    updatedAt: 1,
    sourceCount: 0,
    revision: 'current-revision',
  }
  const context = { spaceId: 'woub', pageSlug: page.slug }
  const update = (content: string) =>
    discardedManualMeetingSourceUpdate('meeting-1', context, [{ ...page, content }], 'Opname weggegooid')?.content

  assert.equal(update(page.content), 'Opname weggegooid\n\nEigen notities.')
  assert.equal(update(`${source}\n\n${SPACE_CONVERSATION_PRIVACY_NOTE}`), 'Opname weggegooid')
  assert.equal(update(page.content.replaceAll('\n', '\r\n')), 'Opname weggegooid\r\n\r\nEigen notities.')
  const customPrivacy = `${SPACE_CONVERSATION_PRIVACY_NOTE} Mijn eigen aanvulling.`
  assert.equal(update(`${source}\n\n${customPrivacy}`), `Opname weggegooid\n\n${customPrivacy}`)
  assert.equal(
    update(`${source}\n\nEigen notities.\n\n${SPACE_CONVERSATION_PRIVACY_NOTE}`),
    `Opname weggegooid\n\nEigen notities.\n\n${SPACE_CONVERSATION_PRIVACY_NOTE}`
  )
})
