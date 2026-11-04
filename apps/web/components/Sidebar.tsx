'use client'

import { useLocalBridge } from '@internal/context/LocalBridgeProvider'
import { readLocalStorageJson, writeLocalStorageJson } from '@internal/lib/localStorageJson'
import { useI18n } from '@internal/locales'
import { IconButton } from '@internal/ui/IconButton'
import { Spinner } from '@internal/ui/Spinner'
import type { UpdateState } from '@remember/shared'
import {
  Box as IconBox2,
  MessagesSquare as IconBubbles,
  CalendarDays as IconCalendarDays,
  ChevronDown as IconChevronDownSmall,
  Terminal as IconConsole,
  TriangleAlert as IconExclamationTriangle,
  EyeOff as IconEyeSlash,
  Search as IconMagnifyingGlass2,
  Plus as IconPlusSmall,
  Settings as IconSettingsGear2,
} from 'lucide-react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { type KeyboardEvent, type PointerEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { twMerge } from 'tailwind-merge'
import { Logo } from './Logo'
import { isConversationsPath, isWorkdaysPath } from './sidebarNavigation'
import { WikiSpaceGlyph } from './WikiSpaceBadge'
import { wikiHomeHref, wikiNewSpaceHref, wikiSpaceId } from './wikiRoutes'

const RememberSearchDialog = dynamic(
  () => import('./RememberSearchDialog').then((module) => module.RememberSearchDialog),
  { ssr: false }
)

const primaryTabs = [
  { href: '/inbox/', label: 'Taken', icon: IconBox2 },
  { href: '/day/', label: 'Mijn dag', icon: IconCalendarDays },
  { href: '/conversations/', label: 'Gesprekken', icon: IconBubbles },
  { href: '/assistant/', label: 'Agent', icon: IconBubbles },
]

const settingsTabs = [
  { href: '/agent/', label: 'Agent', icon: IconConsole },
  { href: '/exclusions/', label: 'Privacy', icon: IconEyeSlash },
  { href: '/settings/', label: 'Instellingen', icon: IconSettingsGear2 },
]

type SidebarTab = (typeof primaryTabs)[number] | (typeof settingsTabs)[number]

