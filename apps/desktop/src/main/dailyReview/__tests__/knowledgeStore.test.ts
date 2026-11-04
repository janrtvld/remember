import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { getWikiPageAnalysisEditContext } from '../../wikiHistoryStore'
import {
  applyKnowledgeUpdates,
  applyManagedKnowledgeUpdates,
  applyManagedKnowledgeUpdatesAt,
  createKnowledgePageAt,
  deleteKnowledgePageTree,
  getKnowledgePageHistoryAt,
  initializeKnowledgeStore,
  listKnowledgePagesAt,
  listPersonalWikiChanges,
  moveKnowledgePageTreeAt,
  prepareManagedKnowledgeUpdatesAt,
  removeKnowledgeForSession,
  restoreKnowledgePageRevisionAt,
  saveKnowledgePageAt,
  upsertKnowledgePageAt,
} from '../knowledgeStore'
import { wikiPagesForPrompt } from '../wikiPromptSafety'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function wikiDirectory() {
  const directory = mkdtempSync(join(tmpdir(), `remember-wiki-${randomUUID()}-`))
  directories.push(directory)
  return directory
}

describe('knowledge store spaces', () => {
  it('rejects a write-time alias retarget without changing the newly existing page or its history', () => {
    initializeKnowledgeStore(wikiDirectory())
    const directory = wikiDirectory()
    const existing = { slug: 'projects/trip', title: 'Trip', content: 'Checkout becomes October Monday.' }
    upsertKnowledgePageAt(directory, existing)
    const candidate = {
      ...existing,
      slug: 'projects/trip-guide',
      title: 'Trip guide',
      summary: 'Confirm checkout.',
      changeType: 'created' as const,
    }
    const before = readFileSync(join(directory, `${existing.slug}.md`), 'utf8')
    const history = getKnowledgePageHistoryAt(directory, existing.slug)
    assert.throws(
      () => prepareManagedKnowledgeUpdatesAt(directory, 'daily-review://day', [candidate], { allowRetargeting: false }),
      /wiki-page-conflict/
    )
    assert.throws(
      () =>
        applyManagedKnowledgeUpdatesAt(directory, 'daily-review://day', 100, [candidate], 'Remember', {
          allowRetargeting: false,
        }),
      /wiki-page-conflict/
    )
    assert.equal(readFileSync(join(directory, `${existing.slug}.md`), 'utf8'), before)
    assert.deepEqual(getKnowledgePageHistoryAt(directory, existing.slug), history)
    assert.equal(existsSync(join(directory, `${candidate.slug}.md`)), false)
    assert.equal(
      prepareManagedKnowledgeUpdatesAt(directory, 'daily-review://day', [candidate]).notes[0]?.type,
      'retargeted'
    )
  })

  it('allows unchanged reviewed targets and genuinely new pages when retargeting is disabled', () => {
    initializeKnowledgeStore(wikiDirectory())
    const directory = wikiDirectory()
    const candidate = {
      slug: 'projects/trip',
      title: 'Trip',
      content: 'Checkout is confirmed.',
      summary: 'Confirm checkout.',
      changeType: 'created' as const,
    }
    const created = applyManagedKnowledgeUpdatesAt(directory, 'daily-review://day', 100, [candidate], 'Remember', {
      allowRetargeting: false,
    })
    assert.equal(created[0]?.slug, candidate.slug)
    const changed = applyManagedKnowledgeUpdatesAt(
      directory,
      'daily-review://day',
      200,
      [{ ...candidate, content: 'Checkout is confirmed for Monday.' }],
      'Remember',
      { allowRetargeting: false }
    )
    assert.equal(changed[0]?.slug, candidate.slug)
    assert.match(readFileSync(join(directory, `${candidate.slug}.md`), 'utf8'), /confirmed for Monday/)
  })

  it('does not prepare a Suggest-mode proposal for existing content or whitespace-only changes', () => {
    initializeKnowledgeStore(wikiDirectory())
    const directory = wikiDirectory()
    const slug = 'projects/usa'
    upsertKnowledgePageAt(directory, {
      slug,
      title: 'USA',
      content:
        'Human note.\n\n<!-- remember-managed:start -->\nCheckout is September 30.\n<!-- remember-managed:end -->',
    })
    const before = getKnowledgePageHistoryAt(directory, slug)
    const unchanged = {
      slug,
      title: 'USA',
      content: 'Checkout is  September 30.\n',
      summary: 'Rephrased checkout.',
      changeType: 'updated' as const,
    }
    assert.deepEqual(prepareManagedKnowledgeUpdatesAt(directory, 'daily-review://new-day', [unchanged]).prepared, [])
    assert.deepEqual(getKnowledgePageHistoryAt(directory, slug), before)
    const changed = prepareManagedKnowledgeUpdatesAt(directory, 'daily-review://new-day', [
      { ...unchanged, content: 'Checkout is October 1.' },
    ])
    assert.equal(changed.prepared.length, 1)
    assert.match(changed.prepared[0]?.page.content ?? '', /Human note/)
  })

  it('prepares an exact AI rewrite without advancing the cache or its history', () => {
    const userDataDirectory = wikiDirectory()
    const sharedDirectory = wikiDirectory()
    initializeKnowledgeStore(userDataDirectory)
    const slug = 'projects/remember/wiki'
    upsertKnowledgePageAt(sharedDirectory, {
      slug,
      title: 'Wiki',
      content: 'Human constraint.\n\n<!-- remember-managed:start -->\nOld state.\n<!-- remember-managed:end -->',
    })
    const path = join(sharedDirectory, `${slug}.md`)
    const before = readFileSync(path, 'utf8')

    const { prepared } = prepareManagedKnowledgeUpdatesAt(sharedDirectory, 'daily-review://day-1', [
      {
        slug,
        title: 'Wiki',
        content: 'New verified state.',
        summary: 'Reconciled the Wiki state.',
        changeType: 'updated',
      },
    ])

    assert.equal(readFileSync(path, 'utf8'), before)
    assert.equal(getKnowledgePageHistoryAt(sharedDirectory, slug).revisions.length, 1)
    assert.match(prepared[0]?.page.content ?? '', /Human constraint/)
    assert.match(prepared[0]?.page.content ?? '', /New verified state/)
  })

  it('writes managed updates to a shared cache without touching the Personal Wiki', () => {
    const userDataDirectory = wikiDirectory()
    const sharedDirectory = wikiDirectory()
    initializeKnowledgeStore(userDataDirectory)
    const update = {
      slug: 'projects/woub/releases',
      title: 'Releases',
      content: '## Current state\n\nThe team release flow is current.',
      summary: 'Updated the release flow.',
      changeType: 'updated' as const,
    }

    applyManagedKnowledgeUpdatesAt(sharedDirectory, 'daily-review://day-1', Date.UTC(2026, 7, 19), [update])

    assert.match(readFileSync(join(sharedDirectory, `${update.slug}.md`), 'utf8'), /team release flow/)
    assert.equal(listKnowledgePagesAt(join(userDataDirectory, 'daily-review', 'wiki')).length, 0)
  })

  it('removes an entire Personal project only after its exact pages can be copied', () => {
    const userDataDirectory = wikiDirectory()
    initializeKnowledgeStore(userDataDirectory)
    const directory = join(userDataDirectory, 'daily-review', 'wiki')
    upsertKnowledgePageAt(directory, { slug: 'projects/woub', title: 'Woub', content: 'Project overview.' })
    upsertKnowledgePageAt(directory, {
      slug: 'projects/woub/releases',
      title: 'Releases',
      content: 'Release context.',
    })
    upsertKnowledgePageAt(directory, { slug: 'projects/remember', title: 'Remember', content: 'Private context.' })

    const remaining = deleteKnowledgePageTree('projects/woub')

    assert.deepEqual(
      remaining.map((page) => page.slug),
      ['index', 'projects/remember']
    )
  })

  it('keeps page identity and history when moving a project between private Wikis', () => {
    const userDataDirectory = wikiDirectory()
    const sourceDirectory = wikiDirectory()
    const destinationDirectory = wikiDirectory()
    initializeKnowledgeStore(userDataDirectory)
    upsertKnowledgePageAt(sourceDirectory, {
      slug: 'projects/remember',
      title: 'Remember',
      content: 'AI-maintained Wiki.',
    })
    upsertKnowledgePageAt(sourceDirectory, {
      slug: 'projects/remember/wiki',
      title: 'Wiki',
      content: 'Per-space maintenance.',
    })
    upsertKnowledgePageAt(sourceDirectory, {
      slug: 'projects/remember-private',
      title: 'Remember private notes',
      content: 'This is not part of the selected project tree.',
    })
    const before = getKnowledgePageHistoryAt(sourceDirectory, 'projects/remember/wiki')

    moveKnowledgePageTreeAt(sourceDirectory, destinationDirectory, 'projects/remember')

    const after = getKnowledgePageHistoryAt(destinationDirectory, 'projects/remember/wiki')
    assert.equal(after.pageId, before.pageId)
    assert.deepEqual(after.revisions, before.revisions)
    assert.equal(
      listKnowledgePagesAt(sourceDirectory).some(
        (page) => page.slug === 'projects/remember' || page.slug.startsWith('projects/remember/')
      ),
      false
    )
    assert.equal(
      listKnowledgePagesAt(sourceDirectory).some((page) => page.slug === 'projects/remember-private'),
      true
    )
    assert.equal(
      listKnowledgePagesAt(destinationDirectory).some((page) => page.slug === 'projects/remember/wiki'),
      true
    )
    assert.equal(
      listKnowledgePagesAt(destinationDirectory).some((page) => page.slug === 'projects/remember-private'),
      false
    )
  })

  it('preserves AI and user edit context when completing a partially synced move into a Shared cache', () => {
    const userDataDirectory = wikiDirectory()
    const sourceDirectory = join(userDataDirectory, 'daily-review', 'wiki')
    const destinationDirectory = join(userDataDirectory, 'daily-review', 'wiki-spaces', 'team', 'wiki')
    initializeKnowledgeStore(userDataDirectory)
    applyManagedKnowledgeUpdatesAt(sourceDirectory, 'daily-review://day-1', 10, [
      {
        slug: 'projects/remember',
        title: 'Remember',
        content: 'Current AI-maintained state.',
        summary: 'Created the project baseline.',
        changeType: 'created',
      },
    ])
    upsertKnowledgePageAt(sourceDirectory, {
      slug: 'projects/remember-private',
      title: 'Private notes',
      content: 'Never move this sibling page.',
    })
    const generated = listKnowledgePagesAt(sourceDirectory).find((page) => page.slug === 'projects/remember')
    assert.ok(generated?.revision)
    saveKnowledgePageAt(sourceDirectory, {
      spaceId: 'personal',
      slug: generated.slug,
      title: generated.title,
      content: `${generated.content}\n\nHuman constraint: keep Suggest mode enabled.`,
      expectedRevision: generated.revision,
    })
    const edited = listKnowledgePagesAt(sourceDirectory).find((page) => page.slug === 'projects/remember')
    assert.ok(edited)

    upsertKnowledgePageAt(destinationDirectory, edited)
    moveKnowledgePageTreeAt(sourceDirectory, destinationDirectory, 'projects/remember', {
      replaceIdenticalDestination: true,
    })

    const context = getWikiPageAnalysisEditContext('team', 'projects/remember')
    assert.equal(context?.lastRememberRevision?.content.includes('Current AI-maintained state.'), true)
    assert.deepEqual(
      context?.changesSinceRemember.map((change) => change.actor),
      ['user']
    )
    assert.equal(getKnowledgePageHistoryAt(destinationDirectory, 'projects/remember').revisions.length, 2)
    assert.equal(
      listKnowledgePagesAt(sourceDirectory).some((page) => page.slug === 'projects/remember-private'),
      true
    )
    assert.equal(
      listKnowledgePagesAt(destinationDirectory).some((page) => page.slug === 'projects/remember-private'),
      false
    )
  })

  it('preserves an unattributed file change without claiming the user made it', () => {
    const userDataDirectory = wikiDirectory()
    const directory = join(userDataDirectory, 'daily-review', 'wiki')
    initializeKnowledgeStore(userDataDirectory)
    applyManagedKnowledgeUpdatesAt(directory, 'daily-review://day-1', 10, [
      {
        slug: 'projects/remember',
        title: 'Remember',
        content: 'Remember baseline.',
        summary: 'Created the baseline.',
        changeType: 'created',
      },
    ])
    writeFileSync(join(directory, 'projects/remember.md'), '# Remember\n\nChanged outside the editor.\n')

    listKnowledgePagesAt(directory)

    const history = getKnowledgePageHistoryAt(directory, 'projects/remember')
    assert.equal(history.revisions[0]?.actor, 'external')
    assert.equal(history.revisions[0]?.sourceId, 'recovery://unattributed-file-change')
    const context = getWikiPageAnalysisEditContext('personal', 'projects/remember')
    assert.equal(context?.lastRememberRevision?.content.includes('Remember baseline.'), true)
    assert.deepEqual(
      context?.changesSinceRemember.map((change) => change.actor),
      ['external']
    )
  })

  it('creates and edits pages inside the requested space directory', () => {
    const directory = wikiDirectory()
    const created = createKnowledgePageAt(directory, {
      spaceId: 'space-1',
      category: 'projects',
      title: 'Remember Cloud sync',
    })
    const page = created.find((candidate) => candidate.slug === 'projects/remember-cloud-sync')
    assert.ok(page)

    saveKnowledgePageAt(directory, {
      spaceId: 'space-1',
      slug: page.slug,
      title: page.title,
      content: 'Uses a Remember-hosted Wiki.',
      expectedRevision: page.revision,
    })

    assert.equal(
      listKnowledgePagesAt(directory).find((candidate) => candidate.slug === page.slug)?.excerpt,
      'Uses a Remember hosted Wiki.'
    )
    assert.match(readFileSync(join(directory, 'index.md'), 'utf8'), /Remember Cloud sync/)
  })

  it('rebases a stale editor save when another writer changed a different region', () => {
    const directory = wikiDirectory()
    const created = createKnowledgePageAt(directory, {
      spaceId: 'space-1',
      category: 'projects',
      title: 'Concurrent memory',
    })
    const original = created.find((candidate) => candidate.slug === 'projects/concurrent-memory')
    assert.ok(original?.revision)

    const baseline = saveKnowledgePageAt(directory, {
      spaceId: 'space-1',
      slug: original.slug,
      title: original.title,
      content: '## User section\nOriginal.\n\n## Agent section\nOriginal.',
      expectedRevision: original.revision,
    }).find((candidate) => candidate.slug === original.slug)
    assert.ok(baseline?.revision)

    const externallyUpdated = saveKnowledgePageAt(directory, {
      spaceId: 'space-1',
      slug: original.slug,
      title: original.title,
      content: '## User section\nOriginal.\n\n## Agent section\nAgent update.',
      expectedRevision: baseline.revision,
    }).find((candidate) => candidate.slug === original.slug)
    assert.ok(externallyUpdated?.revision)

    saveKnowledgePageAt(directory, {
      spaceId: 'space-1',
      slug: original.slug,
      title: original.title,
      content: '## User section\nStale editor update.\n\n## Agent section\nOriginal.',
      expectedRevision: baseline.revision,
    })
    assert.equal(
      listKnowledgePagesAt(directory).find((candidate) => candidate.slug === original.slug)?.content,
      '## User section\nStale editor update.\n\n## Agent section\nAgent update.'
    )
  })

  it('rejects a stale editor save only when both writers changed the same region', () => {
    const directory = wikiDirectory()
    const created = createKnowledgePageAt(directory, {
      spaceId: 'space-1',
      category: 'projects',
      title: 'Concurrent memory',
    })
    const original = created.find((candidate) => candidate.slug === 'projects/concurrent-memory')
    assert.ok(original?.revision)

    saveKnowledgePageAt(directory, {
      spaceId: 'space-1',
      slug: original.slug,
      title: original.title,
      content: 'Agent update.',
      expectedRevision: original.revision,
    })

    assert.throws(
      () =>
        saveKnowledgePageAt(directory, {
          spaceId: 'space-1',
          slug: original.slug,
          title: original.title,
          content: 'Stale editor update.',
          expectedRevision: original.revision,
        }),
      { message: 'wiki-page-conflict' }
    )
    assert.equal(
      listKnowledgePagesAt(directory).find((candidate) => candidate.slug === original.slug)?.content,
      'Agent update.'
    )
  })

  it('records user and Remember edits and restores an older page as a new revision', () => {
    const userDataDirectory = wikiDirectory()
    const directory = join(userDataDirectory, 'daily-review', 'wiki')
    initializeKnowledgeStore(userDataDirectory)
    applyManagedKnowledgeUpdatesAt(directory, 'daily-review://day-1', 10, [
      {
        slug: 'projects/remember/wiki',
        title: 'Wiki',
        content: 'Automatic maintenance.',
        summary: 'Established automatic maintenance.',
        changeType: 'created',
      },
    ])
    const rememberPage = listKnowledgePagesAt(directory).find((page) => page.slug === 'projects/remember/wiki')
    assert.ok(rememberPage)
    saveKnowledgePageAt(directory, {
      spaceId: 'personal',
      slug: rememberPage.slug,
      title: rememberPage.title,
      content: 'Automatic maintenance with a Suggest option.',
      expectedRevision: rememberPage.revision,
    })

    const history = getKnowledgePageHistoryAt(directory, rememberPage.slug)
    assert.deepEqual(
      history.revisions.map(({ actor }) => actor),
      ['user', 'remember']
    )
    const rememberRevision = history.revisions.find((revision) => revision.actor === 'remember')
    assert.ok(rememberRevision)
    const current = listKnowledgePagesAt(directory).find((page) => page.slug === rememberPage.slug)
    assert.ok(current?.revision)
    restoreKnowledgePageRevisionAt(directory, {
      spaceId: 'personal',
      slug: rememberPage.slug,
      revisionId: rememberRevision.id,
      expectedRevision: current.revision,
    })

    const restoredHistory = getKnowledgePageHistoryAt(directory, rememberPage.slug)
    assert.equal(restoredHistory.revisions[0]?.operation, 'restored')
    assert.equal(restoredHistory.revisions[0]?.actor, 'user')
    assert.equal(
      listKnowledgePagesAt(directory)
        .find((page) => page.slug === rememberPage.slug)
        ?.content.includes('Automatic maintenance.'),
      true
    )
  })

  it('automatically keeps one current Personal Wiki entry per day source', () => {
    const userDataDirectory = wikiDirectory()
    initializeKnowledgeStore(userDataDirectory)
    const update = {
      slug: 'decisions/local-personal-memory',
      title: 'Local personal memory',
      content: '## Current state\n\nPersonal memory is automatic.',
      summary: 'Personal memory is automatic.',
      changeType: 'created' as const,
    }

    applyKnowledgeUpdates('day-1', Date.UTC(2026, 7, 10), [update])
    applyKnowledgeUpdates('day-1', Date.UTC(2026, 7, 10, 1), [
      {
        ...update,
        content: '## Current state\n\nPersonal memory is automatic and local.',
        summary: 'Personal memory is automatic and local.',
      },
    ])

    const path = join(userDataDirectory, 'daily-review', 'wiki', `${update.slug}.md`)
    const content = readFileSync(path, 'utf8')
    assert.equal(content.match(/daily-review:\/\/day-1/g)?.length, 1)
    assert.equal(content.match(/remember-managed:start/g)?.length, 1)
    assert.doesNotMatch(content, /Personal memory is automatic\.\n/)
    assert.match(content, /Personal memory is automatic and local\./)

    removeKnowledgeForSession('day-1')
    assert.equal(
      listKnowledgePagesAt(join(userDataDirectory, 'daily-review', 'wiki')).some((page) => page.slug === update.slug),
      false
    )
  })

  it('resets an aggregated managed region when deleting either Day or Timeline-item provenance', () => {
    const userDataDirectory = wikiDirectory()
    initializeKnowledgeStore(userDataDirectory)
    const directory = join(userDataDirectory, 'daily-review', 'wiki')
    const path = join(directory, 'projects', 'remember.md')
    mkdirSync(join(directory, 'projects'), { recursive: true })
    writeFileSync(
      path,
      `# Remember

Keep this human constraint.

<!-- remember-managed:start -->
Generated facts from multiple sources.
<!-- remember-managed:end -->

<!-- remember-source:daily-review://day-1/timeline/timeline:item-1 -->

<!-- remember-source:daily-review://day-2 -->
`
    )

    removeKnowledgeForSession('day-1')

    const content = readFileSync(path, 'utf8')
    assert.match(content, /Keep this human constraint\./)
    assert.doesNotMatch(content, /Generated facts|remember-managed|remember-source/)
  })

  it('does not add provenance or log noise for an unchanged managed page', () => {
    const userDataDirectory = wikiDirectory()
    initializeKnowledgeStore(userDataDirectory)
    const update = {
      slug: 'projects/remember',
      title: 'Remember',
      content: '## Current state\n\nThe product is ready.',
      summary: 'Recorded the current product state.',
      changeType: 'created' as const,
    }

    assert.equal(applyKnowledgeUpdates('day-1', Date.UTC(2026, 7, 10), [update]).length, 1)
    assert.equal(applyKnowledgeUpdates('day-2', Date.UTC(2026, 7, 11), [update]).length, 0)

    const directory = join(userDataDirectory, 'daily-review', 'wiki')
    const content = readFileSync(join(directory, 'projects/remember.md'), 'utf8')
    const log = readFileSync(join(directory, 'log.md'), 'utf8')
    assert.equal(content.match(/remember-source:/g)?.length, 1)
    assert.doesNotMatch(log, /daily-review:\/\/day-2/)
  })

  it('records non-Day imports without presenting them as Day-review sources', () => {
    const userDataDirectory = wikiDirectory()
    initializeKnowledgeStore(userDataDirectory)
    const sourceId = 'agent-import://bootstrap-1'

    applyManagedKnowledgeUpdates(sourceId, Date.UTC(2026, 7, 11), [
      {
        slug: 'projects/calling-research',
        title: 'Calling research',
        content: '## Current state\n\nThe project was imported.',
        summary: 'Imported the current project state.',
        changeType: 'created',
      },
    ])

    const directory = join(userDataDirectory, 'daily-review', 'wiki')
    assert.match(readFileSync(join(directory, 'projects/calling-research.md'), 'utf8'), /agent-import:\/\/bootstrap-1/)
    assert.match(readFileSync(join(directory, 'log.md'), 'utf8'), /_Bron: agent-import:\/\/bootstrap-1_/)
  })

  it('presents persistent Personal Wiki changes as structured Day history', () => {
    const userDataDirectory = wikiDirectory()
    initializeKnowledgeStore(userDataDirectory)
    const update = {
      slug: 'projects/remember/wiki',
      title: 'Wiki',
      content: '## Current state\n\nPrivate knowledge stays current.',
      summary: 'Private knowledge stays current.',
      changeType: 'updated' as const,
    }

    applyKnowledgeUpdates('day-1', Date.UTC(2026, 7, 18, 8, 0), [update])
    applyManagedKnowledgeUpdates(
      'daily-review://day-1/timeline/timeline:item-1',
      Date.UTC(2026, 7, 18, 9, 0),
      [{ ...update, content: '## Current state\n\nA selected Timeline item added more context.' }],
      'Tijdlijn'
    )

    assert.deepEqual(
      listPersonalWikiChanges().map((entry) => ({
        source: entry.source,
        dayId: entry.dayId,
        title: entry.changes[0]?.title,
        type: entry.changes[0]?.type,
      })),
      [
        { source: 'timeline', dayId: 'day-1', title: 'Wiki', type: 'updated' },
        { source: 'day', dayId: 'day-1', title: 'Wiki', type: 'created' },
      ]
    )
  })

  it('shows historical agent learning on its mutation Day without rewriting the log or evidence', () => {
    const userDataDirectory = wikiDirectory()
    initializeKnowledgeStore(userDataDirectory)
    const generatedAt = new Date(2026, 8, 23, 0, 15).getTime()
    const sourceId = 'agent-learning://historical-batch'
    const slug = 'projects/remember/wiki'
    const evidence = [{ sourceId: 'original-message', observedAt: generatedAt - 86_400_000, quote: 'Use pnpm.' }]
    applyManagedKnowledgeUpdates(sourceId, generatedAt, [
      { slug, title: 'Wiki', content: 'Use pnpm.', summary: 'Saved a constraint.', changeType: 'created', evidence },
    ])
    const directory = join(userDataDirectory, 'daily-review', 'wiki')
    const logPath = join(directory, 'log.md')
    const storedLog = readFileSync(logPath, 'utf8')
    assert.equal(listPersonalWikiChanges()[0]?.dayId, null)

    initializeKnowledgeStore(userDataDirectory)
    const changes = listPersonalWikiChanges([{ id: 'day-23', startedAt: new Date(2026, 8, 23, 9).getTime() }])

    assert.equal(changes[0]?.dayId, 'day-23')
    assert.equal(changes[0]?.timestamp, generatedAt)
    assert.equal(changes[0]?.sourceId, sourceId)
    assert.equal(readFileSync(logPath, 'utf8'), storedLog)
    assert.deepEqual(getKnowledgePageHistoryAt(directory, slug).revisions[0]?.evidence, evidence)
  })

  it('preserves human-authored content while replacing the current managed memory', () => {
    const userDataDirectory = wikiDirectory()
    initializeKnowledgeStore(userDataDirectory)
    const directory = join(userDataDirectory, 'daily-review', 'wiki')
    createKnowledgePageAt(directory, {
      spaceId: 'personal',
      category: 'projects',
      title: 'Calling research',
    })
    saveKnowledgePageAt(directory, {
      spaceId: 'personal',
      slug: 'projects/calling-research',
      title: 'Calling research',
      content: 'Keep this user-authored constraint.',
      expectedRevision: listKnowledgePagesAt(directory).find(
        (candidate) => candidate.slug === 'projects/calling-research'
      )?.revision,
    })

    applyKnowledgeUpdates('day-1', Date.UTC(2026, 7, 10), [
      {
        slug: 'projects/calling-research',
        title: 'Calling research',
        content: '## Remaining work\n\n- Validate the Mac capture route.',
        summary: 'Added the remaining validation.',
        changeType: 'updated',
      },
    ])
    applyKnowledgeUpdates('day-2', Date.UTC(2026, 7, 11), [
      {
        slug: 'projects/calling-research',
        title: 'Calling research',
        content: '## Current state\n\nThe Mac route is validated.',
        summary: 'Recorded the validation outcome.',
        changeType: 'updated',
      },
    ])

    const content = readFileSync(join(directory, 'projects/calling-research.md'), 'utf8')
    assert.match(content, /Keep this user-authored constraint\./)
    assert.doesNotMatch(content, /Validate the Mac capture route/)
    assert.match(content, /The Mac route is validated\./)
    assert.equal(content.match(/remember-managed:start/g)?.length, 1)
    assert.equal(content.match(/remember-source:daily-review:\/\//g)?.length, 2)
  })

  it('preserves managed ownership and sources through a rich-text edit', () => {
    const userDataDirectory = wikiDirectory()
    initializeKnowledgeStore(userDataDirectory)
    const directory = join(userDataDirectory, 'daily-review', 'wiki')

    applyKnowledgeUpdates('day-1', Date.UTC(2026, 7, 10), [
      {
        slug: 'projects/remember',
        title: 'Remember',
        content: '## Current state\n\nCapture is healthy.',
        summary: 'Recorded capture health.',
        changeType: 'created',
      },
    ])
    saveKnowledgePageAt(directory, {
      spaceId: 'personal',
      slug: 'projects/remember',
      title: 'Remember',
      content: '## Current state\n\nCapture is healthy.\n\n&nbsp;\n\nHuman note.',
      expectedRevision: listKnowledgePagesAt(directory).find((candidate) => candidate.slug === 'projects/remember')
        ?.revision,
    })

    const content = readFileSync(join(directory, 'projects/remember.md'), 'utf8')
    assert.equal(content.match(/remember-managed:start/g)?.length, 1)
    assert.equal(content.match(/remember-managed:end/g)?.length, 1)
    assert.equal(content.match(/remember-source:daily-review:\/\/day-1/g)?.length, 1)
    assert.doesNotMatch(content, /&nbsp;/)
    assert.match(content, /Human note\./)
  })

  it('gives a complete human edit to the next AI maintenance cycle and records the reconciliation', () => {
    const userDataDirectory = wikiDirectory()
    initializeKnowledgeStore(userDataDirectory)
    const directory = join(userDataDirectory, 'daily-review', 'wiki')

    applyKnowledgeUpdates('day-1', Date.UTC(2026, 7, 10), [
      {
        slug: 'projects/remember/wiki',
        title: 'Wiki',
        content: `## Direction\n\n${'AI maintained context. '.repeat(500)}\n\n## Remaining work\n\n- Validate cloud sync.`,
        summary: 'Established the Wiki direction.',
        changeType: 'created',
      },
    ])
    const generated = listKnowledgePagesAt(directory).find((page) => page.slug === 'projects/remember/wiki')
    assert.ok(generated?.revision)
    saveKnowledgePageAt(directory, {
      spaceId: 'personal',
      slug: generated.slug,
      title: generated.title,
      content: `${generated.content}\n\nHuman constraint: always show the complete proposal before acceptance.`,
      expectedRevision: generated.revision,
    })

    const edited = listKnowledgePagesAt(directory).find((page) => page.slug === generated.slug)
    assert.ok(edited)
    const [promptPage] = wikiPagesForPrompt(
      [
        {
          ...edited,
          spaceId: 'personal',
          spaceName: 'Personal',
          maintenanceMode: 'auto',
          editContext: getWikiPageAnalysisEditContext('personal', edited.slug),
        },
      ],
      80,
      240_000
    )
    assert.equal(promptPage?.rewriteAllowed, true)
    assert.match(promptPage?.content ?? '', /Human constraint: always show the complete proposal/)
    assert.match(promptPage?.editContext?.lastRememberRevision?.content ?? '', /Validate cloud sync/)

    applyKnowledgeUpdates('day-2', Date.now() + 1_000, [
      {
        slug: edited.slug,
        title: edited.title,
        content:
          '## Direction\n\nAI maintains the Wiki.\n\n## Constraints\n\n- Always show the complete proposal before acceptance.\n\n## Current state\n\nCloud sync validation remains open.',
        summary: 'Reconciled the human review constraint.',
        changeType: 'updated',
      },
    ])

    const reconciled = listKnowledgePagesAt(directory).find((page) => page.slug === edited.slug)
    assert.match(reconciled?.content ?? '', /Always show the complete proposal before acceptance/)
    assert.deepEqual(
      getKnowledgePageHistoryAt(directory, edited.slug).revisions.map((revision) => revision.actor),
      ['remember', 'user', 'remember']
    )
    assert.deepEqual(getWikiPageAnalysisEditContext('personal', edited.slug)?.changesSinceRemember, [])
  })

  it('keeps complete managed content beyond the former 3,000-character budget', () => {
    const userDataDirectory = wikiDirectory()
    initializeKnowledgeStore(userDataDirectory)
    const directory = join(userDataDirectory, 'daily-review', 'wiki')

    applyKnowledgeUpdates('day-1', Date.UTC(2026, 7, 10), [
      {
        slug: 'projects/remember',
        title: 'Remember',
        content: 'Stable memory.',
        summary: 'Recorded stable memory.',
        changeType: 'created',
      },
    ])
    const path = join(directory, 'projects/remember.md')
    const completeContent = `## Current state\n\n${'x'.repeat(3_500)}\n\n## Remaining work\n\nKeep this ending.`
    applyKnowledgeUpdates('day-2', Date.UTC(2026, 7, 11), [
      {
        slug: 'projects/remember',
        title: 'Remember',
        content: completeContent,
        summary: 'Keeps the complete durable page.',
        changeType: 'updated',
      },
    ])

    assert.match(readFileSync(path, 'utf8'), /Keep this ending\./)
  })

  it('strips reserved Remember markers from generated content before wrapping it', () => {
    const userDataDirectory = wikiDirectory()
    initializeKnowledgeStore(userDataDirectory)
    const directory = join(userDataDirectory, 'daily-review', 'wiki')
    const path = join(directory, 'projects/remember.md')

    applyKnowledgeUpdates('day-1', Date.UTC(2026, 7, 10), [
      {
        slug: 'projects/remember',
        title: 'Remember',
        content:
          '## Current state\n\n<!-- remember-managed:start -->\nThe Day is current.\n<!-- remember-managed:end -->\n<!-- remember-source:invented -->',
        summary: 'Updated the current Day state.',
        changeType: 'created',
      },
    ])
    applyKnowledgeUpdates('day-2', Date.UTC(2026, 7, 11), [
      {
        slug: 'projects/remember',
        title: 'Remember',
        content: '## Current state\n\nThe Day and Wiki are current.',
        summary: 'Updated the current product state.',
        changeType: 'updated',
      },
    ])

    const content = readFileSync(path, 'utf8')
    assert.equal(content.match(/remember-managed:start/g)?.length, 1)
    assert.equal(content.match(/remember-managed:end/g)?.length, 1)
    assert.doesNotMatch(content, /remember-source:invented/)
    assert.match(content, /The Day and Wiki are current\./)
  })

  it('repairs nested markers and removes legacy sourced Day-review sections on update', () => {
    const userDataDirectory = wikiDirectory()
    initializeKnowledgeStore(userDataDirectory)
    const directory = join(userDataDirectory, 'daily-review', 'wiki')
    const path = join(directory, 'projects/remember.md')
    mkdirSync(join(directory, 'projects'), { recursive: true })
    writeFileSync(
      path,
      `# Remember

Keep this human constraint.

## 2026-08-10 · Dagreview

Stale generated history.

<!-- remember-source:daily-review://old-day -->

<!-- remember-managed:start -->
Old generated state.
<!-- remember-managed:start -->
Nested generated state.
<!-- remember-managed:end -->
<!-- remember-managed:end -->
`
    )

    applyKnowledgeUpdates('new-day', Date.UTC(2026, 7, 12), [
      {
        slug: 'projects/remember',
        title: 'Remember',
        content: '## Current state\n\nOnly the reconciled state remains.',
        summary: 'Reconciled the current state.',
        changeType: 'updated',
      },
    ])

    const content = readFileSync(path, 'utf8')
    assert.match(content, /Keep this human constraint\./)
    assert.doesNotMatch(content, /Stale generated history|Old generated state|Nested generated state/)
    assert.equal(content.match(/remember-managed:start/g)?.length, 1)
    assert.equal(content.match(/remember-managed:end/g)?.length, 1)
  })

  it('treats content behind an unmatched managed marker as user-owned', () => {
    const userDataDirectory = wikiDirectory()
    initializeKnowledgeStore(userDataDirectory)
    const directory = join(userDataDirectory, 'daily-review', 'wiki')
    const path = join(directory, 'projects/remember.md')
    mkdirSync(join(directory, 'projects'), { recursive: true })
    writeFileSync(
      path,
      `# Remember

Keep this human constraint.

<!-- remember-managed:start -->
This annotation was written after a malformed marker.
`
    )

    applyKnowledgeUpdates('new-day', Date.UTC(2026, 7, 12), [
      {
        slug: 'projects/remember',
        title: 'Remember',
        content: '## Current state\n\nRemember reconciled the current state.',
        summary: 'Reconciled the current state.',
        changeType: 'updated',
      },
    ])

    const content = readFileSync(path, 'utf8')
    assert.match(content, /Keep this human constraint\./)
    assert.match(content, /This annotation was written after a malformed marker\./)
    assert.equal(content.match(/remember-managed:start/g)?.length, 1)
    assert.equal(content.match(/remember-managed:end/g)?.length, 1)
  })

  it('creates direct subpages beneath any existing Wiki page', () => {
    const directory = wikiDirectory()
    createKnowledgePageAt(directory, {
      spaceId: 'personal',
      category: 'projects',
      title: 'Remember',
    })
    const pages = createKnowledgePageAt(directory, {
      spaceId: 'personal',
      category: 'projects',
      parentSlug: 'projects/remember',
      title: 'Wiki',
    })

    assert.ok(pages.some((page) => page.slug === 'projects/remember/wiki'))
    const index = readFileSync(join(directory, 'index.md'), 'utf8')
    assert.match(index, /- \[Remember\]\(\.\/projects\/remember\.md\)/)
    assert.match(index, / {2}- \[Wiki\]\(\.\/projects\/remember\/wiki\.md\)/)
  })

  it('reconciles a duplicate creation into the existing page for the same subject', () => {
    const directory = wikiDirectory()
    const existing = {
      slug: 'projects/remember/transcription',
      title: 'Cloud Transcription',
      content:
        '## Direction\n\nCloud transcription runs only for accepted conversation episodes and must receive the retained conversation audio so provider quality improves.\n\n## Remaining work\n\n- Run the provider bake-off with Dutch conversations and select a provider.',
      summary: 'Captured the cloud transcription direction.',
      changeType: 'created' as const,
    }
    const duplicate = {
      slug: 'projects/remember/conversation-transcription',
      title: 'Conversation Transcription',
      content:
        '## Direction\n\nImprove conversation quality through batch cloud transcription for accepted conversation episodes, using the retained conversation audio.\n\n## Decisions\n\n- Keep accepted episode audio in an encrypted temporary spool.\n\n## Remaining work\n\n- Run the provider bake-off with Dutch conversations, evaluate provider quality, and select a provider.',
      summary: 'Reconciled the conversation transcription direction.',
      changeType: 'created' as const,
    }

    applyManagedKnowledgeUpdatesAt(directory, 'daily-review://day-1', Date.UTC(2026, 7, 25), [existing])
    const applied = applyManagedKnowledgeUpdatesAt(directory, 'daily-review://day-2', Date.UTC(2026, 7, 26), [
      duplicate,
    ])

    assert.equal(applied.length, 1)
    assert.equal(applied[0]?.slug, existing.slug)
    assert.equal(applied[0]?.changeType, 'updated')
    assert.equal(existsSync(join(directory, `${duplicate.slug}.md`)), false)
    const content = readFileSync(join(directory, `${existing.slug}.md`), 'utf8')
    assert.match(content, /encrypted temporary spool/)
    assert.match(content, /daily-review:\/\/day-1/)
    assert.match(content, /daily-review:\/\/day-2/)
    assert.match(
      readFileSync(join(directory, 'log.md'), 'utf8'),
      /herleid naar bestaande pagina: projects\/remember\/conversation-transcription → projects\/remember\/transcription/
    )
  })

  it('collapses same-subject pages created in one batch into the richer page', () => {
    const directory = wikiDirectory()
    const thin = {
      slug: 'projects/remember/transcription',
      title: 'Cloud Transcription',
      content:
        '## Direction\n\nCloud transcription runs only for accepted conversation episodes and must receive the retained conversation audio so provider quality improves.\n\n## Remaining work\n\n- Run the provider bake-off with Dutch conversations and select a provider.',
      summary: 'Captured the cloud transcription direction.',
      changeType: 'created' as const,
    }
    const rich = {
      slug: 'projects/remember/conversation-transcription',
      title: 'Conversation Transcription',
      content:
        '## Direction\n\nImprove conversation quality through batch cloud transcription for accepted conversation episodes, using the retained conversation audio.\n\n## Decisions\n\n- Keep accepted episode audio in an encrypted temporary spool.\n\n## Remaining work\n\n- Run the provider bake-off with Dutch conversations, evaluate provider quality, and select a provider.',
      summary: 'Reconciled the conversation transcription direction.',
      changeType: 'created' as const,
    }

    const applied = applyManagedKnowledgeUpdatesAt(directory, 'daily-review://day-1', Date.UTC(2026, 7, 25), [
      thin,
      rich,
    ])

    assert.equal(applied.length, 1)
    assert.equal(applied[0]?.slug, rich.slug)
    assert.equal(applied[0]?.changeType, 'created')
    assert.equal(existsSync(join(directory, `${thin.slug}.md`)), false)
    assert.match(
      readFileSync(join(directory, 'log.md'), 'utf8'),
      /samengevoegd: projects\/remember\/transcription → projects\/remember\/conversation-transcription/
    )
  })
})
