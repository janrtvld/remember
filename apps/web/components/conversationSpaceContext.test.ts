import assert from 'node:assert/strict'
import { type TestContext, test } from 'node:test'
import type { WikiPage, WikiSpace } from '@remember/shared'
import {
  captureManualMeetingSourceContext,
  clearManualMeetingSpaceContext,
  conversationSpaceContext,
  conversationSpaceDestination,
  type ManualMeetingSpaceContext,
  preserveManualMeetingSource,
  readManualMeetingSpaceContext,
  saveManualMeetingSpaceContext,
  trackManualMeetingSourceCreation,
  withConversationSpaceContext,
} from './conversationSpaceContext'
import { manualMeetingPendingHref } from './manualMeetingConversation'
import { discardableManualMeetingSource } from './spaceConversation'

const space: WikiSpace = {
  id: 'woub',
  name: 'Woub',
  description: '',
  icon: 'folder',
  color: 'slate',
  maintenanceMode: 'auto',
}
const page: WikiPage = {
  slug: 'meetings/meeting-1',
  title: 'Pushonderzoek',
  content: '',
  excerpt: '',
  updatedAt: 1,
  sourceCount: 1,
}

function storage(t: TestContext) {
  const values = new Map<string, string>()
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    },
  })
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}

function sourcePage(meetingId: string): WikiPage {
  return {
    ...page,
    slug: `meetings/${meetingId}`,
    content: `[Open opname en transcript](/conversations/pending/?meeting=${meetingId})`,
    revision: `revision-${meetingId}`,
  }
}

test('a recording keeps its Space document through stop, pending resolution and transcript return', (t) => {
  storage(t)
  saveManualMeetingSpaceContext('meeting-1', { spaceId: space.id, pageSlug: page.slug })

  const pending = new URL(
    manualMeetingPendingHref('meeting-1', readManualMeetingSpaceContext('meeting-1')),
    'http://local'
  )
  assert.equal(pending.searchParams.get('meeting'), 'meeting-1')
  const detail = new URL(
    withConversationSpaceContext(
      '/conversations/conversation/?id=day-1&conversation=episode%3A1',
      conversationSpaceContext(pending.searchParams)
    ),
    'http://local'
  )
  assert.equal(detail.searchParams.get('id'), 'day-1')
  assert.equal(detail.searchParams.get('conversation'), 'episode:1')
  const destination = conversationSpaceDestination(conversationSpaceContext(detail.searchParams), [space], {
    woub: [page],
  })
  assert.equal(destination?.href, '/wiki/page/?space=woub&slug=meetings%2Fmeeting-1')
  assert.equal(destination?.page, page)
})

test('a saved navigation hint cannot reveal an inaccessible Space or cached document', () => {
  const context = { spaceId: space.id, pageSlug: page.slug }
  assert.equal(conversationSpaceDestination(context, [], { woub: [page] }), null)
  assert.equal(conversationSpaceDestination(context, [space], { woub: [] })?.href, '/wiki/?space=woub')
})

test('unrelated recordings and discarded origins do not inherit a previous meeting destination', (t) => {
  storage(t)
  saveManualMeetingSpaceContext('meeting-1', { spaceId: space.id, pageSlug: page.slug })
  assert.equal(readManualMeetingSpaceContext('meeting-2'), null)
  clearManualMeetingSpaceContext('meeting-2')
  assert.equal(readManualMeetingSpaceContext('meeting-1')?.spaceId, 'woub')
  clearManualMeetingSpaceContext('meeting-1')
  assert.equal(readManualMeetingSpaceContext('meeting-1'), null)
  assert.equal(manualMeetingPendingHref('meeting-2'), '/conversations/pending/?meeting=meeting-2')
})

test('context with special characters remains local and keeps the source identity unchanged', () => {
  const href = withConversationSpaceContext('/conversations/conversation/?id=day-1&conversation=part%2F2', {
    spaceId: 'team / woub',
    pageSlug: 'documents/onderzoek & vervolg',
  })
  const url = new URL(href, 'http://local')
  assert.equal(url.origin, 'http://local')
  assert.equal(url.pathname, '/conversations/conversation/')
  assert.equal(url.searchParams.get('conversation'), 'part/2')
  assert.deepEqual(conversationSpaceContext(url.searchParams), {
    spaceId: 'team / woub',
    pageSlug: 'documents/onderzoek & vervolg',
  })
})

test('the first source edit revokes cleanup before autosave and persists that decision', (t) => {
  storage(t)
  saveManualMeetingSpaceContext('meeting-edited', {
    spaceId: 'woub',
    pageSlug: 'meetings/meeting-edited',
    sourceRevision: 'created-revision',
  })
  preserveManualMeetingSource('other-space', 'meetings/meeting-edited')
  assert.equal(readManualMeetingSpaceContext('meeting-edited')?.sourceRevision, 'created-revision')
  preserveManualMeetingSource('woub', 'meetings/meeting-edited')
  assert.equal(readManualMeetingSpaceContext('meeting-edited')?.sourceRevision, undefined)
  assert.equal(
    JSON.parse(window.localStorage.getItem('remember:active-meeting-space') ?? '{}').sourceRevision,
    undefined
  )
  clearManualMeetingSpaceContext('meeting-edited')
})

