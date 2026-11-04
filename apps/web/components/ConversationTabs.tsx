'use client'

import { useLocalBridge } from '@internal/context/LocalBridgeProvider'
import { useI18n } from '@internal/locales'
import Link from 'next/link'
import { type KeyboardEvent, useRef } from 'react'

export type ConversationTab = 'all' | 'recognized' | 'activity' | 'notes'

const tabHref: Record<ConversationTab, string> = {
  all: '/conversations/',
  recognized: '/conversations/recognized/',
  activity: '/conversations/activity/',
  notes: '/notes/',
}

export function ConversationTabs({ active }: { active: ConversationTab }) {
  const local = useLocalBridge()
  const { t } = useI18n()
  const tabRefs = useRef(new Map<ConversationTab, HTMLAnchorElement>())
  const alwaysOnEnabled = local.settings?.audioCaptureEnabled === true
  const visibleActive = active === 'recognized' && !alwaysOnEnabled ? 'all' : active
  const recognizedCount = local.days.reduce((count, day) => count + (day.conversationCandidates?.length ?? 0), 0)
  const tabs: Array<{ id: ConversationTab; label: string }> = [
    { id: 'all', label: t('Alle') },
    { id: 'recognized', label: t('Herkend') },
    { id: 'activity', label: t('Audioactiviteit') },
    { id: 'notes', label: t('Notities') },
  ]

  const availableTabs = tabs.filter((tab) => tab.id !== 'recognized' || alwaysOnEnabled)

  const handleKeyDown = (event: KeyboardEvent<HTMLAnchorElement>, tab: ConversationTab) => {
    const currentIndex = availableTabs.findIndex((item) => item.id === tab)
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % availableTabs.length
    if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + availableTabs.length) % availableTabs.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = availableTabs.length - 1
    if (nextIndex == null) return

    event.preventDefault()
    tabRefs.current.get(availableTabs[nextIndex].id)?.click()
  }

  return (
    <nav
      className="-mx-0.5 -mt-2 overflow-x-auto border-slate-200 border-b [scrollbar-width:none]"
      aria-label={t('Gespreksweergaven')}
    >
      <div className="flex w-max min-w-full gap-5" role="tablist" aria-label={t('Gespreksweergaven')}>
        {availableTabs.map((tab) => {
          const selected = visibleActive === tab.id
          return (
            <Link
              key={tab.id}
              href={tabHref[tab.id]}
              ref={(element) => {
                if (element) tabRefs.current.set(tab.id, element)
                else tabRefs.current.delete(tab.id)
              }}
              id={`conversation-${tab.id}-tab`}
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onKeyDown={(event) => handleKeyDown(event, tab.id)}
              className={`relative min-h-8 shrink-0 px-0.5 font-medium text-ui outline-none transition-[color,transform] duration-150 ease-out after:pointer-events-none after:absolute after:inset-x-0.5 after:-bottom-px after:h-[2.5px] after:rounded-full after:transition-colors after:duration-150 after:content-[''] hover:text-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 active:scale-[0.96] motion-reduce:transition-none motion-reduce:after:transition-none ${
                selected ? 'text-slate-900 after:bg-blue-700' : 'text-slate-500 after:bg-transparent'
              }`}
            >
              <span className={`relative inline-block ${tab.id === 'recognized' && recognizedCount > 0 ? 'pr-7' : ''}`}>
                {tab.label}
                {tab.id === 'recognized' && recognizedCount > 0 ? (
                  <span className="absolute top-1/2 right-0 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-full bg-slate-100 font-semibold text-[11px] text-slate-700 leading-none tabular-nums">
                    {recognizedCount}
                  </span>
                ) : null}
              </span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
