import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ConversationSummary } from '@remember/shared'
import { createResidentConversationArchive } from '../residentConversationArchive'

const archiveDay = '2026-09-29'
const actualStart = Date.parse('2026-09-29T23:00:50.945Z')
const dayStart = Date.parse('2026-09-29T08:00:00Z')
type Options = Parameters<typeof createResidentConversationArchive>[0]
type Page = { count: number; items: Array<Record<string, unknown>>; nextOffset: number | null; [key: string]: unknown }

function fixture() {
  const imported: ConversationSummary = {
    episodeId: 'canonical-episode',
    externalId: 'import-1',
    source: 'revinote',
    startTime: '01:00',
    endTime: '01:20',
    title: 'Saved workshop discussion',
    description: 'Original recorded discussion',
  }
  let sessions: ReturnType<Options['readSessions']> = [
    {
      id: 'stored-workday',
      localDay: archiveDay,
      startedAt: dayStart,
      memory: { conversations: [imported], deletedConversationWindows: [] },
    },
  ]
  let imports: unknown = {
    version: 1,
    meetings: {
      'import-1': {
        id: 'import-1',
        status: 'finished',
        title: 'Saved workshop discussion',
        date: '2026-09-29T23:00:50.945Z',
        updatedAt: '2026-09-30T00:00:00Z',
        participants: ['Speaker A', 'Speaker B'],
        summary: 'Generated overview',
        transcript: 'Speaker A: We discussed a personal workshop project.\nSpeaker B: The notes should remain private.',
        durationSeconds: 1200,
        actionItems: [],
      },
    },
  }
  const calls: string[][] = []
  let rows: Array<Record<string, unknown>> = []
  let onRun: (() => void | Promise<void>) | undefined
  let importedError = false
  const runCLI: Options['runCLI'] = async (args) => {
    calls.push(args)
    if (args[0] === 'status') return { dataDirectory: '/synthetic/profile/daily-review' }
    await onRun?.()
    if (args[0] !== 'conversations') return { passthrough: true }
    return {
      schemaVersion: 1,
      availability: 'available',
      sourceKind: 'local-audio-episodes',
      selector: args[1],
      dataDirectory: '/synthetic/profile/daily-review',
      timezone: 'Europe/Amsterdam',
      count: rows.length,
      offset: 0,
      nextOffset: null,
      items: rows,
    }
  }
  const run = createResidentConversationArchive({
    runCLI,
    readSessions: () => sessions,
    readImported: () => {
      if (importedError) throw new Error('unreadable file')
      return imports
    },
    assertCurrent: () => {},
    timeZone: 'Europe/Amsterdam',
  })
  const read = (date = archiveDay, offset = 0, limit = 20) =>
    run(
      ['conversations', date, '--page', '--limit', String(limit), '--offset', String(offset)],
      new AbortController().signal
    ) as Promise<Page>
  return {
    read,
    run,
    calls,
    imported,
    get sessions() {
      return sessions
    },
    set sessions(value) {
      sessions = value
    },
    importSnapshot() {
      return imports as { version: number; meetings: Record<string, Record<string, unknown>> }
    },
    setImports(value: unknown) {
      imports = value
    },
    set rows(value: Array<Record<string, unknown>>) {
      rows = value
    },
    set onRun(value: (() => void | Promise<void>) | undefined) {
      onRun = value
    },
    set importedError(value: boolean) {
      importedError = value
    },
  }
}

function localSummary(id = 'local-1'): ConversationSummary {
  return { episodeId: id, startTime: '12:00', endTime: '12:05', title: 'Local discussion', description: '' }
}

function localRecord(id = 'local-1') {
  return {
    id,
    dayId: 'stored-workday',
    date: '2026-09-30',
    startedAt: actualStart + 3600_000,
    endedAt: actualStart + 3900_000,
    acceptance: 'classified',
    revision: `revision-${id}`,
    text: 'Exact local transcript.',
  }
}

