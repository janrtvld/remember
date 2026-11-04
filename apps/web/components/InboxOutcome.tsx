'use client'

import { Disclosure, DisclosureButton, DisclosurePanel } from '@headlessui/react'
import { useI18n } from '@internal/locales'
import type { WorkItemAgentSession } from '@remember/shared'
import { ChevronRight as IconChevronRight } from 'lucide-react'
import { useState } from 'react'
import { twMerge } from 'tailwind-merge'
import { compactMarkdownContentClassName, MarkdownContent } from './MarkdownContent'

export function InboxOutcome({ title, sessions }: { title: string; sessions: WorkItemAgentSession[] }) {
  const { t, dateLocale } = useI18n()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const versions = sessions.filter((session) => session.status === 'completed' && session.response.trim())
  const latest = versions.at(-1)
  const selected = versions.find((session) => session.id === selectedId) ?? latest
  if (!selected || !latest) return null
  const updatedAt = selected.completedAt ?? selected.updatedAt
  const formatDate = (timestamp: number) =>
    new Date(timestamp).toLocaleString(dateLocale, { dateStyle: 'medium', timeStyle: 'short' })

  return (
    <section aria-label={t('Resultaat')}>
      <header className="mb-5">
        <h1 className="font-semibold text-slate-950 text-xl leading-7 tracking-[-0.02em]">{title}</h1>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-slate-500 text-xs">
          <span>{selected.provider === 'codex' ? 'Codex' : 'Claude'}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={new Date(updatedAt).toISOString()}>{formatDate(updatedAt)}</time>
          {selected.id !== latest.id ? <span>{t('Eerdere versie')}</span> : null}
        </p>
      </header>
      <MarkdownContent
        className={twMerge(
          compactMarkdownContentClassName,
          'break-words prose-h1:text-lg prose-h2:text-sm prose-h3:text-sm prose-pre:text-xs prose-img:my-4 prose-img:rounded-lg prose-img:border prose-img:border-slate-200 [&>p:first-child]:text-slate-900'
        )}
      >
        {selected.response}
      </MarkdownContent>
      {versions.length > 1 ? (
        <Disclosure as="section" className="mt-6 border-slate-100 border-t pt-3">
          <DisclosureButton className="group flex items-center gap-1.5 rounded text-slate-500 text-xs outline-none hover:text-slate-800 focus-visible:ring-2 focus-visible:ring-slate-400">
            <IconChevronRight className="size-3 shrink-0 group-data-open:rotate-90" aria-hidden="true" />
            {t('Versies ({count})', { count: versions.length })}
          </DisclosureButton>
          <DisclosurePanel as="ol" className="mt-3 space-y-1">
            {versions.toReversed().map((version, index) => (
              <li key={version.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(version.id === latest.id ? null : version.id)}
                  aria-current={version.id === selected.id ? 'true' : undefined}
                  className={twMerge(
                    'flex w-full items-baseline justify-between gap-3 rounded-md px-2 py-1.5 text-left text-slate-500 text-xs outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-slate-400',
                    version.id === selected.id && 'bg-slate-100 text-slate-900'
                  )}
                >
                  <span className="min-w-0 truncate">
                    {index === 0 ? t('Huidige versie') : t('Versie {number}', { number: versions.length - index })}
                  </span>
                  <time
                    className="shrink-0 tabular-nums"
                    dateTime={new Date(version.completedAt ?? version.updatedAt).toISOString()}
                  >
                    {formatDate(version.completedAt ?? version.updatedAt)}
                  </time>
                </button>
              </li>
            ))}
          </DisclosurePanel>
        </Disclosure>
      ) : null}
    </section>
  )
}
