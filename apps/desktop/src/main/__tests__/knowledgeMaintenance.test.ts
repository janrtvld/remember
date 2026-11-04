import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { WikiPageUpdate } from '@remember/shared'
import { createKnowledgeMaintenance, type KnowledgeMaintenanceSnapshot } from '../knowledgeMaintenance'

const directories: string[] = []
after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
})

function statePath() {
  const directory = mkdtempSync(join(tmpdir(), 'remember-knowledge-maintenance-'))
  directories.push(directory)
  return join(directory, 'organization.json')
}

function coveredSources(path: string) {
  return (JSON.parse(readFileSync(path, 'utf8')) as { coveredSources: string[] }).coveredSources
}

function snapshot(): KnowledgeMaintenanceSnapshot {
  return {
    policyToken: 'permitted-capture-policy',
    enabledSince: 100,
    pages: [
      {
        slug: 'projects/woub',
        title: 'Woub',
        content: 'Mobile work.',
        revision: 'revision-1',
        excerpt: '',
        sourceCount: 1,
        updatedAt: 100,
        spaceId: 'personal',
      },
    ],
    sources: [
      {
        id: 'original',
        observedAt: 200,
        kind: 'screen-context',
        text: 'Tom coordinates customer rollout for Woub while I work on its mobile app.',
      },
    ],
  }
}

function update(input: KnowledgeMaintenanceSnapshot): WikiPageUpdate {
  const source = input.sources[0]
  assert.ok(source)
  return {
    slug: 'people/tom',
    title: 'Tom',
    content: 'Coordinates customer rollout for [Woub](projects/woub).',
    summary: 'Linked Tom to Woub.',
    changeType: 'created',
    suggestedSpaceId: 'personal',
    evidence: [{ sourceId: source.id, observedAt: source.observedAt, kind: source.kind, quote: source.text }],
  }
}

function firstPage(input: KnowledgeMaintenanceSnapshot) {
  const page = input.pages[0]
  assert.ok(page)
  return page
}

function firstSource(input: KnowledgeMaintenanceSnapshot) {
  const source = input.sources[0]
  assert.ok(source)
  return source
}

test('disabled maintenance and original evidence before consent never reach generation', async () => {
  const path = statePath()
  for (const input of [null, { ...snapshot(), enabledSince: 300 }]) {
    const maintenance = createKnowledgeMaintenance({
      statePath: path,
      snapshot: async () => input,
      generate: async () => assert.fail('No eligible original evidence'),
      apply: async () => assert.fail('No generated update'),
    })
    assert.equal((await maintenance.run()).updateCount, 0)
  }
  assert.equal(existsSync(path), false)
})

test('successful no-op persists only coverage and stays covered across restart and input ordering', async () => {
  const path = statePath()
  const input = snapshot()
  input.sources.push({ ...firstSource(input), id: 'second', text: 'No additional relationship context is supported.' })
  let generated = 0
  const dependencies = {
    statePath: path,
    snapshot: async () => ({ ...input, sources: [...input.sources].reverse() }),
    generate: async () => {
      generated += 1
      return []
    },
    apply: async () => assert.fail('No-op must not write Wiki pages'),
  }
  assert.deepEqual(await createKnowledgeMaintenance(dependencies).run(), { status: 'applied', updateCount: 0 })
  assert.deepEqual(await createKnowledgeMaintenance(dependencies).run(), { status: 'covered', updateCount: 0 })
  assert.equal(generated, 2)
  const state = readFileSync(path, 'utf8')
  assert.equal(state.includes(firstSource(input).text), false)
  assert.equal(state.includes(firstPage(input).content), false)
})

test('page edits do not replay completed sources, while changed original evidence is assessed again', async () => {
  const input = snapshot()
  let generated = 0
  const maintenance = createKnowledgeMaintenance({
    statePath: statePath(),
    snapshot: async () => structuredClone(input),
    generate: async () => {
      generated += 1
      return []
    },
    apply: async () => assert.fail('No-op'),
  })
  await maintenance.run()
  firstPage(input).revision = 'human-edited-revision'
  await maintenance.run()
  firstSource(input).text += ' This responsibility has changed.'
  await maintenance.run()
  assert.equal(generated, 2)
})

