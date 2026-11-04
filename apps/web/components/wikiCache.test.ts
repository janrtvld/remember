import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBrowserBridge } from '../lib/browserBridge'
import { createWikiCacheAccess, retainWikiPageCache } from './wikiCache'

test('removing a local Space clears its cache and rejects outstanding responses', async () => {
  const bridge = createBrowserBridge()
  const beforeCreate = await bridge.getWikiOverview()
  const created = await bridge.createLocalWikiSpace({ name: 'Research', description: '' })
  const space = created.spaces.find(
    (candidate) => !beforeCreate.spaces.some((existing) => existing.id === candidate.id)
  )
  assert(space)
  const cache = createWikiCacheAccess()
  cache.acceptOverview(created)
  const revision = cache.revision()
  const pages = await bridge.createWikiPage({ spaceId: space.id, title: 'Findings', category: 'documents' })
  const personal = await bridge.listWikiPages('personal')

  const removed = await bridge.removeLocalWikiSpace({ spaceId: space.id })
  assert(cache.acceptOverview(removed, revision))
  assert.equal(cache.acceptsPages(space.id, revision), false)
  assert.equal(cache.acceptOverview(created, revision), null)
  assert.deepEqual(retainWikiPageCache({ personal, [space.id]: pages }, removed), { personal })
  await assert.rejects(bridge.listWikiPages(space.id), /wiki-space-not-found/)
  await assert.rejects(bridge.removeLocalWikiSpace({ spaceId: 'personal' }), /wiki-personal-space-required/)
})

test('local Spaces with the same name remain independent', async () => {
  const bridge = createBrowserBridge()
  const initial = await bridge.getWikiOverview()
  await bridge.createLocalWikiSpace({ name: 'Research', description: '' })
  const overview = await bridge.createLocalWikiSpace({ name: 'Research', description: '' })
  const created = overview.spaces.filter((space) => !initial.spaces.some((existing) => existing.id === space.id))
  assert.equal(created.length, 2)
  assert.notEqual(created[0].id, created[1].id)
  await bridge.createWikiPage({ spaceId: created[0].id, title: 'Findings', category: 'documents' })
  assert.equal((await bridge.listWikiPages(created[1].id)).length, 0)
})
