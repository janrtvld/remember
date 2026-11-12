'use client'

import { Dialog, DialogBackdrop, DialogDescription, DialogPanel, DialogTitle } from '@headlessui/react'
import { conversationReference, type Day, type RememberSearchResults } from '@remember/shared'
import {
  ChevronRight as IconChevronRight,
  X as IconCrossSmall,
  Search as IconMagnifyingGlass2,
  Sparkle as IconSparkle,
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useLocalBridge } from '../context/LocalBridgeProvider'
import { useI18n } from '../locales'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import {
  type ConversationSearchResult,
  conversationSearchHref,
  type DaySearchResult,
  daySearchHref,
  searchRemember,
  searchWikiPages,
  type TimelineSearchResult,
  timelineSearchHref,
  type WikiSearchResult,
} from './daySearch'
import { wikiPageHref } from './wikiRoutes'

type SearchResult = DaySearchResult | ConversationSearchResult | TimelineSearchResult | WikiSearchResult

function resultKey(result: SearchResult) {
  if (result.kind === 'day') return `day-${result.day.id}`
  if (result.kind === 'wiki') return `wiki-${result.space.id}-${result.page.slug}`
  if (result.kind === 'timeline') {
    return `timeline-${result.day.id}-${result.block.id ?? `${result.block.startTime}-${result.block.title}`}`
  }
  return `conversation-${result.day.id}-${conversationReference(result.conversation)}`
}

function sourceEvidenceRemoved(previous: Day[], next: Day[]) {
  const byId = new Map(next.map((day) => [day.id, day]))
  return previous.some((day) => {
    const current = byId.get(day.id)
    if (!current) return true
    if ((current.contextEvidenceRemovals ?? 0) !== (day.contextEvidenceRemovals ?? 0)) return true
    const before = day.moments
    const after = current.moments
    if (after.length < before.length || (before.length && before.at(-1)?.id !== after[before.length - 1]?.id))
      return true
    return (
      JSON.stringify(day.memory?.hiddenTimelineItemIds) !== JSON.stringify(current.memory?.hiddenTimelineItemIds) ||
      JSON.stringify(day.memory?.deletedConversationWindows) !==
        JSON.stringify(current.memory?.deletedConversationWindows)
    )
  })
}

function mergeSearchResults<T extends DaySearchResult | ConversationSearchResult | TimelineSearchResult>(
  first: T[],
  second: T[]
) {
  const byId = new Map([...first, ...second].map((result) => [resultKey(result), result]))
  return [...byId.values()].sort((a, b) => b.score - a.score || b.day.startedAt - a.day.startedAt).slice(0, 8)
}

function highlight(text: string, query: string) {
  const terms = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (!terms.length) return text

  const expression = new RegExp(`(${terms.join('|')})`, 'gi')
  let position = 0
  return text.split(expression).map((part, index) => {
    const partPosition = position
    position += part.length
    return index % 2 === 1 ? (
      <mark key={`${partPosition}-${part}`} className="rounded-sm bg-blue-700/15 text-slate-950">
        {part}
      </mark>
    ) : (
      part
    )
  })
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  return (
    <>
      <span aria-hidden="true">{highlight(text, query)}</span>
      <span className="sr-only">{text}</span>
    </>
  )
}

function conversationDayLabel(timestamp: number, locale: 'en-US' | 'nl-NL') {
  return new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' }).format(timestamp)
}

function SearchSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0" aria-labelledby={`search-${title.toLocaleLowerCase('nl-NL')}`}>
      <h2 id={`search-${title.toLocaleLowerCase('nl-NL')}`} className="px-3 pb-1.5 font-medium text-slate-500 text-xs">
        {title}
      </h2>
      <ol className="grid min-w-0 gap-0.5">{children}</ol>
    </section>
  )
}

