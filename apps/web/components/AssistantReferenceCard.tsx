'use client'

import { useLocalBridge } from '@internal/context/LocalBridgeProvider'
import { useI18n } from '@internal/locales'
import { Inbox as IconArrowInbox, FileText as IconFileText } from 'lucide-react'
import Link from 'next/link'
import type { ComponentProps, ReactNode } from 'react'
import type { ExtraProps } from 'react-markdown'
import { type AssistantReference, assistantReference } from './assistantReferences'

export function AssistantReferenceCard({
  reference,
  children,
}: {
  reference: AssistantReference
  children: ReactNode
}) {
  const local = useLocalBridge()
  const { t } = useI18n()
  const task = reference.kind === 'task' ? local.workItems.find((item) => item.id === reference.id) : undefined
  const space =
    reference.kind === 'document' ? local.wikiOverview?.spaces.find((item) => item.id === reference.spaceId) : undefined
  const page =
    reference.kind === 'document'
      ? local.wikiBySpace[reference.spaceId]?.find((item) => item.slug === reference.slug)
      : undefined
  const unavailable = reference.kind === 'document' && local.wikiOverview !== null && !space
  const Icon = reference.kind === 'task' ? IconArrowInbox : IconFileText
  const metadata =
    reference.kind === 'task'
      ? [
          t('Taak'),
          task
            ? t(
                task.lifecycle === 'completed'
                  ? 'Afgerond'
                  : task.status === 'in_progress'
                    ? 'In uitvoering'
                    : 'Te doen'
              )
            : null,
        ]
      : reference.kind === 'day'
        ? [t('Dagupdate')]
        : reference.kind === 'note'
          ? [t('Notitie')]
          : [t('Document'), space?.name]
  const content = (
    <>
      <Icon className="size-4 shrink-0 text-slate-500" aria-hidden="true" />
      <span className="min-w-0 break-words text-slate-900 text-ui leading-5">
        {task?.title ?? page?.title ?? children}
      </span>
      {unavailable ? <span className="text-slate-500 text-xs">{t('Niet beschikbaar')}</span> : null}
    </>
  )
  const className =
    'not-prose mr-1.5 mb-1 inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md border border-slate-200 px-2 py-1 align-middle text-left no-underline'
  return unavailable ? (
    <span className={className} data-assistant-reference={reference.kind} title={metadata.filter(Boolean).join(' · ')}>
      {content}
    </span>
  ) : (
    <Link
      href={reference.href}
      data-assistant-reference={reference.kind}
      title={metadata.filter(Boolean).join(' · ')}
      className={`${className} outline-none transition-colors duration-150 hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-slate-400 motion-reduce:transition-none`}
    >
      {content}
    </Link>
  )
}

export function AssistantMarkdownLink({ href, children, node: _node, ...props }: ComponentProps<'a'> & ExtraProps) {
  const reference = assistantReference(href)
  if (reference) return <AssistantReferenceCard reference={reference}>{children}</AssistantReferenceCard>
  if (href?.startsWith('/') && !href.startsWith('//'))
    return (
      <Link {...props} href={href}>
        {children}
      </Link>
    )
  return (
    <a {...props} href={href}>
      {children}
    </a>
  )
}
