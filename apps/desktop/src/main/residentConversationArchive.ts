import { createHash } from 'node:crypto'
import { conversationsShareStableIdentity, type DailyReviewSession, type DayMemory } from '@remember/shared'
import type { ImportedRevinoteMeeting } from './revinoteIntegration'
import { suppressLocalConversationsCoveredByRevinote } from './revinoteMeetings'

type Session = Pick<DailyReviewSession, 'id' | 'localDay' | 'startedAt'> & {
  memory?: Pick<DayMemory, 'conversations' | 'deletedConversationWindows'> | null
}
type Runner = (args: string[], signal: AbortSignal) => Promise<unknown>
type Value = Record<string, unknown>

function fail(reason: string): never {
  throw new Error(`remember-conversation-archive-${reason}`)
}

function object(value: unknown): value is Value {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function hash(value: unknown): string {
  const canonical = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(canonical)
    if (object(entry))
      return Object.fromEntries(
        Object.keys(entry)
          .sort()
          .map((key) => [key, canonical(entry[key])])
      )
    return entry
  }
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
}

function validDate(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T12:00:00Z`)) &&
    new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value
  )
}

function visibleConversations(session: Session) {
  const deleted = session.memory?.deletedConversationWindows ?? []
  const visible = (session.memory?.conversations ?? []).filter(
    (conversation) =>
      !deleted.some((reference) =>
        reference.episodeId || reference.externalId || reference.id
          ? conversationsShareStableIdentity(reference, conversation)
          : reference.startTime === conversation.startTime && reference.endTime === conversation.endTime
      )
  )
  return suppressLocalConversationsCoveredByRevinote(session.startedAt, visible)
}

function originalMeeting(snapshot: unknown, id: string): ImportedRevinoteMeeting {
  if (!object(snapshot) || snapshot.version !== 1 || !object(snapshot.meetings)) fail('imports-unavailable')
  const meeting = snapshot.meetings[id]
  if (
    !object(meeting) ||
    meeting.id !== id ||
    meeting.status !== 'finished' ||
    typeof meeting.date !== 'string' ||
    !Number.isSafeInteger(Date.parse(meeting.date)) ||
    typeof meeting.updatedAt !== 'string' ||
    !Number.isSafeInteger(Date.parse(meeting.updatedAt)) ||
    (meeting.title !== null && typeof meeting.title !== 'string') ||
    (meeting.summary !== null && typeof meeting.summary !== 'string') ||
    (meeting.transcript !== null && typeof meeting.transcript !== 'string') ||
    (meeting.durationSeconds !== null &&
      (typeof meeting.durationSeconds !== 'number' ||
        !Number.isFinite(meeting.durationSeconds) ||
        meeting.durationSeconds < 0)) ||
    !Array.isArray(meeting.participants) ||
    meeting.participants.some((value) => typeof value !== 'string') ||
    !Array.isArray(meeting.actionItems)
  )
    fail('import-unavailable')
  return structuredClone(meeting) as ImportedRevinoteMeeting
}

function selectedSessions(sessions: readonly Session[], date: string) {
  return sessions
    .filter((session) => session.localDay === date)
    .map((session) => ({
      id: session.id,
      localDay: session.localDay,
      startedAt: session.startedAt,
      memory: {
        conversations: structuredClone(session.memory?.conversations ?? []),
        deletedConversationWindows: structuredClone(session.memory?.deletedConversationWindows ?? []),
      } as Pick<DayMemory, 'conversations' | 'deletedConversationWindows'>,
    }))
}

export function createResidentConversationArchive(dependencies: {
  runCLI: Runner
  readSessions: (date?: string) => readonly Session[]
  readImported: () => unknown
  assertCurrent: () => void
  timeZone?: string
}): Runner {
  const timezone = dependencies.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const dateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const guard = (signal: AbortSignal) => {
    if (signal.aborted) fail('cancelled')
    dependencies.assertCurrent()
  }
  const readImported = () => {
    try {
      return dependencies.readImported()
    } catch {
      fail('imports-unavailable')
    }
  }

  const readDate = async (date: string, signal: AbortSignal) => {
    guard(signal)
    const status = await dependencies.runCLI(['status'], signal)
    guard(signal)
    if (!object(status) || typeof status.dataDirectory !== 'string' || !status.dataDirectory.trim())
      fail('profile-unavailable')
    const dataDirectory = status.dataDirectory
    const sessions = selectedSessions(dependencies.readSessions(date), date)
    const before = hash(sessions)
    const visible = sessions.flatMap((session) =>
      visibleConversations(session).map((conversation) => ({ session, conversation }))
    )
    const importIds = [
      ...new Set(
        visible.flatMap(({ conversation }) =>
          conversation.source === 'revinote' ? [conversation.externalId || fail('missing-import-identity')] : []
        )
      ),
    ]
    const originals = new Map<string, ImportedRevinoteMeeting>()
    if (importIds.length) {
      const snapshot = readImported()
      for (const id of importIds) originals.set(id, originalMeeting(snapshot, id))
    }
    const localRows = new Map<string, Value>()
    for (const session of sessions) {
      if (!visible.some((entry) => entry.session.id === session.id && entry.conversation.source !== 'revinote'))
        continue
      let offset: number | null = 0
      let expectedCount: number | null = null
      let collected = 0
      while (offset !== null) {
        guard(signal)
        const raw = await dependencies.runCLI(
          ['conversations', session.id, '--page', '--limit', '200', '--offset', String(offset)],
          signal
        )
        guard(signal)
        if (
          !object(raw) ||
          raw.schemaVersion !== 1 ||
          raw.availability !== 'available' ||
          raw.sourceKind !== 'local-audio-episodes' ||
          raw.selector !== session.id ||
          !Array.isArray(raw.items) ||
          !Number.isSafeInteger(raw.count) ||
          Number(raw.count) < 0 ||
          raw.offset !== offset ||
          (raw.nextOffset !== null && (!Number.isSafeInteger(raw.nextOffset) || Number(raw.nextOffset) <= offset)) ||
          typeof raw.dataDirectory !== 'string'
        )
          fail('invalid-local-page')
        if (raw.dataDirectory !== dataDirectory) fail('profile-changed')
        expectedCount ??= Number(raw.count)
        if (expectedCount !== raw.count || expectedCount > 2000) fail('local-page-changed')
        for (const item of raw.items) {
          if (
            !object(item) ||
            typeof item.id !== 'string' ||
            item.dayId !== session.id ||
            typeof item.text !== 'string' ||
            typeof item.revision !== 'string' ||
            !['classified', 'confirmed', 'recorded'].includes(String(item.acceptance)) ||
            !Number.isSafeInteger(item.startedAt) ||
            !Number.isSafeInteger(item.endedAt) ||
            Number(item.startedAt) < 0 ||
            Number(item.endedAt) < Number(item.startedAt) ||
            localRows.has(item.id)
          )
            fail('invalid-local-record')
          localRows.set(item.id, structuredClone(item))
          collected++
        }
        if (raw.nextOffset !== null && raw.nextOffset !== offset + raw.items.length) fail('invalid-local-page')
        offset = raw.nextOffset as number | null
      }
      if (collected !== expectedCount) fail('incomplete-local-page')
    }
    const items = visible
      .map(({ session, conversation }) => {
        const archiveReference = {
          dayId: session.id,
          localDay: session.localDay,
          startedAt: session.startedAt,
          conversation,
        }
        if (conversation.source === 'revinote') {
          const original = originals.get(conversation.externalId ?? '') ?? fail('import-unavailable')
          const startedAt = Date.parse(original.date)
          const endedAt = startedAt + Math.round((original.durationSeconds ?? 0) * 1000)
          if (startedAt < 0 || !Number.isSafeInteger(endedAt)) fail('invalid-import-time')
          const id = `revinote:${original.id}`
          return {
            id,
            sourceRef: { kind: 'conversation', id },
            dayId: session.id,
            date,
            dateBasis: 'archive-day',
            actualDate: dateFormatter.format(startedAt),
            startedAt,
            endedAt,
            endTimeKnown: original.durationSeconds !== null,
            acceptance: 'imported',
            source: 'revinote',
            sourceKind: 'imported-conversation',
            savedTitle: original.title?.trim() || conversation.title,
            revision: hash({ original, archiveReference }),
            transcriptAvailable: Boolean(original.transcript?.trim()),
            text: original.transcript ?? '',
            transcriptSources: [{ kind: 'revinote-transcript', id: original.id, revision: hash(original) }],
          }
        }
        const source = localRows.get(conversation.episodeId ?? '') ?? fail('visible-local-source-unavailable')
        return {
          ...source,
          date,
          dateBasis: 'archive-day',
          actualDate: dateFormatter.format(Number(source.startedAt)),
          revision: hash({ sourceRevision: source.revision, archiveReference }),
        }
      })
      .sort(
        (first, second) =>
          Number(first.startedAt) - Number(second.startedAt) || String(first.id).localeCompare(String(second.id))
      )
    if (new Set(items.map((item) => item.id)).size !== items.length) fail('duplicate-visible-record')
    guard(signal)
    if (hash(selectedSessions(dependencies.readSessions(date), date)) !== before) fail('visibility-changed')
    if (importIds.length) {
      const current = readImported()
      for (const id of importIds)
        if (hash(originalMeeting(current, id)) !== hash(originals.get(id))) fail('import-changed')
    }
    guard(signal)
    return { items, dataDirectory }
  }

  return async (args, signal) => {
    const command = [...args]
    guard(signal)
    if (
      command[0] === 'source' &&
      command[1] === 'read' &&
      command[2] === 'conversation' &&
      command[3]?.startsWith('revinote:')
    ) {
      const id = command[3]
      const externalId = id.slice('revinote:'.length)
      const dates = [
        ...new Set(
          dependencies
            .readSessions()
            .filter((session) =>
              visibleConversations(session).some(
                (conversation) => conversation.source === 'revinote' && conversation.externalId === externalId
              )
            )
            .map((session) => session.localDay)
        ),
      ]
      if (!dates.length) return { kind: 'conversation', id, availability: 'not_found', record: null }
      if (dates.length !== 1) fail('duplicate-visible-record')
      const { items } = await readDate(dates[0] ?? fail('missing-date'), signal)
      const record = items.find((item) => item.id === id) ?? fail('import-unavailable')
      return { kind: 'conversation', id, availability: 'available', record }
    }
    if (command[0] !== 'conversations') return dependencies.runCLI(command, signal)
    const date = command[1]
    if (!date || !validDate(date)) fail('invalid-date')
    const argument = (name: string, fallback: number) => {
      const index = command.indexOf(name)
      const value = index < 0 ? fallback : Number(command[index + 1])
      if (!Number.isSafeInteger(value) || value < 0) fail('invalid-pagination')
      return value
    }
    const offset = argument('--offset', 0)
    const limit = argument('--limit', 20)
    if (!limit || limit > 200) fail('invalid-pagination')
    const { items, dataDirectory } = await readDate(date, signal)
    const page = items.slice(offset, offset + limit)
    return {
      schemaVersion: 1,
      dataDirectory,
      selector: date,
      dateBasis: 'archive-day',
      timezone,
      availability: 'available',
      sourceKind: 'remember-conversations',
      coverage: { localAudioEpisodes: true, importedConversations: true },
      count: items.length,
      offset,
      limit,
      hasMore: offset + page.length < items.length,
      nextOffset: offset + page.length < items.length ? offset + page.length : null,
      items: page,
    }
  }
}