export function Sidebar({ open, onOpen }: { open: boolean; onOpen: () => void }) {
  const { t } = useI18n()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const local = useLocalBridge()
  const [agentAttention, setAgentAttention] = useState({ unread: false, needsInput: false })
  useEffect(() => {
    let alive = true
    let received = false
    const unsubscribe = local.bridge?.onAssistantAttentionChanged?.((state) => {
      received = true
      if (alive) setAgentAttention(state)
    })
    void local.bridge
      ?.getAssistantAttention?.()
      .then((state) => {
        if (alive && !received) setAgentAttention(state)
      })
      .catch(() => {})
    return () => {
      alive = false
      unsubscribe?.()
    }
  }, [local.bridge])
  const [searchState, setSearchState] = useState<'unopened' | 'open' | 'closed'>('unopened')
  const searchOpen = searchState === 'open'
  const searchButtonRef = useRef<HTMLButtonElement>(null)
  const [displayedSpaces, setDisplayedSpaces] = useState(local.wikiOverview?.spaces ?? [])
  const [draggedSpaceId, setDraggedSpaceId] = useState<string | null>(null)
  const [spaceOrderAnnouncement, setSpaceOrderAnnouncement] = useState('')
  const displayedSpacesRef = useRef(displayedSpaces)
  const originalSpacesRef = useRef(displayedSpaces)
  const didDragSpaceRef = useRef(false)
  const spacePointerRef = useRef<{ id: number; startY: number; spaceId: string } | null>(null)
  const spaceRowRefs = useRef(new Map<string, HTMLAnchorElement>())
  const hasActionableUpdate = local.update.status === 'downloaded'
  const agentNeedsReconnect = [local.settings?.defaultAgentProvider, local.settings?.dayAnalysisProvider].some(
    (provider) => provider && local.agentConnections[provider]?.status === 'signed-out'
  )
  const activeWikiSpaceId = pathname.startsWith('/wiki/') ? wikiSpaceId(searchParams.get('space')) : null

  useEffect(() => {
    if (draggedSpaceId) return
    const spaces = local.wikiOverview?.spaces ?? []
    displayedSpacesRef.current = spaces
    setDisplayedSpaces(spaces)
  }, [draggedSpaceId, local.wikiOverview?.spaces])

  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      if (!(event.metaKey || event.ctrlKey) || event.key.toLocaleLowerCase() !== 'k') return
      event.preventDefault()
      if (searchOpen) return
      onOpen()
      setSearchState('open')
    }

    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [onOpen, searchOpen])

  function closeSearch() {
    setSearchState('closed')
    window.requestAnimationFrame(() => searchButtonRef.current?.focus())
  }

  function openSearch() {
    onOpen()
    setSearchState('open')
  }

  function moveDisplayedSpace(spaceId: string, targetSpaceId: string) {
    setDisplayedSpaces((current) => {
      const sourceIndex = current.findIndex((space) => space.id === spaceId)
      const targetIndex = current.findIndex((space) => space.id === targetSpaceId)
      if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return current
      const next = [...current]
      const [moved] = next.splice(sourceIndex, 1)
      next.splice(targetIndex, 0, moved)
      displayedSpacesRef.current = next
      didDragSpaceRef.current = true
      return next
    })
  }

  function saveSpaceOrder(spaces: typeof displayedSpaces, movedSpaceId: string) {
    const movedSpace = spaces.find((space) => space.id === movedSpaceId)
    const position = spaces.findIndex((space) => space.id === movedSpaceId) + 1
    void local
      .reorderWikiSpaces({ spaceIds: spaces.map((space) => space.id) })
      .then(() => {
        if (movedSpace) {
          setSpaceOrderAnnouncement(
            t('{name} verplaatst naar positie {position} van {count}.', {
              name: movedSpace.name,
              position,
              count: spaces.length,
            })
          )
        }
      })
      .catch(() => {
        displayedSpacesRef.current = originalSpacesRef.current
        setDisplayedSpaces(originalSpacesRef.current)
        setSpaceOrderAnnouncement(t('De volgorde kon niet worden opgeslagen.'))
      })
  }

  function handleSpacePointerDown(event: PointerEvent<HTMLAnchorElement>, spaceId: string) {
    if (event.button !== 0 || displayedSpacesRef.current.length < 2) return
    originalSpacesRef.current = displayedSpacesRef.current
    didDragSpaceRef.current = false
    spacePointerRef.current = { id: event.pointerId, startY: event.clientY, spaceId }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function handleSpacePointerMove(event: PointerEvent<HTMLAnchorElement>) {
    const pointer = spacePointerRef.current
    if (!pointer || pointer.id !== event.pointerId) return
    if (!didDragSpaceRef.current && Math.abs(event.clientY - pointer.startY) < 4) return
    event.preventDefault()
    if (!didDragSpaceRef.current) {
      didDragSpaceRef.current = true
      setDraggedSpaceId(pointer.spaceId)
    }
    const targetSpace = displayedSpacesRef.current.reduce<{ id: string; distance: number } | null>((closest, space) => {
      const row = spaceRowRefs.current.get(space.id)
      if (!row) return closest
      const bounds = row.getBoundingClientRect()
      const distance = Math.abs(event.clientY - (bounds.top + bounds.height / 2))
      return !closest || distance < closest.distance ? { id: space.id, distance } : closest
    }, null)
    if (targetSpace) moveDisplayedSpace(pointer.spaceId, targetSpace.id)
  }

  function handleSpacePointerUp(event: PointerEvent<HTMLAnchorElement>) {
    const pointer = spacePointerRef.current
    if (!pointer || pointer.id !== event.pointerId) return
    spacePointerRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    if (didDragSpaceRef.current) saveSpaceOrder(displayedSpacesRef.current, pointer.spaceId)
    setDraggedSpaceId(null)
    window.setTimeout(() => {
      didDragSpaceRef.current = false
    }, 0)
  }

  function handleSpacePointerCancel(event: PointerEvent<HTMLAnchorElement>) {
    const pointer = spacePointerRef.current
    if (!pointer || pointer.id !== event.pointerId) return
    spacePointerRef.current = null
    displayedSpacesRef.current = originalSpacesRef.current
    setDisplayedSpaces(originalSpacesRef.current)
    setDraggedSpaceId(null)
    didDragSpaceRef.current = false
  }

  function handleSpaceKeyDown(event: KeyboardEvent<HTMLAnchorElement>, spaceId: string) {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
    event.preventDefault()
    const spaces = displayedSpacesRef.current
    const currentIndex = spaces.findIndex((space) => space.id === spaceId)
    const targetIndex = currentIndex + (event.key === 'ArrowUp' ? -1 : 1)
    if (currentIndex < 0) return
    if (targetIndex < 0 || targetIndex >= spaces.length) {
      const name = spaces[currentIndex]?.name ?? t('Space')
      setSpaceOrderAnnouncement(
        event.key === 'ArrowUp' ? t('{name} staat al bovenaan.', { name }) : t('{name} staat al onderaan.', { name })
      )
      return
    }
    originalSpacesRef.current = spaces
    const next = [...spaces]
    const [moved] = next.splice(currentIndex, 1)
    next.splice(targetIndex, 0, moved)
    displayedSpacesRef.current = next
    setDisplayedSpaces(next)
    saveSpaceOrder(next, spaceId)
  }

  return (
    <aside
      id="dashboard-sidebar"
      aria-hidden={!open}
      className={
        open ? 'app-drag hidden h-full w-[220px] shrink-0 select-none flex-col px-2 pt-[38px] pb-3 sm:flex' : 'hidden'
      }
    >
      <div className="app-drag flex pl-2.5 h-9 w-full items-center justify-between gap-2">
        <div className="flex min-w-0">
          <Logo wordmark />
        </div>
        <IconButton
          ref={searchButtonRef}
          onClick={openSearch}
          className="app-no-drag text-slate-500"
          aria-label={t('Zoeken')}
          aria-keyshortcuts="Meta+K Control+K"
          title={t('Zoeken (⌘K)')}
        >
          <IconMagnifyingGlass2 className="pointer-events-none size-4" aria-hidden="true" />
        </IconButton>
      </div>

      <nav
        aria-label={t('Hoofdnavigatie')}
        className="custom-scrollbar custom-scrollbar-auto-gutter mt-1 flex min-h-0 w-full flex-1 flex-col overflow-y-auto app-no-drag gap-[1.5px]"
      >
        {primaryTabs.map((tab) => {
          const active =
            tab.href === '/day/'
              ? isWorkdaysPath(pathname)
              : tab.href === '/conversations/'
                ? isConversationsPath(pathname)
                : pathname.startsWith(tab.href)
          return (
            <NavItem
              key={tab.href}
              tab={tab}
              active={active}
              notice={
                tab.href === '/assistant/' && (agentAttention.unread || agentAttention.needsInput)
                  ? t(agentAttention.needsInput ? 'Wacht op je antwoord' : 'Ongelezen')
                  : undefined
              }
            />
          )
        })}
        <SidebarGroup
          id="spaces"
          label={t('Spaces')}
          action={{
            label: t('Nieuwe space maken'),
            href: wikiNewSpaceHref(activeWikiSpaceId ?? local.activeWikiSpaceId),
          }}
        >
          <span id="space-reorder-instructions" className="sr-only">
            {t('Sleep een space om de volgorde te wijzigen. Gebruik Option en de pijltoetsen als alternatief.')}
          </span>
          <span className="sr-only" aria-live="polite">
            {spaceOrderAnnouncement}
          </span>
          {displayedSpaces.map((space) => (
            <Link
              key={space.id}
              ref={(element) => {
                if (element) spaceRowRefs.current.set(space.id, element)
                else spaceRowRefs.current.delete(space.id)
              }}
              href={wikiHomeHref(space.id)}
              draggable={false}
              aria-describedby="space-reorder-instructions"
              aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
              aria-current={space.id === activeWikiSpaceId ? 'page' : undefined}
              title={space.name}
              onPointerDown={(event) => handleSpacePointerDown(event, space.id)}
              onPointerMove={handleSpacePointerMove}
              onPointerUp={handleSpacePointerUp}
              onPointerCancel={handleSpacePointerCancel}
              onKeyDown={(event) => handleSpaceKeyDown(event, space.id)}
              onClick={(event) => {
                if (didDragSpaceRef.current) event.preventDefault()
              }}
              className={twMerge(
                'group app-no-drag active:scale-[0.98] flex h-8 w-full shrink-0 touch-none pointer-coarse:min-h-11 select-none items-center gap-1.5 rounded-lg pr-3 pl-[9px] text-left outline-none transition-[background-color,color,opacity,transform] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-500 motion-reduce:transition-none',
                space.id === activeWikiSpaceId
                  ? 'bg-slate-200/60 text-slate-900'
                  : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800',
                draggedSpaceId === space.id && 'cursor-grabbing opacity-50'
              )}
            >
              <span className="flex size-[16px] shrink-0 items-center justify-center">
                <WikiSpaceGlyph icon={space.icon} color={space.color} className="size-[16px]" />
              </span>
              <span className="min-w-0 truncate font-medium text-ui">{space.name}</span>
            </Link>
          ))}
        </SidebarGroup>
        <SidebarGroup id="settings" label={t('Instellingen')}>
          {settingsTabs.map((tab) => (
            <NavItem
              key={tab.href}
              tab={tab}
              active={pathname.startsWith(tab.href)}
              warning={tab.href === '/agent/' && agentNeedsReconnect ? t('Agent opnieuw verbinden') : undefined}
            />
          ))}
        </SidebarGroup>
      </nav>
      {hasActionableUpdate ? (
        <div className="app-no-drag flex w-full px-1 pt-3">
          <SidebarUpdateButton update={local.update} />
        </div>
      ) : null}
      {searchState !== 'unopened' ? <RememberSearchDialog open={searchOpen} onClose={closeSearch} /> : null}
    </aside>
  )
}

