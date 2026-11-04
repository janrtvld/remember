import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentProject } from '@remember/shared'
import { createAgentProjectDiscoveryCache } from '../agentProjectDiscoveryCache'

const project: AgentProject = {
  id: '/project',
  name: 'Project',
  path: '/project',
  providers: ['codex'],
  lastUsedAt: 10,
}

test('switching tasks shares an in-flight discovery and reuses its result for a minute', async () => {
  let calls = 0
  let now = 0
  let finish!: (projects: AgentProject[]) => void
  const load = createAgentProjectDiscoveryCache(
    () => {
      calls++
      return new Promise((resolve) => {
        finish = resolve
      })
    },
    { now: () => now }
  )
  const first = load()
  const second = load()
  assert.equal(first, second)
  assert.equal(calls, 1)
  now = 5000
  finish([project])
  assert.deepEqual(await first, [project])
  now = 64_999
  assert.deepEqual(await load(), [project])
  assert.equal(calls, 1)
  now = 65_000
  const refreshed = load()
  assert.equal(calls, 2)
  const newer = { ...project, lastUsedAt: 20 }
  finish([newer])
  assert.deepEqual(await refreshed, [newer])
})

test('discovery failures can retry and empty discovery results are cached', async () => {
  let calls = 0
  const load = createAgentProjectDiscoveryCache(async () => {
    if (++calls === 1) throw new Error('temporarily unavailable')
    return []
  })
  await assert.rejects(load(), /temporarily unavailable/)
  assert.deepEqual(await load(), [])
  assert.deepEqual(await load(), [])
  assert.equal(calls, 2)
})
