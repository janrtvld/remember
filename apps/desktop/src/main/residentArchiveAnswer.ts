import { createHash } from 'node:crypto'

export type ArchiveConversationRecord = {
  id: string
  dayId: string
  date: string
  startedAt: number
  endedAt: number
  acceptance: 'classified' | 'confirmed' | 'recorded' | 'imported'
  dateBasis?: 'archive-day' | 'local-calendar'
  savedTitle?: string
  revision: string
  transcript: string
}

export type ArchiveConversationPage = {
  sourceKind?: 'local-audio-episodes' | 'remember-conversations'
  date: string
  timeZone: string
  total: number
  offset: number
  nextOffset: number | null
  entries: ArchiveConversationRecord[]
}

export type ArchiveConversationSnapshot = {
  sourceKind?: 'local-audio-episodes' | 'remember-conversations'
  date: string
  timeZone: string
  total: number
  complete: true
  entries: ArchiveConversationRecord[]
}

type Selection = { id: string; quote: string }
type Collected = { snapshot: ArchiveConversationSnapshot; at: number; nextOffset: number | null }

function fail(reason: string): never {
  throw new Error(`remember-answer-${reason}`)
}

function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function validDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T12:00:00Z`)) &&
    new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value
  )
}

function nonempty(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !value.includes('\0')
}

function sourceKind(value: unknown) {
  if (value === undefined) return 'local-audio-episodes' as const
  if (value !== 'local-audio-episodes' && value !== 'remember-conversations') fail('invalid-source-kind')
  return value
}

function localDate(timestamp: number, timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(timestamp)
}

function canonicalRecord(record: ArchiveConversationRecord, date: string, timeZone: string) {
  if (
    !record ||
    !nonempty(record.id, 300) ||
    !nonempty(record.dayId, 300) ||
    record.date !== date ||
    !Number.isSafeInteger(record.startedAt) ||
    !Number.isSafeInteger(record.endedAt) ||
    record.startedAt < 0 ||
    record.endedAt < record.startedAt ||
    !['classified', 'confirmed', 'recorded', 'imported'].includes(record.acceptance) ||
    (record.dateBasis !== undefined && !['archive-day', 'local-calendar'].includes(record.dateBasis)) ||
    (record.savedTitle !== undefined && (record.acceptance !== 'imported' || !nonempty(record.savedTitle, 500))) ||
    !nonempty(record.revision, 2_000) ||
    typeof record.transcript !== 'string' ||
    record.transcript.length > 500_000
  )
    fail('invalid-record')
  const dateBasis = record.dateBasis ?? 'local-calendar'
  if (dateBasis === 'local-calendar' && localDate(record.startedAt, timeZone) !== date) fail('record-date-mismatch')
  return {
    id: record.id,
    dayId: record.dayId,
    date: record.date,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    acceptance: record.acceptance,
    dateBasis,
    ...(record.savedTitle === undefined ? {} : { savedTitle: record.savedTitle }),
    revision: record.revision,
    transcript: record.transcript,
  }
}

function canonicalSnapshot(input: ArchiveConversationSnapshot): ArchiveConversationSnapshot {
  if (
    !input ||
    !validDate(input.date) ||
    !nonempty(input.timeZone, 100) ||
    !Number.isSafeInteger(input.total) ||
    input.total < 0 ||
    input.total > 10_000 ||
    input.complete !== true ||
    !Array.isArray(input.entries) ||
    input.entries.length !== input.total
  )
    fail('invalid-snapshot')
  try {
    new Intl.DateTimeFormat('en', { timeZone: input.timeZone })
  } catch {
    fail('invalid-timezone')
  }
  const entries = input.entries.map((entry) => canonicalRecord(entry, input.date, input.timeZone))
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) fail('duplicate-record')
  const kind = sourceKind(input.sourceKind)
  if (kind === 'local-audio-episodes' && entries.some((entry) => entry.acceptance === 'imported'))
    fail('source-kind-mismatch')
  return {
    sourceKind: kind,
    date: input.date,
    timeZone: input.timeZone,
    total: input.total,
    complete: true,
    entries,
  }
}

function escapedQuote(quote: string) {
  return quote
    .replace(/\s+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_{}[\]()!#|]/g, '\\$&')
}

function render(
  snapshot: ArchiveConversationSnapshot,
  selections: Selection[],
  locale: 'nl' | 'en',
  includeTimes: boolean
) {
  const nl = locale === 'nl'
  const date = new Intl.DateTimeFormat(nl ? 'nl-NL' : 'en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(`${snapshot.date}T12:00:00Z`))
  if (!snapshot.total && snapshot.sourceKind === 'remember-conversations')
    return nl
      ? `Ik vind onder ${date} geen opgeslagen gesprekken of gespreksfragmenten in Remember.`
      : `I found no saved conversations or conversation fragments under ${date} in Remember.`
  if (!snapshot.total)
    return nl
      ? `Ik vind in het lokale audioarchief geen gespreksfragmenten voor ${date}. Geïmporteerde gesprekken zijn hierin niet meegenomen.`
      : `I found no conversation fragments in the local audio archive for ${date}. Imported conversations are not included in this search.`
  const single = snapshot.entries[0]
  const selected = selections[0]
  if (
    !includeTimes &&
    snapshot.total === 1 &&
    selections.length === 1 &&
    single?.acceptance === 'imported' &&
    single.savedTitle &&
    selected?.id === single.id
  ) {
    const title = escapedQuote(single.savedTitle)
    const quote = escapedQuote(selected.quote)
    return nl
      ? `Voor ${date} staat één gesprek opgeslagen: **${title}**.\n\nUit het transcript: “${quote}”`
      : `For ${date}, one conversation is saved: **${title}**.\n\nFrom the transcript: “${quote}”`
  }
  const importedCount = snapshot.entries.filter((entry) => entry.acceptance === 'imported').length
  const localCount = snapshot.total - importedCount
  const counts: string[] = []
  if (importedCount)
    counts.push(
      nl
        ? `${importedCount} opgeslagen ${importedCount === 1 ? 'gesprek' : 'gesprekken'}`
        : `${importedCount} saved ${importedCount === 1 ? 'conversation' : 'conversations'}`
    )
  if (localCount)
    counts.push(
      nl
        ? `${localCount} ${localCount === 1 ? 'lokaal gespreksfragment' : 'lokale gespreksfragmenten'}`
        : `${localCount} local conversation ${localCount === 1 ? 'fragment' : 'fragments'}`
    )
  const introduction = nl
    ? `Ik vind onder ${date} ${counts.join(' en ')} in Remember.`
    : `Remember has ${counts.join(' and ')} under ${date}.`
  if (!selections.length)
    return nl
      ? `${introduction} De transcriptie is niet beschikbaar, dus ik kan de inhoud niet controleren.`
      : `${introduction} The transcript is unavailable, so I cannot check what was discussed.`
  const time = new Intl.DateTimeFormat(nl ? 'nl-NL' : 'en-GB', {
    timeZone: snapshot.timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  const lines = selections.map(({ id, quote }) => {
    const record = snapshot.entries.find((entry) => entry.id === id)
    if (!record) fail('source-not-retrieved')
    let acceptance =
      record.acceptance === 'imported'
        ? nl
          ? 'opgeslagen gesprek'
          : 'saved conversation'
        : record.acceptance === 'confirmed'
          ? nl
            ? 'door jou bevestigd'
            : 'confirmed by you'
          : record.acceptance === 'recorded'
            ? nl
              ? 'handmatig opgenomen'
              : 'manually recorded'
            : nl
              ? 'als gesprek herkend'
              : 'classified as a conversation'
    if (!includeTimes) {
      if (record.savedTitle) {
        const titleLabel = nl ? 'opgeslagen titel' : 'saved title'
        return `- **${escapedQuote(record.savedTitle)}** (${titleLabel})\n  “${escapedQuote(quote)}”`
      }
      return `- ${acceptance}: “${escapedQuote(quote)}”`
    }
    if (record.savedTitle)
      acceptance += nl
        ? `; opgeslagen titel: “${escapedQuote(record.savedTitle)}”`
        : `; saved title: “${escapedQuote(record.savedTitle)}”`
    const zone = new Intl.DateTimeFormat(nl ? 'nl-NL' : 'en-GB', {
      timeZone: snapshot.timeZone,
      timeZoneName: 'short',
    })
      .formatToParts(record.startedAt)
      .find((part) => part.type === 'timeZoneName')?.value
    const startedOn = localDate(record.startedAt, snapshot.timeZone)
    const endedOn = localDate(record.endedAt, snapshot.timeZone)
    const fullTime = new Intl.DateTimeFormat(nl ? 'nl-NL' : 'en-GB', {
      timeZone: snapshot.timeZone,
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
    const start = startedOn === snapshot.date ? time.format(record.startedAt) : fullTime.format(record.startedAt)
    const end = endedOn === startedOn ? time.format(record.endedAt) : fullTime.format(record.endedAt)
    return `- ${start}–${end} ${zone ?? snapshot.timeZone} (${acceptance}): “${escapedQuote(quote)}”`
  })
  const partial =
    selections.length < snapshot.total
      ? nl
        ? ` Hieronder ${selections.length} daarvan.`
        : ` Showing ${selections.length} of them below.`
      : ''
  return `${introduction}${partial}\n\n${lines.join('\n')}`
}

export function createResidentArchiveAnswer(dependencies: {
  locale: 'nl' | 'en'
  assertCurrent: () => void
  revalidate: (date: string, signal: AbortSignal) => Promise<ArchiveConversationSnapshot>
  now?: () => number
  ttlMs?: number
  timeoutMs?: number
  includeTimes?: boolean
}) {
  const collected = new Map<string, Collected>()
  const now = dependencies.now ?? Date.now
  const ttlMs = dependencies.ttlMs ?? 180_000
  const timeoutMs = dependencies.timeoutMs ?? 10_000
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    fail('invalid-deadline')

  function guard(signal?: AbortSignal) {
    if (signal?.aborted) fail('cancelled')
    dependencies.assertCurrent()
  }

  function fresh(entry: Collected) {
    const age = now() - entry.at
    if (age < 0 || age > ttlMs) fail('expired')
  }

  async function revalidate(date: string, signal: AbortSignal) {
    guard(signal)
    const controller = new AbortController()
    return new Promise<ArchiveConversationSnapshot>((resolve, reject) => {
      let settled = false
      const finish = (error: Error | null, result?: ArchiveConversationSnapshot) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', aborted)
        if (error) reject(error)
        else if (result) resolve(result)
        else reject(new Error('remember-answer-invalid-snapshot'))
      }
      const aborted = () => {
        finish(new Error('remember-answer-cancelled'))
        controller.abort()
      }
      const timer = setTimeout(() => {
        finish(new Error('remember-answer-timeout'))
        controller.abort()
      }, timeoutMs)
      signal.addEventListener('abort', aborted, { once: true })
      if (signal.aborted) {
        aborted()
        return
      }
      try {
        Promise.resolve(dependencies.revalidate(date, controller.signal)).then(
          (result) => finish(null, result),
          (error: unknown) => finish(error instanceof Error ? error : new Error(String(error)))
        )
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  return {
    recordPage(input: ArchiveConversationPage) {
      guard()
      if (
        !input ||
        !validDate(input.date) ||
        !Array.isArray(input.entries) ||
        !Number.isSafeInteger(input.offset) ||
        input.offset < 0 ||
        !Number.isSafeInteger(input.total) ||
        input.total < 0 ||
        input.total > 10_000 ||
        input.entries.length > 200 ||
        input.offset + input.entries.length > input.total ||
        input.nextOffset !==
          (input.offset + input.entries.length < input.total ? input.offset + input.entries.length : null) ||
        (input.nextOffset !== null && !input.entries.length)
      )
        fail('invalid-page')
      const previous = collected.get(input.date)
      if (
        previous &&
        (previous.nextOffset !== input.offset ||
          previous.snapshot.total !== input.total ||
          previous.snapshot.timeZone !== input.timeZone ||
          previous.snapshot.sourceKind !== sourceKind(input.sourceKind))
      )
        fail('page-sequence-mismatch')
      if (!previous && input.offset !== 0) fail('page-sequence-mismatch')
      if (!previous && collected.size >= 8) fail('too-many-dates')
      if (previous) fresh(previous)
      const entries = [...(previous?.snapshot.entries ?? []), ...structuredClone(input.entries)]
      const snapshot = canonicalSnapshot({ ...input, complete: true, total: entries.length, entries })
      snapshot.total = input.total
      collected.set(input.date, { snapshot, nextOffset: input.nextOffset, at: previous?.at ?? now() })
    },

    async answer(raw: unknown, signal: AbortSignal) {
      guard(signal)
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('invalid-selection')
      const input = raw as Record<string, unknown>
      if (
        Object.keys(input).some((key) => !['date', 'selections'].includes(key)) ||
        !validDate(input.date) ||
        !Array.isArray(input.selections) ||
        input.selections.length > 5
      )
        fail('invalid-selection')
      const selections: Selection[] = input.selections.map((value: unknown) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-selection')
        const selection = value as Record<string, unknown>
        if (
          Object.keys(selection).some((key) => !['id', 'quote'].includes(key)) ||
          !nonempty(selection.id, 300) ||
          !nonempty(selection.quote, 600) ||
          !selection.quote.trim()
        )
          fail('invalid-selection')
        return { id: selection.id, quote: selection.quote }
      })
      if (new Set(selections.map((entry) => entry.id)).size !== selections.length) fail('duplicate-selection')
      const entry = collected.get(input.date)
      if (!entry || entry.nextOffset !== null) fail('retrieval-incomplete')
      fresh(entry)
      const snapshot = canonicalSnapshot(structuredClone(entry.snapshot))
      const hasTranscript = snapshot.entries.some((record) => record.transcript.trim())
      if ((snapshot.total === 0 && selections.length > 0) || (hasTranscript && !selections.length))
        fail('invalid-selection')
      for (const selection of selections) {
        const source = snapshot.entries.find((record) => record.id === selection.id)
        if (!source) fail('source-not-retrieved')
        if (!source.transcript.includes(selection.quote)) fail('quote-not-in-source')
      }
      const current = canonicalSnapshot(await revalidate(snapshot.date, signal))
      guard(signal)
      fresh(entry)
      if (digest(current) !== digest(snapshot)) fail('sources-changed')
      return {
        text: render(snapshot, selections, dependencies.locale, dependencies.includeTimes === true),
        receipt: {
          date: snapshot.date,
          sourceKind: sourceKind(snapshot.sourceKind),
          sourceIds: selections.map((selection) => selection.id),
          contentHash: digest({ snapshot, selections }),
        },
      }
    },
  }
}
