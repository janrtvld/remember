'use client'

import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react'
import { useLocalBridge } from '@internal/context/LocalBridgeProvider'
import { useI18n } from '@internal/locales'
import { Button } from '@internal/ui/Button'
import type { AssistantBriefingAction, AssistantBriefingGrantPreview, AssistantConversation } from '@remember/shared'
import { useLayoutEffect, useRef, useState } from 'react'
import { MarkdownContent } from './MarkdownContent'

export function AssistantBriefingGrant({
  conversation,
  onChanged,
}: {
  conversation: AssistantConversation
  onChanged(value: AssistantConversation): void
}) {
  const { bridge } = useLocalBridge()
  const { t } = useI18n()
  const [preview, setPreview] = useState<AssistantBriefingGrantPreview | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const lock = useRef(false)
  const grant = conversation.briefingGrant

  async function run(command: 'preview' | 'confirm' | 'revoke') {
    if (!bridge || lock.current) return
    lock.current = true
    setPending(true)
    setError('')
    try {
      if (command === 'preview' && bridge.previewAssistantBriefingGrant) {
        setPreview(await bridge.previewAssistantBriefingGrant())
      } else if (command === 'confirm' && preview && bridge.confirmAssistantBriefingGrant) {
        onChanged(await bridge.confirmAssistantBriefingGrant(preview.token))
        setPreview(null)
      } else if (command === 'revoke' && grant && bridge.revokeAssistantBriefingGrant) {
        onChanged(await bridge.revokeAssistantBriefingGrant(grant.id))
      }
    } catch {
      setError(t('De toestemming kon niet worden opgeslagen. Probeer opnieuw.'))
    } finally {
      lock.current = false
      setPending(false)
    }
  }

  return (
    <div className="app-no-drag">
      <Button
        size="small"
        variant="text"
        color="secondary"
        disabled={pending}
        aria-busy={pending}
        onClick={() => void run(grant ? 'revoke' : 'preview')}
      >
        {t(grant ? 'Voorwerk pauzeren' : 'Privévoorwerk toestaan')}
      </Button>
      {error && !preview ? (
        <p role="alert" className="mt-1 max-w-64 text-danger-700 text-xs">
          {error}
        </p>
      ) : null}
      <Dialog open={preview !== null} onClose={() => setPreview(null)} className="app-no-drag relative z-50">
        <DialogBackdrop className="fixed inset-0 bg-modal-backdrop backdrop-blur-[1px]" />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <DialogPanel className="w-full max-w-lg rounded-xl bg-white p-5 shadow-raised">
            <DialogTitle className="font-semibold text-md text-slate-950">{t('Privévoorwerk toestaan')}</DialogTitle>
            <p className="mt-3 text-slate-700 text-sm leading-6">
              {t('Je agent mag zelf maximaal twee privébriefings maken op {computer}, gedurende 30 minuten.', {
                computer: preview?.targetLabel ?? '',
              })}
            </p>
            <dl className="mt-3 space-y-1 text-sm text-slate-600">
              {preview?.screenAppLabel ? (
                <div>
                  <dt className="inline">{t('Schermapp')}: </dt>
                  <dd className="inline">{preview.screenAppLabel}</dd>
                </div>
              ) : null}
              <div>
                <dt className="inline">{t('Context')}: </dt>
                <dd className="inline">{preview?.projectLabel}</dd>
              </div>
              <div>
                <dt className="inline">Personal: </dt>
                <dd className="inline">
                  {preview?.sourceTitle} <span className="text-slate-500">({preview?.sourceSlug})</span>
                </dd>
              </div>
            </dl>
            <p className="mt-3 text-slate-500 text-sm">
              {t('Elk concept verschijnt hier. Je kunt het voorwerk op elk moment stoppen.')}
            </p>
            {error ? (
              <p role="alert" className="mt-3 text-danger-700 text-sm">
                {error}
              </p>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <Button size="small" variant="text" color="secondary" onClick={() => setPreview(null)}>
                {t('Annuleren')}
              </Button>
              <Button size="small" disabled={pending} aria-busy={pending} onClick={() => void run('confirm')}>
                {t('Toestaan')}
              </Button>
            </div>
          </DialogPanel>
        </div>
      </Dialog>
    </div>
  )
}

export function AssistantBriefingStatus({
  action,
  onChanged,
}: {
  action: AssistantBriefingAction
  onChanged(value: AssistantConversation): void
}) {
  const { bridge } = useLocalBridge()
  const { t } = useI18n()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ key: string; title: string; content: string } | null>(null)
  const lock = useRef(false)
  const resultKey = action.result ? JSON.stringify([action.actionId, action.messageId, action.result.id]) : null
  const resultLifetime = useRef({ key: resultKey, generation: 0, mounted: false })
  const visibleResult = result?.key === resultKey ? result : null

  useLayoutEffect(() => {
    resultLifetime.current = {
      key: resultKey,
      generation: resultLifetime.current.generation + 1,
      mounted: true,
    }
    setResult(null)
    return () => {
      resultLifetime.current.mounted = false
      resultLifetime.current.generation += 1
    }
  }, [resultKey])

  function closeResult() {
    resultLifetime.current.generation += 1
    setResult(null)
  }
  const labels = {
    prepared: 'Klaargezet, nog niet gestart.',
    running: 'Maakt een privébriefing op je agentcomputer.',
    waiting: 'Controleert de informatie voor het opslaan.',
    unknown: 'De uitkomst is nog niet bevestigd. Er wordt niets opnieuw uitgevoerd.',
    withheld: 'Resultaat nog niet beschikbaar. Controleer de status.',
    cancelled: 'Niet gestart.',
    completed: action.result ? 'Privébriefing klaar.' : 'Geen briefing nodig.',
    stopped: 'Gestopt',
  }
  async function run(command: 'check' | 'stop' | 'cancel' | 'open') {
    if (!bridge || lock.current) return
    lock.current = true
    setPending(true)
    setError('')
    try {
      const identity = { actionId: action.actionId, messageId: action.messageId }
      if (command === 'open' && action.result && bridge.openAssistantBriefing) {
        const lifetime = { ...resultLifetime.current }
        const opened = await bridge.openAssistantBriefing({ ...identity, resultId: action.result.id })
        const current = resultLifetime.current
        if (
          current.mounted &&
          current.key &&
          current.key === lifetime.key &&
          current.generation === lifetime.generation
        ) {
          setResult({ ...opened, key: current.key })
        }
      } else if (command !== 'open' && action.allowedControls.includes(command) && bridge.controlAssistantBriefing) {
        onChanged(await bridge.controlAssistantBriefing({ ...identity, command }))
      }
    } catch {
      setError(
        t(
          command === 'stop'
            ? 'Stoppen is nog niet bevestigd.'
            : command === 'open'
              ? 'Het concept kon niet worden geopend.'
              : 'De status kon niet worden gecontroleerd. Probeer opnieuw.'
        )
      )
    } finally {
      lock.current = false
      setPending(false)
    }
  }

  return (
    <div data-briefing-action={action.actionId} data-briefing-message={action.messageId} className="mt-3 text-sm">
      <div className="flex min-h-5 flex-wrap items-center gap-2 text-slate-500">
        <span role="status">{t(labels[action.state])}</span>
        {action.result ? (
          <Button size="small" variant="text" color="secondary" disabled={pending} onClick={() => void run('open')}>
            {t('Concept openen')}
          </Button>
        ) : null}
        {action.allowedControls.map((command) => (
          <Button
            key={command}
            size="small"
            variant="text"
            color="secondary"
            disabled={pending}
            aria-busy={pending}
            onClick={() => void run(command)}
          >
            {t(command === 'check' ? 'Status controleren' : command === 'cancel' ? 'Niet starten' : 'Stoppen')}
          </Button>
        ))}
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-danger-700">
          {error}
        </p>
      ) : null}
      <Dialog open={visibleResult !== null} onClose={closeResult} className="app-no-drag relative z-50">
        <DialogBackdrop className="fixed inset-0 bg-modal-backdrop backdrop-blur-[1px]" />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <DialogPanel className="flex max-h-[calc(100vh-2rem)] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-raised">
            <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3">
              <DialogTitle className="min-w-0 truncate font-semibold text-md text-slate-950">
                {visibleResult?.title}
              </DialogTitle>
              <Button size="small" variant="text" color="secondary" onClick={closeResult}>
                {t('Sluiten')}
              </Button>
            </header>
            <div className="min-h-0 overflow-y-auto px-5 py-4">
              <MarkdownContent>{visibleResult?.content ?? ''}</MarkdownContent>
            </div>
          </DialogPanel>
        </div>
      </Dialog>
    </div>
  )
}