describe('resident visible conversation archive', () => {
  it('requires a verified profile before reading imported or visible conversation data', async () => {
    let reads = 0
    const run = createResidentConversationArchive({
      runCLI: async () => ({}),
      readSessions: () => {
        reads++
        return []
      },
      readImported: () => {
        reads++
        return null
      },
      assertCurrent: () => {},
      timeZone: 'Europe/Amsterdam',
    })
    await assert.rejects(
      run(['conversations', archiveDay, '--page'], new AbortController().signal),
      /profile-unavailable/
    )
    assert.equal(reads, 0)
  })

  it('keeps the saved archive day separate from the actual imported timestamp and current timezone', async () => {
    const f = fixture()
    const page = await f.read()
    assert.equal(page.count, 1)
    assert.equal(page.sourceKind, 'remember-conversations')
    assert.equal(page.dateBasis, 'archive-day')
    assert.deepEqual(page.coverage, { localAudioEpisodes: true, importedConversations: true })
    const [item] = page.items
    assert.equal(item.id, 'revinote:import-1')
    assert.equal(item.date, archiveDay)
    assert.equal(item.actualDate, '2026-09-30')
    assert.equal(item.startedAt, actualStart)
    assert.equal(item.endedAt, actualStart + 1200_000)
    assert.equal(item.acceptance, 'imported')
    assert.equal(item.savedTitle, 'Saved workshop discussion')
    assert.equal(item.text, f.importSnapshot().meetings['import-1'].transcript)
    assert.match(String(item.revision), /^[a-f0-9]{64}$/)
    assert.deepEqual(f.calls, [['status']])
    assert.equal((await f.read('2026-09-30')).count, 0)
  })

  it('resolves visible local records by exact stored workday ID without changing their real time', async () => {
    const f = fixture()
    f.sessions = [{ ...f.sessions[0], memory: { conversations: [localSummary()] } }]
    f.rows = [localRecord(), localRecord('not-visible')]
    const page = await f.read()
    assert.equal(page.count, 1)
    assert.equal(page.items[0].id, 'local-1')
    assert.equal(page.items[0].date, archiveDay)
    assert.equal(page.items[0].dateBasis, 'archive-day')
    assert.equal(page.items[0].actualDate, '2026-09-30')
    assert.equal(page.items[0].startedAt, actualStart + 3600_000)
    assert.deepEqual(f.calls[1], ['conversations', 'stored-workday', '--page', '--limit', '200', '--offset', '0'])
  })

  it('uses existing imported-record suppression before exposing duplicate local fragments', async () => {
    const f = fixture()
    const duplicate = { ...localSummary('canonical-episode'), startTime: '01:02', endTime: '01:06' }
    f.sessions = [{ ...f.sessions[0], memory: { conversations: [duplicate, f.imported] } }]
    const page = await f.read()
    assert.deepEqual(
      page.items.map((row) => row.id),
      ['revinote:import-1']
    )
    assert.deepEqual(f.calls, [['status']])
  })

  it('never treats a missing, unreadable or malformed required import as zero conversations', async () => {
    for (const value of [null, {}, { version: 1, meetings: {} }, { version: 2, meetings: {} }]) {
      const f = fixture()
      f.setImports(value)
      await assert.rejects(f.read(), /import.*unavailable/)
    }
    const unreadable = fixture()
    unreadable.importedError = true
    await assert.rejects(unreadable.read(), /imports-unavailable/)
  })

  it('requires the exact current finished original with valid timestamps and transcript type', async () => {
    for (const patch of [
      { id: 'different' },
      { status: 'processed' },
      { date: 'not-date' },
      { updatedAt: 'invalid' },
      { transcript: {} },
    ]) {
      const f = fixture()
      Object.assign(f.importSnapshot().meetings['import-1'], patch)
      await assert.rejects(f.read(), /import-unavailable/)
    }
  })

  it('keeps unavailable transcript content explicit without substituting generated summaries', async () => {
    const f = fixture()
    f.importSnapshot().meetings['import-1'].transcript = null
    const [item] = (await f.read()).items
    assert.equal(item.text, '')
    assert.equal(item.transcriptAvailable, false)
    assert.equal(JSON.stringify(item).includes('Generated overview'), false)
  })

  it('excludes deleted imported visibility before reading the original snapshot', async () => {
    const f = fixture()
    f.sessions = [
      {
        ...f.sessions[0],
        memory: {
          conversations: [f.imported],
          deletedConversationWindows: [
            {
              externalId: 'import-1',
              startTime: f.imported.startTime,
              endTime: f.imported.endTime,
            },
          ],
        },
      },
    ]
    f.importedError = true
    assert.equal((await f.read()).count, 0)
    const source = await f.run(['source', 'read', 'conversation', 'revinote:import-1'], new AbortController().signal)
    assert.deepEqual(source, { kind: 'conversation', id: 'revinote:import-1', availability: 'not_found', record: null })
  })

  it('rejects a changed visible record or original while the local source read is awaited', async () => {
    for (const mutation of ['visibility', 'import']) {
      const f = fixture()
      f.sessions = [{ ...f.sessions[0], memory: { conversations: [f.imported, localSummary()] } }]
      f.rows = [localRecord()]
      f.onRun = () => {
        if (mutation === 'visibility') f.sessions = []
        else f.importSnapshot().meetings['import-1'].transcript = 'Changed after await.'
      }
      await assert.rejects(f.read(), /visibility-changed|import-changed/)
    }
  })

  it('keeps exact imported revisions stable and changes them with the original', async () => {
    const f = fixture()
    const first = (await f.read()).items[0]
    assert.equal((await f.read()).items[0].revision, first.revision)
    f.importSnapshot().meetings['import-1'].transcript = 'A corrected original transcript.'
    const changed = (await f.read()).items[0]
    assert.notEqual(changed.revision, first.revision)
    assert.equal(changed.text, 'A corrected original transcript.')
  })

  it('pages the combined visible archive and reads the same imported source identity', async () => {
    const f = fixture()
    f.sessions = [{ ...f.sessions[0], memory: { conversations: [f.imported, localSummary()] } }]
    f.rows = [localRecord()]
    const first = await f.read(archiveDay, 0, 1)
    assert.equal(first.count, 2)
    assert.equal(first.nextOffset, 1)
    assert.equal(first.items[0].id, 'revinote:import-1')
    const second = await f.read(archiveDay, 1, 1)
    assert.equal(second.nextOffset, null)
    assert.equal(second.items[0].id, 'local-1')
    const source = (await f.run(
      ['source', 'read', 'conversation', 'revinote:import-1'],
      new AbortController().signal
    )) as Record<string, unknown>
    assert.deepEqual(source.record, first.items[0])
  })

  it('refuses unavailable visible local sources and invalid pagination rather than inventing coverage', async () => {
    const f = fixture()
    f.sessions = [{ ...f.sessions[0], memory: { conversations: [localSummary()] } }]
    await assert.rejects(f.read(), /visible-local-source-unavailable/)
    await assert.rejects(f.read('2026-02-30'), /invalid-date/)
    await assert.rejects(f.read(archiveDay, -1), /invalid-pagination/)
    await assert.rejects(f.read(archiveDay, 0, 0), /invalid-pagination/)
  })
})