function SidebarGroup({
  id,
  label,
  action,
  children,
}: {
  id: 'spaces' | 'settings'
  label: string
  action?: { label: string; href: string }
  children: ReactNode
}) {
  const panelId = useId()
  const storageKey = `remember.sidebar.group.${id}.open`
  const [open, setOpen] = useState(true)

  useEffect(() => {
    const saved = readLocalStorageJson(storageKey)
    setOpen(typeof saved === 'boolean' ? saved : true)
  }, [storageKey])

  function toggleOpen() {
    const nextOpen = !open
    setOpen(nextOpen)
    writeLocalStorageJson(storageKey, nextOpen)
  }

  return (
    <div className="mt-3 flex w-full flex-col gap-1">
      <div className="group/sidebar-header flex h-7 w-full items-center rounded-lg transition-colors duration-150 hover:bg-slate-100 motion-reduce:transition-none">
        <button
          type="button"
          onClick={toggleOpen}
          aria-controls={panelId}
          aria-expanded={open}
          className="group flex h-full min-w-0 flex-1 items-center gap-1 rounded-lg px-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-500"
        >
          <span className="min-w-0 truncate font-medium text-slate-500 text-[11px]">{label}</span>
          <IconChevronDownSmall
            className={twMerge(
              'size-3.5 shrink-0 text-slate-500 transition-transform duration-150 ease-out motion-reduce:transition-none',
              open ? 'rotate-0' : '-rotate-90'
            )}
            aria-hidden="true"
          />
        </button>
        {action ? (
          <Link
            href={action.href}
            aria-label={action.label}
            title={action.label}
            className="relative flex size-7 shrink-0 items-center justify-center rounded-md text-slate-500 outline-none transition-[color,transform] duration-150 hover:bg-slate-200/60 hover:text-slate-800 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-500 active:scale-[0.96] motion-reduce:transition-none"
          >
            <IconPlusSmall className="size-4" aria-hidden="true" />
          </Link>
        ) : null}
      </div>
      <div id={panelId} hidden={!open} className={open ? 'flex w-full flex-col gap-[1.5px]' : 'hidden'}>
        {open ? children : null}
      </div>
    </div>
  )
}

