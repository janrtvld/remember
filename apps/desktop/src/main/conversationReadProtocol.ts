type RecordValue = Record<string, unknown>
type Archive = (args: string[], signal: AbortSignal) => Promise<unknown>

/** Bounded public reads over the same visible archive used by Remember's assistant. */
export function createConversationReader(dependencies: {
  archive: Archive
  dates: () => string[]
  now?: () => number
}) {
  return async (raw: unknown, signal: AbortSignal) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid-conversation-request')
    const input = raw as RecordValue
    const view = input.view ?? 'list'
    const allowed = view === 'list' ? ['view', 'date', 'offset', 'limit'] : ['view', 'date', 'id', 'revision', 'offset']
    if (!['list', 'transcript'].includes(String(view)) || Object.keys(input).some((key) => !allowed.includes(key)))
      throw new Error('invalid-conversation-request')
    const date = input.date
    if (
      date !== undefined &&
      (typeof date !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isFinite(Date.parse(`${date}T12:00:00Z`)) ||
        new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date)
    )
      throw new Error('invalid-conversation-date')
    const offset = input.offset ?? 0
    const limit = input.limit ?? 5
    if (
      !Number.isSafeInteger(offset) ||
      Number(offset) < 0 ||
      !Number.isSafeInteger(limit) ||
      Number(limit) < 1 ||
      Number(limit) > 20
    )
      throw new Error('invalid-conversation-pagination')
    if (
      view === 'transcript' &&
      (typeof date !== 'string' ||
        typeof input.id !== 'string' ||
        !input.id ||
        typeof input.revision !== 'string' ||
        !input.revision)
    )
      throw new Error('conversation-identity-required')

    const dates = date ? [String(date)] : [...new Set(dependencies.dates())].sort().reverse()
    const rows: RecordValue[] = []
    let dataDirectory: unknown = null
    let timezone: unknown = null
    for (const selected of dates) {
      let pageOffset: number | null = 0
      const dayRows: RecordValue[] = []
      while (pageOffset !== null) {
        signal.throwIfAborted()
        const page = (await dependencies.archive(
          ['conversations', selected, '--page', '--limit', '200', '--offset', String(pageOffset)],
          signal
        )) as {
          items: RecordValue[]
          nextOffset: number | null
          dataDirectory: string
          timezone: string
        }
        if (dataDirectory !== null && dataDirectory !== page.dataDirectory)
          throw new Error('conversation-profile-changed')
        dataDirectory = page.dataDirectory
        timezone = page.timezone
        dayRows.push(...page.items)
        pageOffset = page.nextOffset
      }
      rows.push(...dayRows.reverse())
      if (view === 'list' && rows.length > Number(offset) + Number(limit)) break
    }
    signal.throwIfAborted()
    const common = {
      schemaVersion: 1,
      dataDirectory,
      timezone,
      observedAt: (dependencies.now ?? Date.now)(),
      sourceKind: 'remember-conversations',
      dateBasis: 'archive-day',
      coverage: { localAudioEpisodes: true, importedConversations: true, visibleRecordsOnly: true },
    }
    if (view === 'transcript') {
      const record = rows.find((row) => row.id === input.id)
      if (!record) return { ...common, availability: 'not_found', record: null }
      if (record.revision !== input.revision) throw new Error('conversation-revision-conflict-list-again')
      const text = Array.from(String(record.text ?? ''))
      const end = Math.min(Number(offset) + 6000, text.length)
      return {
        ...common,
        availability: record.transcriptAvailable ? 'available' : 'transcript_unavailable',
        sourceRef: record.sourceRef,
        revision: record.revision,
        date: record.date,
        savedTitle: typeof record.savedTitle === 'string' ? record.savedTitle.slice(0, 500) : undefined,
        offset,
        nextOffset: end < text.length ? end : null,
        totalCharacters: text.length,
        text: text.slice(Number(offset), end).join(''),
        evidenceKind: 'recorded-transcript',
      }
    }
    const page = rows.slice(Number(offset), Number(offset) + Number(limit)).map((row) => ({
      id: row.id,
      sourceRef: row.sourceRef,
      revision: row.revision,
      date: row.date,
      actualDate: row.actualDate,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      source: row.source,
      savedTitle: String(row.savedTitle ?? (row.analysis as RecordValue | undefined)?.title ?? '').slice(0, 500),
      transcriptAvailable: row.transcriptAvailable,
      excerpt: Array.from(String(row.text ?? ''))
        .slice(0, 240)
        .join(''),
      excerptTruncated: Array.from(String(row.text ?? '')).length > 240,
    }))
    const nextOffset = Number(offset) + page.length
    return {
      ...common,
      availability: 'available',
      order: 'newest-first',
      offset,
      limit,
      nextOffset: nextOffset < rows.length ? nextOffset : null,
      items: page,
      meaning:
        'Visible conversation records, including imported originals. Excerpts are not full transcripts. Raw audio-chunk counts are not conversation counts.',
    }
  }
}
