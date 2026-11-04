import { createHash } from 'node:crypto'
import type { CodexClientTool } from './codexClientTools'
import { RESIDENT_MEMORY_SEARCH_LIMIT } from './residentAgentMemoryTool'
import { needsRememberEvidence, requestedArchiveDates } from './residentArchiveIntent'
import { createResidentArchiveTool } from './residentArchiveTool'

// Keep source freshness separate from conversation ownership and model prose.
// Only reads actually made in this turn are revalidated before publication.
export function createResidentArchiveSession(dependencies: {
  run: (args: string[], signal: AbortSignal) => Promise<unknown>
  assertCurrent: () => void
  locale: 'nl' | 'en'
  instruction: string
  recovery: boolean
}) {
  const locale = /\b(ik|mijn|welk|welke|hoe|gesprek|gesprekken|vandaag|gisteren|opname)\b/i.test(
    dependencies.instruction
  )
    ? 'nl'
    : dependencies.locale
  const evidenceRequired = needsRememberEvidence(dependencies.instruction)
  const requestedDates = requestedArchiveDates(dependencies.instruction)
  let failed = false
  let readChanged = false
  const otherReads = new Map<
    string,
    { value: unknown; hash: string; read: (signal: AbortSignal) => Promise<unknown> }
  >()
  const hash = (value: unknown) => {
    const record = value as { action?: unknown; entries?: { id: string }[] } | null
    const normalized =
      record?.action === 'tasks' && Array.isArray(record.entries)
        ? { ...record, entries: [...record.entries].sort((a, b) => a.id.localeCompare(b.id)) }
        : value
    return createHash('sha256')
      .update(JSON.stringify(normalized) ?? 'undefined')
      .digest('hex')
  }
  const unavailable = () =>
    locale === 'nl'
      ? 'Ik kon het antwoord niet betrouwbaar aan je Remember-bronnen toetsen. Probeer de vraag opnieuw; ik vul de ontbrekende informatie niet in.'
      : 'I could not reliably check this answer against your Remember sources. Please ask again; I will not fill in missing information.'
  const guard = (signal: AbortSignal) => {
    signal.throwIfAborted()
    dependencies.assertCurrent()
  }
  const recordRead = (key: string, value: unknown, read: (signal: AbortSignal) => Promise<unknown>) => {
    dependencies.assertCurrent()
    const currentHash = hash(value)
    const previous = otherReads.get(key)
    if (previous && previous.hash !== currentHash) readChanged = true
    otherReads.set(key, { value: structuredClone(value), hash: currentHash, read })
  }
  const conversationPage = (raw: unknown, date: string, offset: number) => {
    const value = raw as {
      schemaVersion: number
      availability: string
      sourceKind: string
      selector: string
      timezone: string
      count: number
      offset: number
      nextOffset: number | null
      items: { id: string; revision: string; text: string; startedAt: number; endedAt: number | null }[]
    }
    if (
      value?.schemaVersion !== 1 ||
      value.availability !== 'available' ||
      !['local-audio-episodes', 'remember-conversations'].includes(value.sourceKind) ||
      value.selector !== date ||
      typeof value.timezone !== 'string' ||
      !value.timezone ||
      !Number.isSafeInteger(value.count) ||
      value.count < 0 ||
      value.offset !== offset ||
      !Array.isArray(value.items) ||
      value.items.length > 20 ||
      offset + value.items.length > value.count ||
      new Set(value.items.map((item) => item?.id)).size !== value.items.length ||
      value.items.some(
        (item) =>
          !item ||
          typeof item.id !== 'string' ||
          !item.id ||
          typeof item.revision !== 'string' ||
          !item.revision ||
          typeof item.text !== 'string' ||
          !Number.isSafeInteger(item.startedAt) ||
          (item.endedAt !== null && (!Number.isSafeInteger(item.endedAt) || item.endedAt < item.startedAt))
      ) ||
      (value.nextOffset !== null &&
        (!Number.isSafeInteger(value.nextOffset) ||
          value.nextOffset !== offset + value.items.length ||
          value.nextOffset <= offset ||
          value.nextOffset >= value.count)) ||
      (value.nextOffset === null && offset + value.items.length !== value.count)
    )
      throw new Error('remember-archive-invalid-page')
    new Intl.DateTimeFormat('en', { timeZone: value.timezone })
    return value
  }
  const conversationReads = new Map<string, Map<number, ReturnType<typeof conversationPage>>>()
  const completeConversations = () => {
    for (const pages of conversationReads.values()) {
      const first = pages.get(0)
      if (!first) return false
      const ids = new Set<string>()
      let offset: number | null = 0
      while (offset !== null) {
        const page = pages.get(offset)
        if (
          !page ||
          page.count !== first.count ||
          page.sourceKind !== first.sourceKind ||
          page.timezone !== first.timezone
        )
          return false
        for (const item of page.items) {
          if (ids.has(item.id)) return false
          ids.add(item.id)
        }
        offset = page.nextOffset
      }
      if (ids.size !== first.count) return false
    }
    return true
  }
  const archive = createResidentArchiveTool({
    run: dependencies.run,
    assertCurrent: dependencies.assertCurrent,
    onConversations() {},
  })
  const archiveTool: CodexClientTool = {
    ...archive,
    async call(raw, context) {
      const input = structuredClone(raw)
      const request = input as { action?: string; date?: string; offset?: number }
      try {
        if (
          request.action === 'conversations' &&
          requestedDates.length &&
          !requestedDates.includes(String(request.date))
        )
          throw new Error('remember-archive-request-date-mismatch')
        const read = async (signal: AbortSignal) => {
          guard(signal)
          const result = await archive.call(input, { ...context, signal })
          guard(signal)
          if (request.action === 'conversations') conversationPage(result, String(request.date), request.offset ?? 0)
          if (JSON.stringify(result).length > 31_000) throw new Error('remember-tool-result-too-large')
          return result
        }
        const result = await read(context.signal)
        recordRead(`archive:${JSON.stringify(input)}`, result, read)
        if (request.action === 'conversations') {
          const page = conversationPage(result, String(request.date), request.offset ?? 0)
          const pages = conversationReads.get(page.selector) ?? new Map()
          pages.set(page.offset, page)
          conversationReads.set(page.selector, pages)
        }
        return result
      } catch (error) {
        failed = true
        throw error
      }
    },
  }
  return {
    tools: [archiveTool],
    hasSourceReads: () => otherReads.size > 0 || failed,
    requiresValidation: () => evidenceRequired || otherReads.size > 0 || failed,
    async refreshTaskReads(taskId: string, beforeResult: unknown, afterResult: unknown, signal: AbortSignal) {
      guard(signal)
      const before = (beforeResult as { task?: Record<string, unknown> })?.task
      const after = (afterResult as { task?: Record<string, unknown> })?.task
      if (
        (afterResult as { saved?: unknown })?.saved !== true ||
        before?.id !== taskId ||
        after?.id !== taskId ||
        typeof before.updatedAt !== 'number' ||
        typeof after.updatedAt !== 'number' ||
        after.updatedAt < before.updatedAt
      )
        throw new Error('remember-task-read-rebase-invalid')
      const fields = Object.keys(before).filter((field) => Object.hasOwn(after, field))
      const update = (entry: Record<string, unknown>) => {
        if (entry.id !== taskId) return entry
        if (fields.some((field) => Object.hasOwn(entry, field) && hash(entry[field]) !== hash(before[field]))) {
          readChanged = true
          return entry
        }
        return Object.fromEntries(
          Object.entries(entry).map(([key, value]) => [key, fields.includes(key) ? after[key] : value])
        )
      }
      for (const [key, entry] of otherReads) {
        const previous = entry.value as {
          action?: string
          task?: Record<string, unknown>
          entries?: Record<string, unknown>[]
        }
        let value: unknown
        if (key === `task:${taskId}` && previous?.task) value = { ...previous, task: update(previous.task) }
        else if (previous?.action === 'tasks' && Array.isArray(previous.entries))
          value = { ...previous, entries: previous.entries.map(update) }
        else continue
        otherReads.set(key, { ...entry, value, hash: hash(value) })
      }
    },
    async refreshMemoryReads(
      change: {
        spaceId: string
        slug: string
        expectedRevision: string
        revision: string
        before: string
        after: string
      },
      signal: AbortSignal
    ) {
      guard(signal)
      for (const [key, entry] of otherReads) {
        if (!key.startsWith('memory:')) continue
        const request = JSON.parse(key.slice('memory:'.length)) as { spaceId?: string; slug?: string; action?: string }
        if (request.spaceId !== change.spaceId) continue
        const previous = entry.value as {
          spaceId?: string
          slug?: string
          revision?: string
          content?: string
          truncated?: boolean
          pages?: { slug: string; revision: string }[]
        }
        if (request.action === 'read' && request.slug === change.slug) {
          if (
            previous.revision !== change.expectedRevision ||
            previous.truncated ||
            typeof previous.content !== 'string' ||
            previous.content.split(change.before).length !== 2
          ) {
            readChanged = true
            continue
          }
          const current = (await entry.read(signal)) as typeof previous
          guard(signal)
          const expected = {
            ...previous,
            revision: change.revision,
            content: previous.content.replace(change.before, () => change.after),
          }
          if (hash(current) !== hash(expected)) {
            readChanged = true
            continue
          }
          otherReads.set(key, { ...entry, value: structuredClone(current), hash: hash(current) })
        } else if (request.action === 'search' && previous.pages?.some((page) => page.slug === change.slug)) {
          const oldPage = previous.pages.find((page) => page.slug === change.slug)
          const current = (await entry.read(signal)) as typeof previous
          guard(signal)
          const newPage = current.pages?.find((page) => page.slug === change.slug)
          const withoutTarget = (value: typeof previous) => ({
            ...value,
            pages: value.pages?.filter((page) => page.slug !== change.slug),
          })
          if (
            oldPage?.revision !== change.expectedRevision ||
            (newPage && newPage.revision !== change.revision) ||
            hash(withoutTarget(previous)) !== hash(withoutTarget(current))
          ) {
            readChanged = true
            continue
          }
          otherReads.set(key, { ...entry, value: structuredClone(current), hash: hash(current) })
        }
      }
    },
    async refreshMemoryCreation(
      change: { spaceId: string; slug: string; revision: string },
      readSearch: (request: unknown, signal: AbortSignal) => Promise<unknown>,
      signal: AbortSignal
    ) {
      guard(signal)
      for (const [key, entry] of otherReads) {
        if (!key.startsWith('memory:')) continue
        const request = JSON.parse(key.slice('memory:'.length)) as { spaceId?: string; action?: string }
        if (request.spaceId !== change.spaceId || request.action !== 'search') continue
        const previous = entry.value as { pages: { slug: string; revision: string }[] }
        // One extra result preserves any page displaced by this insertion.
        const current = (await readSearch(request, signal)) as typeof previous
        guard(signal)
        const created = current.pages.find((page) => page.slug === change.slug)
        const withoutCreated = {
          ...current,
          pages: current.pages.filter((page) => page.slug !== change.slug).slice(0, RESIDENT_MEMORY_SEARCH_LIMIT),
        }
        if (
          previous.pages.some((page) => page.slug === change.slug) ||
          (created && created.revision !== change.revision) ||
          hash(withoutCreated) !== entry.hash
        ) {
          readChanged = true
          continue
        }
        const value = { ...current, pages: current.pages.slice(0, RESIDENT_MEMORY_SEARCH_LIMIT) }
        otherReads.set(key, { ...entry, value: structuredClone(value), hash: hash(value) })
      }
    },
    recordOtherRead: recordRead,
    async finalize(response: string, signal: AbortSignal) {
      guard(signal)
      if (readChanged || failed || !completeConversations()) return unavailable()
      if (dependencies.recovery)
        return locale === 'nl'
          ? 'Het eerdere antwoord kon na het heropenen niet opnieuw aan de Remember-bronnen worden getoetst.'
          : 'The previous answer could not be checked against Remember sources again after reopening.'
      if (evidenceRequired && otherReads.size === 0) return unavailable()
      try {
        for (const entry of otherReads.values()) {
          const current = await entry.read(signal)
          guard(signal)
          if (hash(current) !== entry.hash) return unavailable()
        }
        return response
      } catch {
        guard(signal)
        return unavailable()
      }
    },
  }
}