test('discard captures an in-flight source creation without borrowing the next recording context', async (t) => {
  storage(t)
  const firstPage = sourcePage('meeting-inflight')
  const origin = { spaceId: 'woub', pageSlug: firstPage.slug }
  saveManualMeetingSpaceContext('meeting-inflight', origin)
  const pending = deferred<ManualMeetingSpaceContext | null>()
  const creation = trackManualMeetingSourceCreation('meeting-inflight', pending.promise)
  const captured = captureManualMeetingSourceContext('meeting-inflight')
  let cleanupReady = false
  const waiting = captured.resolve().then((context) => {
    cleanupReady = true
    return context
  })
  await Promise.resolve()
  assert.equal(cleanupReady, false)

  const nextContext = { spaceId: 'personal', pageSlug: 'meetings/meeting-next' }
  saveManualMeetingSpaceContext('meeting-next', nextContext)
  const created = { ...origin, sourceRevision: firstPage.revision }
  pending.resolve(created)
  const [, context] = await Promise.all([creation, waiting])
  assert.equal(cleanupReady, true)
  assert.deepEqual(context, created)
  assert.deepEqual(discardableManualMeetingSource('meeting-inflight', context, [firstPage]), {
    spaceId: 'woub',
    slug: firstPage.slug,
    expectedRevision: firstPage.revision,
    onlyIfLeaf: true,
  })
  clearManualMeetingSpaceContext('meeting-inflight')
  assert.deepEqual(readManualMeetingSpaceContext('meeting-next'), nextContext)
})

test('a delayed source list still cleans the discarded recording after a new recording starts', async (t) => {
  storage(t)
  const firstPage = sourcePage('meeting-list')
  const context = { spaceId: 'woub', pageSlug: firstPage.slug, sourceRevision: firstPage.revision }
  saveManualMeetingSpaceContext('meeting-list', context)
  const captured = captureManualMeetingSourceContext('meeting-list')
  assert.deepEqual(await captured.resolve(), context)
  const list = deferred<WikiPage[]>()
  const cleanup = list.promise.then(async (pages) =>
    discardableManualMeetingSource('meeting-list', await captured.resolve(), pages)
  )

  const nextContext = { spaceId: 'woub', pageSlug: 'meetings/meeting-list-next' }
  saveManualMeetingSpaceContext('meeting-list-next', nextContext)
  list.resolve([firstPage, sourcePage('meeting-list-next')])
  assert.equal((await cleanup)?.slug, firstPage.slug)
  clearManualMeetingSpaceContext('meeting-list')
  assert.deepEqual(readManualMeetingSpaceContext('meeting-list-next'), nextContext)
})

test('edits during a delayed source list veto cleanup even after the next recording starts', async (t) => {
  storage(t)
  const firstPage = sourcePage('meeting-draft')
  saveManualMeetingSpaceContext('meeting-draft', {
    spaceId: 'woub',
    pageSlug: firstPage.slug,
    sourceRevision: firstPage.revision,
  })
  const captured = captureManualMeetingSourceContext('meeting-draft')
  assert.equal((await captured.resolve())?.sourceRevision, firstPage.revision)
  const list = deferred<WikiPage[]>()
  const cleanup = list.promise.then(async (pages) =>
    discardableManualMeetingSource('meeting-draft', await captured.resolve(), pages)
  )

  saveManualMeetingSpaceContext('meeting-draft-next', { spaceId: 'personal' })
  preserveManualMeetingSource('woub', firstPage.slug)
  list.resolve([firstPage])
  assert.equal(await cleanup, null)
  clearManualMeetingSpaceContext('meeting-draft')
  assert.deepEqual(readManualMeetingSpaceContext('meeting-draft-next'), { spaceId: 'personal' })
})

test('an edit before source creation finishes is not overwritten by the returned source revision', async (t) => {
  storage(t)
  const origin = { spaceId: 'woub', pageSlug: 'meetings/meeting-created-draft' }
  saveManualMeetingSpaceContext('meeting-created-draft', origin)
  const pending = deferred<ManualMeetingSpaceContext | null>()
  const creation = trackManualMeetingSourceCreation('meeting-created-draft', pending.promise)
  const captured = captureManualMeetingSourceContext('meeting-created-draft')
  preserveManualMeetingSource(origin.spaceId, origin.pageSlug)
  pending.resolve({ ...origin, sourceRevision: 'late-created-revision' })
  await creation
  assert.deepEqual(await captured.resolve(), origin)
  clearManualMeetingSpaceContext('meeting-created-draft')
})

test('unavailable context storage never supplies authority to delete a source', async (t) => {
  storage(t)
  window.localStorage.getItem = () => {
    throw new Error('storage-unavailable')
  }
  assert.equal(readManualMeetingSpaceContext('meeting-1'), null)
  const creation = trackManualMeetingSourceCreation(
    'meeting-1',
    Promise.resolve({ spaceId: 'woub', pageSlug: page.slug, sourceRevision: 'created-revision' })
  )
  const captured = captureManualMeetingSourceContext('meeting-1')
  await creation
  assert.equal(await captured.resolve(), null)
})