test('a failed generation or application leaves coverage retryable', async () => {
  const path = statePath()
  const input = snapshot()
  let failGeneration = true
  let failApplication = true
  let now = 0
  const maintenance = createKnowledgeMaintenance({
    statePath: path,
    now: () => now,
    snapshot: async () => input,
    generate: async () => {
      if (failGeneration) throw new Error('provider-unavailable')
      return [update(input)]
    },
    apply: async () => {
      if (failApplication) throw new Error('wiki-page-conflict')
    },
  })
  await assert.rejects(maintenance.run(), /provider-unavailable/)
  assert.equal(coveredSources(path).length, 0)
  assert.equal((await maintenance.run()).status, 'deferred')
  failGeneration = false
  now += 60_000
  await assert.rejects(maintenance.run(), /wiki-page-conflict/)
  assert.equal(coveredSources(path).length, 0)
  failApplication = false
  now += 120_000
  assert.deepEqual(await maintenance.run(), { status: 'applied', updateCount: 1 })
  assert.equal(existsSync(path), true)
})

test('policy changes and human edits during inference discard the whole generated result', async () => {
  for (const invalidate of [
    (input: KnowledgeMaintenanceSnapshot) => {
      input.policyToken = 'changed-capture-policy'
    },
    (input: KnowledgeMaintenanceSnapshot) => {
      firstPage(input).revision = 'human-edit'
    },
    (input: KnowledgeMaintenanceSnapshot) => {
      firstSource(input).text = 'This original source was redacted.'
    },
    (input: KnowledgeMaintenanceSnapshot) => {
      input.contextToken = 'changed-pending-proposals'
    },
  ]) {
    const path = statePath()
    const input = snapshot()
    const maintenance = createKnowledgeMaintenance({
      statePath: path,
      snapshot: async () => structuredClone(input),
      generate: async (before) => {
        invalidate(input)
        return [update(before)]
      },
      apply: async () => assert.fail('Stale generation must never reach Wiki writer'),
    })
    assert.deepEqual(await maintenance.run(), { status: 'invalidated', updateCount: 0 })
    assert.equal(existsSync(path), false)
  }
})

test('writer can revalidate eligibility after its own awaited operations', async () => {
  const path = statePath()
  let input: KnowledgeMaintenanceSnapshot | null = snapshot()
  const maintenance = createKnowledgeMaintenance({
    statePath: path,
    snapshot: async () => input,
    generate: async (before) => [update(before)],
    apply: async (_updates, _before, isCurrent) => {
      input = null
      assert.equal(await isCurrent(), false)
      throw new Error('knowledge-maintenance-invalidated')
    },
  })
  assert.equal((await maintenance.run()).status, 'invalidated')
  assert.equal(existsSync(path), false)
})

test('existing pages, shared destinations and unsupported quotes never reach the writer', async () => {
  const input = snapshot()
  const originalEvidence = update(input).evidence?.[0]
  assert.ok(originalEvidence)
  for (const candidate of [
    { ...update(input), slug: 'projects/woub' },
    { ...update(input), suggestedSpaceId: 'shared-company' },
    { ...update(input), evidence: [] },
    { ...update(input), evidence: [{ ...originalEvidence, quote: 'Invented relationship.' }] },
    { ...update(input), slug: 'people/tom', changeType: 'updated' as const },
  ]) {
    const path = statePath()
    const maintenance = createKnowledgeMaintenance({
      statePath: path,
      snapshot: async () => input,
      generate: async () => [candidate],
      apply: async () => assert.fail('Invalid update must never be applied'),
    })
    await assert.rejects(maintenance.run(), /knowledge-maintenance-/)
    assert.equal(coveredSources(path).length, 0)
  }
})

test('an existing self profile prevents a second profile under the new canonical path', async () => {
  const input = snapshot()
  input.pages.push({ ...firstPage(input), slug: 'people/work-profile', title: 'My role' })
  const maintenance = createKnowledgeMaintenance({
    statePath: statePath(),
    snapshot: async () => input,
    generate: async () => [{ ...update(input), slug: 'people/me', title: 'Me' }],
    apply: async () => assert.fail('Existing self identity must be reused'),
  })
  await assert.rejects(maintenance.run(), /invalid-target/)
})

test('exact quotes cannot launder source provenance into a direct user statement', async () => {
  const input = snapshot()
  const originalEvidence = update(input).evidence?.[0]
  assert.ok(originalEvidence)
  for (const patch of [
    { role: 'user' as const },
    { provider: 'codex' as const },
    { project: 'Invented project' },
    { documentSourceId: 'another-conversation' },
    { eventId: 'another-event' },
    { partIndex: 1 },
    { partCount: 2 },
    { kind: 'agent-session' },
    { observedAt: originalEvidence.observedAt + 1 },
  ]) {
    const maintenance = createKnowledgeMaintenance({
      statePath: statePath(),
      snapshot: async () => input,
      generate: async () => [{ ...update(input), evidence: [{ ...originalEvidence, ...patch }] }],
      apply: async () => assert.fail('Changed provenance must not reach the writer'),
    })
    await assert.rejects(maintenance.run(), /original-evidence-required/)
  }
})