function SearchResultRow({
  result,
  query,
  active,
  id,
  onActivate,
  onOpen,
}: {
  result: SearchResult
  query: string
  active: boolean
  id: string
  onActivate: () => void
  onOpen: () => void
}) {
  const { dateLocale } = useI18n()
  const meta =
    result.kind === 'day'
      ? null
      : result.kind === 'wiki'
        ? result.space.name
        : result.kind === 'timeline'
          ? `${conversationDayLabel(result.day.startedAt, dateLocale)} · ${result.block.startTime}–${result.block.endTime}`
          : `${conversationDayLabel(result.day.startedAt, dateLocale)} · ${result.conversation.startTime}–${result.conversation.endTime}`

  return (
    <li className="min-w-0">
      <button
        id={id}
        type="button"
        aria-current={active ? 'true' : undefined}
        onMouseMove={onActivate}
        onFocus={onActivate}
        onClick={onOpen}
        className={`group flex min-w-0 w-full max-w-full items-center gap-3 overflow-hidden rounded-lg px-3 py-2.5 text-left outline-none transition-colors duration-100 motion-reduce:transition-none ${
          active ? 'bg-slate-100' : 'hover:bg-slate-50'
        }`}
      >
        <span className="min-w-0 flex-1 overflow-hidden">
          <span className="flex min-w-0 items-baseline gap-2 overflow-hidden">
            <span className="min-w-0 flex-1 truncate font-medium text-slate-900 text-ui">
              <HighlightedText text={result.title} query={query} />
            </span>
            {meta ? (
              <span className="max-w-[52%] min-w-0 shrink truncate text-slate-600 text-xs tabular-nums">{meta}</span>
            ) : null}
          </span>
          <span className="mt-0.5 block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-slate-600 text-sm">
            <HighlightedText text={result.snippet} query={query} />
          </span>
        </span>
        <IconChevronRight
          aria-hidden="true"
          className={`size-3.5 shrink-0 transition-[color,transform] duration-100 motion-reduce:transition-none ${
            active ? 'translate-x-px text-slate-500' : 'text-slate-300'
          }`}
        />
      </button>
    </li>
  )
}