function NavItem({
  tab,
  active,
  warning,
  notice,
}: {
  tab: SidebarTab
  active: boolean
  warning?: string
  notice?: string
}) {
  const Icon = tab.icon
  const { t } = useI18n()
  const label = t(tab.label)

  return (
    <Link
      href={tab.href}
      aria-current={active ? 'page' : undefined}
      aria-label={warning || notice ? `${label}: ${warning ?? notice}` : label}
      title={warning ?? notice ?? label}
      className={twMerge(
        'group active:scale-[0.98] flex h-8 shrink-0 select-none items-center gap-1.5 rounded-lg outline-none transition-[background-color,color,transform] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-500 motion-reduce:transition-none',
        active ? 'bg-slate-200/60 text-slate-900' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800',
        'w-full pr-1.5 pl-[9px]'
      )}
    >
      <span className="flex size-[16px] shrink-0 items-center justify-center">
        <Icon className="size-[16px] shrink-0" />
      </span>
      <span className="min-w-0 truncate font-medium text-ui">{label}</span>
      {notice ? <span aria-hidden="true" className="ml-auto mr-1 size-2 shrink-0 rounded-full bg-blue-700" /> : null}
      {warning ? (
        <IconExclamationTriangle className="ml-auto size-3.5 shrink-0 text-amber-600" aria-hidden="true" />
      ) : null}
    </Link>
  )
}

function SidebarUpdateButton({ update }: { update: UpdateState }) {
  const local = useLocalBridge()
  const { t } = useI18n()
  const restartLabel = t('Herstart om update{version} te installeren', {
    version: update.version ? ` ${update.version}` : '',
  })

  return (
    <button
      type="button"
      onClick={() => void local.restartToUpdate()}
      disabled={local.updateRestartPending}
      aria-busy={local.updateRestartPending}
      aria-label={restartLabel}
      title={restartLabel}
      className="inline-flex items-center rounded-full bg-blue-700 px-2 py-0.5 text-xs font-medium text-on-brand outline-none transition-opacity duration-150 hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 active:scale-[0.98] disabled:cursor-wait disabled:opacity-90 disabled:transform-none motion-reduce:transition-none"
    >
      <span
        className={twMerge(
          'inline-grid grid-cols-[0px_auto] items-center transition-[grid-template-columns] duration-150 ease-in-out motion-reduce:transition-none',
          local.updateRestartPending && 'grid-cols-[16px_auto]'
        )}
      >
        <span className="min-w-0 overflow-hidden" aria-hidden="true">
          <span className="flex w-4 items-center">
            {local.updateRestartPending ? <Spinner size="xs" className="text-on-brand" /> : null}
          </span>
        </span>
        <span>{t('Update')}</span>
      </span>
    </button>
  )
}