test('private repair never reads a shared-space page as personal relationship evidence', async () => {
  const input = snapshot()
  firstPage(input).spaceId = 'shared-company'
  const maintenance = createKnowledgeMaintenance({
    statePath: statePath(),
    snapshot: async () => input,
    generate: async () => assert.fail('Shared context is outside this repair'),
    apply: async () => assert.fail('No generated update'),
  })
  await assert.rejects(maintenance.run(), /private-scope-required/)
})

test('overlapping runtime triggers share one in-flight reconciliation', async () => {
  const input = snapshot()
  let generated = 0
  const maintenance = createKnowledgeMaintenance({
    statePath: statePath(),
    snapshot: async () => input,
    generate: async () => {
      generated += 1
      return []
    },
    apply: async () => assert.fail('No-op'),
  })
  const first = maintenance.run()
  const second = maintenance.run()
  assert.equal(first, second)
  await Promise.all([first, second])
  assert.equal(generated, 1)
})

test('more than sixteen missing people progress in bounded source batches without replaying added pages', async () => {
  const path = statePath()
  const input = snapshot()
  input.sources = Array.from({ length: 20 }, (_, index) => ({
    id: `original-${index}`,
    observedAt: 200 + index,
    kind: 'screen-context',
    text: `Person ${index} coordinates a separate Woub customer rollout and is a named collaborator.`,
  }))
  let generated = 0
  const dependencies = {
    statePath: path,
    snapshot: async () => structuredClone(input),
    generate: async (batch: KnowledgeMaintenanceSnapshot) => {
      generated += 1
      assert.equal(batch.sources.length, 1)
      const source = firstSource(batch)
      return [{ ...update(batch), slug: `people/person-${source.id.slice('original-'.length)}` }]
    },
    apply: async (updates: WikiPageUpdate[]) => {
      for (const candidate of updates) {
        input.pages.push({
          ...firstPage(input),
          slug: candidate.slug,
          title: candidate.title,
          content: candidate.content ?? '',
          revision: `created-${candidate.slug}`,
        })
      }
    },
  }
  const first = createKnowledgeMaintenance(dependencies)
  assert.equal((await first.run()).updateCount, 8)
  assert.equal((await first.run()).updateCount, 8)
  const restarted = createKnowledgeMaintenance(dependencies)
  assert.equal((await restarted.run()).updateCount, 4)
  assert.equal((await restarted.run()).status, 'covered')
  assert.equal(generated, 20)
  assert.equal(input.pages.filter((page) => page.slug.startsWith('people/')).length, 20)
  input.contextToken = 'new-pending-proposal-state'
  assert.equal((await restarted.run()).status, 'covered')
  assert.equal(generated, 20)
})

test('a repeatedly failing oldest source backs off across restart while newer sources are covered', async () => {
  const path = statePath()
  const input = snapshot()
  input.sources = [
    { ...firstSource(input), id: 'oldest-fails', observedAt: 150 },
    ...Array.from({ length: 16 }, (_, index) => ({
      ...firstSource(input),
      id: `valid-${index}`,
      observedAt: 200 + index,
    })),
  ]
  let now = 0
  let failedAttempts = 0
  const dependencies = {
    statePath: path,
    now: () => now,
    snapshot: async () => input,
    generate: async (batch: KnowledgeMaintenanceSnapshot) => {
      if (firstSource(batch).id === 'oldest-fails') {
        failedAttempts += 1
        throw new Error('source-needs-more-context')
      }
      return []
    },
    apply: async () => assert.fail('No-op'),
  }
  await assert.rejects(createKnowledgeMaintenance(dependencies).run(), /source-needs-more-context/)
  assert.equal(coveredSources(path).length, 7)
  const restarted = createKnowledgeMaintenance(dependencies)
  await restarted.run()
  await restarted.run()
  assert.equal(coveredSources(path).length, 16)
  assert.equal(failedAttempts, 1)
  assert.equal((await restarted.run()).status, 'deferred')
  now += 60_000
  await assert.rejects(restarted.run(), /source-needs-more-context/)
  assert.equal(failedAttempts, 2)
  assert.equal(coveredSources(path).length, 16)
})

