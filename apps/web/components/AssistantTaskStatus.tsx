'use client'

import { Button } from '@internal/ui/Button'
import { Spinner } from '@internal/ui/Spinner'
import type { AssistantTaskAction } from '@remember/shared'

export function AssistantTaskStatus({
  action,
  hasCurrentReview,
  pending,
  error,
  onControl,
  onFocus,
  t,
}: {
  action: AssistantTaskAction
  hasCurrentReview: boolean
  pending: boolean
  error?: string
  onControl: (command: 'check' | 'stop' | 'cancel') => void
  onFocus: (element: HTMLButtonElement) => void
  t: (text: string) => string
}) {
  const { state, connection, issue } = action
  const terminal = ['cancelled', 'completed', 'stopped'].includes(state)
  const checking = connection === 'connecting' && !terminal
  const working = state === 'running' && connection === 'connected'
  let label = t('De status van deze opdracht is nog niet bevestigd.')
  if (state === 'prepared') label = t('Klaargezet, nog niet gestart.')
  else if (state === 'cancelled') label = t('Niet gestart.')
  else if (state === 'claimed-unknown')
    label = t('Uitkomst van de wijziging is onbekend. Er wordt niets opnieuw uitgevoerd.')
  else if (state === 'withheld') label = t('Resultaat nog niet beschikbaar. Controleer de status.')
  else if (state === 'completed') label = t('Opdracht afgerond.')
  else if (state === 'stopped')
    label = issue?.includes('request-expired')
      ? t('Gestopt: wachttijd verlopen.')
      : issue?.includes('context-invalidated')
        ? t('Gestopt: informatie of toegang gewijzigd.')
        : t('Gestopt')
  else if (checking) label = t('Verbinding maken…')
  else if (connection === 'disconnected') label = t('Verbinding onderbroken. Status nog niet gecontroleerd.')
  else if (state === 'waiting') label = hasCurrentReview ? t('Wacht op je akkoord.') : t('Wacht op Remember.')
  else if (working) label = t('Werkt op je agentcomputer.')

  return (
    <div data-task-action={action.actionId} data-task-message={action.messageId} className="mt-3 text-sm">
      <div className="flex min-h-5 flex-wrap items-center gap-2 text-slate-500">
        <span role="status" className="flex min-w-0 items-center gap-2">
          {checking || working ? <Spinner size="xs" /> : null}
          <span>{label}</span>
        </span>
        {action.allowedControls.map((command) => (
          <Button
            key={command}
            size="small"
            variant="text"
            color="secondary"
            disabled={pending}
            aria-busy={pending}
            onFocus={(event) => onFocus(event.currentTarget)}
            onClick={() => onControl(command)}
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
    </div>
  )
}
