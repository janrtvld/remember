'use client'

import { useI18n } from '@internal/locales'
import { Button } from '@internal/ui/Button'
import type { AgentTurnStep } from '@remember/shared'
import { ChevronRight as IconChevronRight } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import styles from './AssistantProgress.module.css'
import { progressSummary, visibleProgressSteps } from './assistantProgressPresentation'

interface AssistantProgressProps {
  steps?: AgentTurnStep[]
  active: boolean
  startedAt?: number
  hasResponse?: boolean
  label?: string
}

export function AssistantProgress({
  steps = [],
  active,
  startedAt,
  hasResponse = false,
  label,
}: AssistantProgressProps) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const panelId = useId()
  const details = visibleProgressSteps(steps)
  const latest = details.findLast((step) => step.kind === 'reasoning') ?? (active ? details.at(-1) : undefined)
  const summary = label
    ? label
    : latest
      ? latest.kind === 'reasoning'
        ? progressSummary(latest.text)
        : t(latest.text)
      : !active
        ? t('Werkstappen')
        : hasResponse
          ? t('Antwoord schrijven…')
          : t('Opdracht uitvoeren…')

  if (!active && !details.length && !label) return null

  const content = (
    <>
      <span className={`min-w-0 truncate text-left ${active ? styles.thinking : ''}`} data-assistant-progress-summary>
        {summary}
      </span>
      {active ? <ElapsedTime startedAt={startedAt} /> : null}
      {details.length ? (
        <IconChevronRight
          aria-hidden="true"
          className={`size-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none ${expanded ? 'rotate-90' : ''}`}
        />
      ) : null}
    </>
  )

  return (
    <div
      className="relative mb-3 min-w-0 text-slate-500 text-sm"
      data-assistant-progress={active ? 'active' : 'idle'}
      data-active={active}
    >
      <span role="status" className="sr-only">
        {active ? t('Agent is bezig') : ''}
      </span>
      {details.length ? (
        <Button
          size="small"
          variant="text"
          color="secondary"
          className="max-w-full min-w-0 items-center justify-start gap-2 px-0 font-normal text-sm text-slate-500 active:scale-100"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => setExpanded((value) => !value)}
        >
          {content}
        </Button>
      ) : (
        <div className="flex h-8 w-fit max-w-full min-w-0 items-center gap-2">{content}</div>
      )}
      {expanded && details.length ? (
        <ol id={panelId} className="mt-1 mb-2 space-y-2 border-slate-200 border-l-[0.5px] pl-4 text-sm leading-5">
          {details.map((step) => (
            <li key={step.id} className="whitespace-pre-wrap wrap-anywhere">
              {step.kind === 'reasoning' ? step.text : t(step.text)}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  )
}

function ElapsedTime({ startedAt }: { startedAt?: number }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const elapsed = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0
  const value = elapsed >= 60 ? `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}` : `${elapsed}s`

  return (
    <span className="w-[5ch] shrink-0 text-right text-xs tabular-nums" aria-hidden="true">
      {elapsed >= 3 ? value : ''}
    </span>
  )
}