export function RememberSearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const local = useLocalBridge()
  const { days, loadAllWikiPages } = local
  const { dateLocale, t } = useI18n()
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const searchQuery = open ? deferredQuery : ''
  const [activeIndex, setActiveIndex] = useState(0)
  const [wikiSearchLoadStatus, setWikiSearchLoadStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const wikiSearchRequestRef = useRef(0)
  const previousDays = useRef(days)
  const [sourceEpoch, setSourceEpoch] = useState(0)
  const [contentSearch, setContentSearch] = useState<{
    query: string
    locale: string
    epoch: number
    status: 'loading' | 'ready' | 'error'
    results?: RememberSearchResults
  } | null>(null)
  const summaries = useMemo(() => searchRemember(days, searchQuery, dateLocale), [dateLocale, days, searchQuery])
  const removedEvidence = previousDays.current !== days && sourceEvidenceRemoved(previousDays.current, days)
  const currentContent =
    !removedEvidence &&
    contentSearch?.query === query &&
    contentSearch.locale === dateLocale &&
    contentSearch.epoch === sourceEpoch
      ? contentSearch
      : null
  const results = currentContent?.results
    ? {
        days: mergeSearchResults(currentContent.results.days, summaries.days),
        conversations: mergeSearchResults(currentContent.results.conversations, summaries.conversations),
        timeline: mergeSearchResults(currentContent.results.timeline, summaries.timeline),
      }
    : summaries

  useEffect(() => {
    if (removedEvidence) {
      setContentSearch(null)
      setSourceEpoch((epoch) => epoch + 1)
    }
    previousDays.current = days
  }, [days, removedEvidence])

  useEffect(() => {
    const bridge = local.bridge
    if (!open || !query.trim() || !bridge) return
    let cancelled = false
    let started = false
    setContentSearch({ query, locale: dateLocale, epoch: sourceEpoch, status: 'loading' })
    const timer = window.setTimeout(() => {
      started = true
      void bridge
        .searchDays(query, dateLocale)
        .then((results) => {
          if (!cancelled) setContentSearch({ query, locale: dateLocale, epoch: sourceEpoch, status: 'ready', results })
        })
        .catch(() => {
          if (!cancelled) setContentSearch({ query, locale: dateLocale, epoch: sourceEpoch, status: 'error' })
        })
    }, 100)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      if (started) void bridge.searchDays('', dateLocale).catch(() => {})
    }
  }, [open, query, dateLocale, sourceEpoch, local.bridge])
  const wikiResults = useMemo(
    () => searchWikiPages(local.wikiOverview?.spaces ?? [], local.wikiBySpace, searchQuery),
    [local.wikiBySpace, local.wikiOverview?.spaces, searchQuery]
  )
  const allResults: SearchResult[] = [...wikiResults, ...results.days, ...results.conversations, ...results.timeline]
  const hasQuery = Boolean(query.trim())
  const hasResults = allResults.length > 0
  const offlineMode = local.settings?.offlineMode === true
  const searchSourcesLoading =
    wikiSearchLoadStatus === 'loading' ||
    local.dataLoadStatus.days === 'loading' ||
    (hasQuery && currentContent?.status !== 'ready' && currentContent?.status !== 'error')
  const searchSourcesFailed =
    wikiSearchLoadStatus === 'error' || local.dataLoadStatus.days === 'error' || currentContent?.status === 'error'

  const loadWikiSearchPages = useCallback(async () => {
    const request = ++wikiSearchRequestRef.current
    setWikiSearchLoadStatus('loading')
    try {
      await loadAllWikiPages()
      if (request === wikiSearchRequestRef.current) setWikiSearchLoadStatus('ready')
    } catch {
      if (request === wikiSearchRequestRef.current) setWikiSearchLoadStatus('error')
    }
  }, [loadAllWikiPages])

  useEffect(() => {
    if (!open) return
    void loadWikiSearchPages()
  }, [loadWikiSearchPages, open])

  useEffect(() => {
    if (!open) return
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [open])

  useEffect(() => {
    if (open) return
    const timeout = window.setTimeout(() => setQuery(''), 120)
    return () => window.clearTimeout(timeout)
  }, [open])

  function openResult(result: SearchResult) {
    router.push(
      result.kind === 'wiki'
        ? wikiPageHref(result.space.id, result.page.slug)
        : result.kind === 'day'
          ? daySearchHref(result.day)
          : result.kind === 'timeline'
            ? timelineSearchHref(result.day, result.block)
            : conversationSearchHref(result.day, result.conversation)
    )
    onClose()
  }

  function askAgent() {
    const question = query.trim()
    if (!question) return
    router.push(`/assistant/?prompt=${encodeURIComponent(question)}`)
    onClose()
  }

  async function retrySearchSources() {
    setSourceEpoch((epoch) => epoch + 1)
    await Promise.all([
      loadWikiSearchPages(),
      local.dataLoadStatus.days === 'error' ? local.refresh() : Promise.resolve(),
    ])
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'a') {
      event.preventDefault()
      event.currentTarget.select()
      return
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && hasQuery && !offlineMode) {
      event.preventDefault()
      void askAgent()
      return
    }
    if (!hasResults) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((current) => (current + 1) % allResults.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((current) => (current - 1 + allResults.length) % allResults.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const activeResult = allResults[activeIndex] ?? allResults[0]
      if (activeResult) openResult(activeResult)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} className="app-no-drag relative z-50">
      <DialogBackdrop
        transition
        className="fixed inset-0 bg-modal-backdrop backdrop-blur-[1px] transition-opacity data-[closed]:opacity-0 motion-reduce:transition-none ease-[cubic-bezier(0.215,0.61,0.355,1)] data-[leave]:ease-out duration-(--modal-enter-duration) data-[leave]:duration-(--modal-exit-duration)"
      />
      <div className="fixed inset-0 flex items-start justify-center p-4 pt-[12vh]">
        <DialogPanel
          transition
          className="flex max-h-[72vh] min-w-0 w-full max-w-xl origin-center flex-col overflow-hidden rounded-xl bg-white shadow-raised transition-[opacity,scale] data-[closed]:scale-[0.98] data-[closed]:opacity-0 motion-reduce:transition-none ease-[cubic-bezier(0.215,0.61,0.355,1)] data-[leave]:ease-out duration-(--modal-enter-duration) data-[leave]:duration-(--modal-exit-duration)"
        >
          <DialogTitle className="sr-only">{t('Zoeken in Remember')}</DialogTitle>
          <DialogDescription className="sr-only">
            {t('Zoek in dagen, tijdlijn en gesprekken die lokaal in Remember staan.')}
          </DialogDescription>
          <div className="flex min-h-12 items-center gap-2 border-slate-200 border-b px-3">
            <IconMagnifyingGlass2 className="size-4 shrink-0 text-slate-400" aria-hidden="true" />
            <label htmlFor="remember-search-query" className="sr-only">
              {t('Zoeken')}
            </label>
            <input
              id="remember-search-query"
              ref={inputRef}
              type="text"
              inputMode="search"
              maxLength={4096}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setActiveIndex(0)
              }}
              onKeyDown={handleKeyDown}
              placeholder={t('Zoek in dagen, tijdlijn en gesprekken…')}
              autoComplete="off"
              spellCheck="false"
              data-1p-ignore
              className="min-w-0 flex-1 bg-transparent py-3 text-slate-900 text-ui outline-none placeholder:text-slate-500"
            />
            {query ? (
              <IconButton
                onClick={() => {
                  setQuery('')
                  inputRef.current?.focus()
                }}
                aria-label={t('Zoekopdracht wissen')}
                title={t('Wissen')}
              >
                <IconCrossSmall className="size-4" aria-hidden="true" />
              </IconButton>
            ) : (
              <kbd className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-sans text-slate-500 text-[11px]">
                esc
              </kbd>
            )}
          </div>

          {hasQuery && searchSourcesFailed ? (
            <div className="flex items-center justify-between gap-3 border-slate-200 border-b bg-danger-50 px-3 py-2">
              <p className="text-danger-700 text-xs" role="alert">
                {t('Niet alle zoekbronnen konden worden geladen. De getoonde resultaten kunnen onvolledig zijn.')}
              </p>
              <Button
                size="small"
                variant="outline"
                color="danger"
                disabled={searchSourcesLoading}
                onClick={() => void retrySearchSources()}
              >
                {t('Probeer opnieuw')}
              </Button>
            </div>
          ) : null}

          <div
            id={listId}
            role={hasQuery ? 'region' : undefined}
            aria-label={hasQuery ? t('Zoekresultaten') : undefined}
            aria-live="polite"
            className="custom-scrollbar min-w-0 overflow-x-hidden overflow-y-auto p-2"
          >
            {!hasQuery ? (
              <p className="px-3 py-8 text-center text-slate-500 text-sm">{t('Zoek in je Remember-geheugen.')}</p>
            ) : null}
            {hasQuery && searchSourcesLoading && !hasResults ? (
              <p className="px-3 py-8 text-center text-slate-500 text-sm" role="status">
                {t('Zoekbronnen laden…')}
              </p>
            ) : null}
            {hasQuery && !hasResults && !searchSourcesLoading && !searchSourcesFailed ? (
              <p className="px-3 py-8 text-center text-slate-500 text-sm">{t('Geen resultaten gevonden.')}</p>
            ) : null}
            {wikiResults.length ? (
              <SearchSection title={t('Wiki')}>
                {wikiResults.map((result, resultIndex) => {
                  const index = resultIndex
                  const id = `${listId}-${resultKey(result)}`
                  return (
                    <SearchResultRow
                      key={resultKey(result)}
                      id={id}
                      result={result}
                      query={searchQuery}
                      active={activeIndex === index}
                      onActivate={() => setActiveIndex(index)}
                      onOpen={() => openResult(result)}
                    />
                  )
                })}
              </SearchSection>
            ) : null}
            {results.days.length ? (
              <div className={wikiResults.length ? 'mt-4' : ''}>
                <SearchSection title={t('Dagen')}>
                  {results.days.map((result, resultIndex) => {
                    const index = wikiResults.length + resultIndex
                    const id = `${listId}-${resultKey(result)}`
                    return (
                      <SearchResultRow
                        key={resultKey(result)}
                        id={id}
                        result={result}
                        query={searchQuery}
                        active={activeIndex === index}
                        onActivate={() => setActiveIndex(index)}
                        onOpen={() => openResult(result)}
                      />
                    )
                  })}
                </SearchSection>
              </div>
            ) : null}
            {results.conversations.length ? (
              <div className={`min-w-0 ${wikiResults.length || results.days.length ? 'mt-4' : ''}`}>
                <SearchSection title={t('Gesprekken')}>
                  {results.conversations.map((result, resultIndex) => {
                    const index = wikiResults.length + results.days.length + resultIndex
                    const id = `${listId}-${resultKey(result)}`
                    return (
                      <SearchResultRow
                        key={resultKey(result)}
                        id={id}
                        result={result}
                        query={searchQuery}
                        active={activeIndex === index}
                        onActivate={() => setActiveIndex(index)}
                        onOpen={() => openResult(result)}
                      />
                    )
                  })}
                </SearchSection>
              </div>
            ) : null}
            {results.timeline.length ? (
              <div
                className={`min-w-0 ${
                  wikiResults.length || results.days.length || results.conversations.length ? 'mt-4' : ''
                }`}
              >
                <SearchSection title={t('Tijdlijn')}>
                  {results.timeline.map((result, resultIndex) => {
                    const index = wikiResults.length + results.days.length + results.conversations.length + resultIndex
                    const id = `${listId}-${resultKey(result)}`
                    return (
                      <SearchResultRow
                        key={resultKey(result)}
                        id={id}
                        result={result}
                        query={searchQuery}
                        active={activeIndex === index}
                        onActivate={() => setActiveIndex(index)}
                        onOpen={() => openResult(result)}
                      />
                    )
                  })}
                </SearchSection>
              </div>
            ) : null}
          </div>
          {hasQuery ? (
            <div className="flex items-center justify-between gap-3 border-slate-200 border-t px-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-slate-600 text-sm">{t('Geen letterlijke match nodig')}</p>
                {offlineMode ? (
                  <p className="text-slate-500 text-xs">{t('AI is gepauzeerd in Offline mode.')}</p>
                ) : (
                  <p className="text-slate-500 text-xs">{t('Laat AI in je lokale geschiedenis zoeken.')}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => void askAgent()}
                disabled={offlineMode}
                className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-slate-900 px-3 font-medium text-on-accent text-sm outline-none transition-[background-color,transform] duration-150 hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2 active:scale-[0.97] disabled:cursor-not-allowed disabled:bg-slate-300 motion-reduce:transition-none"
              >
                <IconSparkle className="size-3.5" aria-hidden="true" />
                {t('Vraag AI')}
                <kbd className="ml-1 font-sans text-[10px] text-white/60">
                  {local.bridge?.platform === 'macos' ? '⌘↵' : 'Ctrl ↵'}
                </kbd>
              </button>
            </div>
          ) : null}
        </DialogPanel>
      </div>
    </Dialog>
  )
}
