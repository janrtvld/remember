'use client'

import { useI18n } from '@internal/locales'
import { Button } from '@internal/ui/Button'
import type { AgentInteraction } from '@remember/shared'
import { type FocusEventHandler, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'

export function useAgentWorkerInteractions(workItemId: string) {
  const { t } = useI18n()
  const [requests, setRequests] = useState<AgentInteraction[]>([])
  const [error, setError] = useState('')
  const refreshReader = useRef<(() => Promise<AgentInteraction[]>) | null>(null)

  useEffect(() => {
    let cancelled = false
    let generation = 0
    const refresh = async (reportError = true) => {
      const current = ++generation
      try {
        const items = await window.remember.getAgentInteractions()
        if (cancelled || current !== generation) throw new Error('agent-interaction-read-superseded')
        const scoped = items.filter((item) => item.workItemId === workItemId)
        setRequests(scoped)
        setError('')
        return scoped
      } catch (error) {
        if (reportError && !cancelled && current === generation) setError(t('Vragen konden niet worden geladen.'))
        throw error
      }
    }
    const read = () => refresh(false)
    refreshReader.current = read
    const refreshFromEvent = () => void refresh().catch(() => {})
    const unsubscribe = window.remember.onAgentInteractionsChanged(refreshFromEvent)
    refreshFromEvent()
    return () => {
      cancelled = true
      if (refreshReader.current === read) refreshReader.current = null
      unsubscribe()
    }
  }, [workItemId, t])

  const refresh = async () => {
    const read = refreshReader.current
    if (!read) throw new Error('agent-interaction-read-unavailable')
    return read()
  }
  return { requests, error, refresh }
}

export function AgentWorkerControls({
  requests,
  error,
  onFocusCapture,
  onRefresh,
}: {
  requests: AgentInteraction[]
  error: string
  onFocusCapture?: FocusEventHandler<HTMLDivElement>
  onRefresh: () => Promise<AgentInteraction[]>
}) {
  if (!requests.length && !error) return null
  return (
    <div className="mt-4 space-y-3" onFocusCapture={onFocusCapture}>
      {requests.map((request) => (
        <WorkerRequest key={request.id} request={request} onRefresh={onRefresh} />
      ))}
      {error ? (
        <p role="alert" className="text-danger-700 text-sm">
          {error}
        </p>
      ) : null}
    </div>
  )
}

function WorkerRequest({
  request,
  onRefresh,
}: {
  request: AgentInteraction
  onRefresh: () => Promise<AgentInteraction[]>
}) {
  const { t } = useI18n()
  const [values, setValues] = useState<Record<string, string>>({})
  const [phase, setPhase] = useState<'idle' | 'sending' | 'checking' | 'unknown'>('idle')
  const busy = phase === 'sending' || phase === 'checking'
  const uncertain = phase === 'checking' || phase === 'unknown'
  const [error, setError] = useState('')
  const form = useRef<HTMLFormElement>(null)
  const answerFocus = useRef<HTMLElement | null>(null)
  const checkButton = useRef<HTMLButtonElement>(null)
  const lastAction = useRef<'accept' | 'decline' | null>(null)
  const actionButtons = useRef<Record<'accept' | 'decline', HTMLButtonElement | null>>({ accept: null, decline: null })

  useEffect(() => {
    const clear = () => {
      answerFocus.current = null
    }
    const moved = (event: Event) => {
      if (event.target !== answerFocus.current) clear()
    }
    document.addEventListener('focusin', moved)
    window.addEventListener('blur', clear)
    return () => {
      clear()
      document.removeEventListener('focusin', moved)
      window.removeEventListener('blur', clear)
    }
  }, [])

  useLayoutEffect(() => {
    if (busy) return
    const origin = answerFocus.current
    answerFocus.current = null
    if (!origin) return
    const element =
      phase === 'unknown'
        ? checkButton.current
        : origin.isConnected
          ? origin
          : lastAction.current
            ? actionButtons.current[lastAction.current]
            : null
    const active = document.activeElement
    if (
      element?.isConnected &&
      !element.matches(':disabled') &&
      document.hasFocus() &&
      (active === document.body || active === document.documentElement)
    ) {
      element.focus()
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }, [busy, phase])

  function retainAnswerFocus() {
    const active = document.activeElement
    answerFocus.current =
      document.hasFocus() && active instanceof HTMLElement && form.current?.contains(active) ? active : null
  }

  async function refreshStatus() {
    setPhase('checking')
    setError('')
    try {
      const current = await onRefresh()
      if (current.some((item) => item.id === request.id)) {
        setError(t('Het antwoord kon niet worden verstuurd.'))
        setPhase('idle')
      }
    } catch {
      setError(t('Ontvangst van je antwoord is niet bevestigd.'))
      setPhase('unknown')
    }
  }

  async function answer(action: 'accept' | 'decline') {
    lastAction.current = action
    retainAnswerFocus()
    setPhase('sending')
    setError('')
    try {
      await window.remember.answerAgentInteraction({ id: request.id, action, values })
    } catch {
      await refreshStatus()
    }
  }

  return (
    <form
      ref={form}
      aria-label={t('Vraag van Codex')}
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault()
        void answer('accept')
      }}
      className="space-y-3 border-slate-200 border-t pt-3"
    >
      <p className="font-medium text-slate-800 text-sm">{t(request.title)}</p>
      {request.detail ? <InteractionDetail key={request.detail} detail={request.detail} /> : null}
      {request.url ? (
        <a href={request.url} target="_blank" rel="noreferrer" className="break-all text-brand-700 text-sm underline">
          {request.url}
        </a>
      ) : null}
      {request.fields.map((field) => (
        <label key={field.id} className="block space-y-1 text-slate-700 text-sm">
          <span>{field.label}</span>
          <input
            value={values[field.id] ?? ''}
            type={field.secret ? 'password' : 'text'}
            autoComplete="off"
            required={field.required}
            maxLength={10000}
            list={field.options ? `${request.id}-${field.id}` : undefined}
            onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))}
            className="w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 outline-none focus:border-slate-400"
          />
          {field.options ? (
            <datalist id={`${request.id}-${field.id}`}>
              {field.options.map((option) => (
                <option key={option} value={option} />
              ))}
            </datalist>
          ) : null}
        </label>
      ))}
      {error ? (
        <p role="alert" className={phase === 'unknown' ? 'text-slate-600 text-sm' : 'text-danger-700 text-sm'}>
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {request.actions.map((action) => (
          <Button
            key={action.id}
            ref={(element) => {
              actionButtons.current[action.id] = element
            }}
            type={action.id === 'accept' ? 'submit' : 'button'}
            size="small"
            variant={action.id === 'accept' ? 'outline' : 'text'}
            color="secondary"
            disabled={phase !== 'idle'}
            className="scroll-m-1"
            onClick={action.id === 'decline' ? () => void answer('decline') : undefined}
          >
            {t(action.label)}
          </Button>
        ))}
        {uncertain ? (
          <Button
            ref={checkButton}
            size="small"
            variant="outline"
            color="secondary"
            disabled={busy}
            className="scroll-m-1"
            onClick={() => {
              retainAnswerFocus()
              void refreshStatus()
            }}
          >
            {t('Status controleren')}
          </Button>
        ) : null}
        <span role="status" className="self-center text-slate-500 text-sm">
          {phase === 'checking' ? t('Controleren…') : phase === 'sending' ? t('Versturen…') : ''}
        </span>
      </div>
    </form>
  )
}

function InteractionDetail({ detail }: { detail: string }) {
  const { t } = useI18n()
  const preview = useRef<HTMLPreElement>(null)
  const hintId = useId()
  const [overflow, setOverflow] = useState(false)

  useLayoutEffect(() => {
    const element = preview.current
    if (!element) return
    const measure = () => setOverflow(element.scrollHeight > element.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="space-y-1.5">
      <pre
        ref={preview}
        role={overflow ? 'region' : undefined}
        aria-label={overflow ? t('Details van het verzoek') : undefined}
        aria-describedby={overflow ? hintId : undefined}
        tabIndex={overflow ? 0 : undefined}
        className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-sans text-slate-600 text-sm outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
      >
        {detail}
      </pre>
      {overflow ? (
        <p id={hintId} className="text-slate-500 text-xs">
          {t('Scrol om het volledige verzoek te lezen.')}
        </p>
      ) : null}
    </div>
  )
}