test('provider, maintenance mode and consent changes never replay a covered source or recreate a deleted page', async () => {
  const input = snapshot()
  let generated = 0
  const maintenance = createKnowledgeMaintenance({
    statePath: statePath(),
    snapshot: async () => input,
    generate: async (batch) => {
      generated += 1
      return [update(batch)]
    },
    apply: async (updates) => {
      for (const candidate of updates)
        input.pages.push({ ...firstPage(input), slug: candidate.slug, title: candidate.title })
    },
  })
  await maintenance.run()
  input.pages = input.pages.filter((page) => !page.slug.startsWith('people/'))
  input.policyToken = 'different-provider-or-maintenance-mode'
  input.enabledSince = 150
  assert.equal((await maintenance.run()).status, 'covered')
  assert.equal(generated, 1)
  assert.equal(
    input.pages.some((page) => page.slug === 'people/tom'),
    false
  )
})

test('withheld page text never enters generation while local collision protection retains its identity', async () => {
  const path = statePath()
  const input = snapshot()
  input.pages.push({ ...firstPage(input), slug: 'people/tom', title: 'Private relationship', content: 'WITHHELD BODY' })
  input.permittedPageSlugs = ['projects/woub']
  const maintenance = createKnowledgeMaintenance({
    statePath: path,
    snapshot: async () => input,
    generate: async (batch) => {
      assert.deepEqual(
        batch.pages.map((page) => page.slug),
        ['projects/woub']
      )
      assert.equal(JSON.stringify(batch).includes('WITHHELD BODY'), false)
      return [update(batch)]
    },
    apply: async () => assert.fail('The hidden existing target still cannot be overwritten'),
  })
  await assert.rejects(maintenance.run(), /invalid-target/)
  assert.equal(coveredSources(path).length, 0)
})

test('privacy whitelist changes during inference defer evidence without losing future coverage', async () => {
  const path = statePath()
  const input = snapshot()
  input.permittedPageSlugs = ['projects/woub']
  let generated = 0
  const maintenance = createKnowledgeMaintenance({
    statePath: path,
    snapshot: async () => structuredClone(input),
    generate: async () => {
      generated += 1
      if (generated === 1) input.permittedPageSlugs = []
      return []
    },
    apply: async () => assert.fail('No-op'),
  })
  assert.equal((await maintenance.run()).status, 'invalidated')
  assert.equal(existsSync(path), false)
  assert.equal((await maintenance.run()).status, 'applied')
  assert.equal(coveredSources(path).length, 1)
  assert.equal((await maintenance.run()).status, 'covered')
  assert.equal(generated, 2)
})

test('an oversized original passage is never clipped or acknowledged and does not block other sources', async () => {
  const path = statePath()
  const input = snapshot()
  input.sources.unshift({ ...firstSource(input), id: 'oversized', text: 'x'.repeat(60_001) })
  let generated = 0
  const dependencies = {
    statePath: path,
    snapshot: async () => input,
    generate: async (batch: KnowledgeMaintenanceSnapshot) => {
      generated += 1
      assert.equal(batch.sources.length, 1)
      assert.equal(firstSource(batch).id, 'original')
      return []
    },
    apply: async () => assert.fail('No-op'),
  }
  await assert.rejects(createKnowledgeMaintenance(dependencies).run(), /source-too-large/)
  assert.equal((await createKnowledgeMaintenance(dependencies).run()).status, 'deferred')
  assert.equal(generated, 1)
  input.sources.shift()
  assert.equal((await createKnowledgeMaintenance(dependencies).run()).status, 'covered')
})

test('stopping returns immediately and invalidates an in-flight provider before the writer', async () => {
  const input = snapshot()
  let finish: ((updates: WikiPageUpdate[]) => void) | undefined
  let started: (() => void) | undefined
  let providerSignal: AbortSignal | undefined
  const didStart = new Promise<void>((resolve) => {
    started = resolve
  })
  const maintenance = createKnowledgeMaintenance({
    statePath: statePath(),
    snapshot: async () => input,
    generate: async (_snapshot, signal) => {
      providerSignal = signal
      started?.()
      return new Promise<WikiPageUpdate[]>((resolve) => {
        finish = resolve
      })
    },
    apply: async () => assert.fail('Stopped work must not mutate Wiki state'),
  })
  const run = maintenance.run()
  await didStart
  const stopped = maintenance.stop()
  assert.equal(providerSignal?.aborted, true)
  finish?.([update(input)])
  await stopped
  assert.equal((await run).status, 'invalidated')
  assert.equal((await maintenance.run()).status, 'disabled')
})
