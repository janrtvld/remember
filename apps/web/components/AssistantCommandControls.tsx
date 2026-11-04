import { useI18n } from '@internal/locales'
import { Button } from '@internal/ui/Button'
import { Spinner } from '@internal/ui/Spinner'
import type { AssistantMessage } from '@remember/shared'

export function AssistantCommandMode({
  value,
  disabled,
  onChange,
}: {
  value: 'question' | 'command'
  disabled: boolean
  onChange: (mode: 'question' | 'command') => void
}) {
  const { t } = useI18n()

  return (
    <fieldset disabled={disabled} className="app-no-drag">
      <legend className="sr-only">{t('Vraag of opdracht')}</legend>
      <div className="inline-flex rounded-md bg-slate-100 p-0.5">
        {(['question', 'command'] as const).map((mode) => (
          <label
            key={mode}
            className="relative cursor-pointer select-none before:absolute before:-inset-y-1.5 before:inset-x-0 before:content-['']"
          >
            <input
              type="radio"
              name="assistant-mode"
              value={mode}
              checked={value === mode}
              onChange={() => onChange(mode)}
              className="peer sr-only"
            />
            <span className="flex h-7 items-center whitespace-nowrap rounded-[5px] px-2.5 font-medium text-slate-600 text-sm outline-none transition-[background-color,color,box-shadow,transform] duration-150 ease-out peer-checked:bg-selected peer-checked:text-slate-900 peer-checked:shadow-raised peer-focus-visible:ring-2 peer-focus-visible:ring-slate-400 active:scale-[0.96] peer-disabled:cursor-wait peer-disabled:text-slate-400 motion-reduce:transition-none">
              {mode === 'question' ? t('Vraag') : t('Opdracht op Mini')}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

export function AssistantCommandStatus({
  command,
  unified,
  pending,
  error,
  onStop,
  onFocus,
}: {
  command: NonNullable<AssistantMessage['command']>
  unified?: boolean
  pending: boolean
  error?: string
  onStop: () => void
  onFocus: (element: HTMLButtonElement) => void
}) {
  const { t } = useI18n()
  if (command.state === 'completed') return null

  const terminal = ['stopped', 'cancelled'].includes(command.state)
  const status = {
    reserved: t('Klaargezet, nog niet gestart.'),
    dispatching: t('Start nog niet bevestigd. Er wordt niets opnieuw gestart.'),
    running: t('Agent is bezig'),
    unknown: t('Uitkomst onbekend. Niet opnieuw gestart.'),
    completed: t('Opdracht afgerond.'),
    stopped: t('Gestopt'),
    cancelled: t('Niet gestart.'),
  }[command.state]

  return (
    <div className="mt-3 text-slate-500 text-sm">
      {!unified ? (
        <p className="mb-1 break-words text-xs">{t('Opdracht op {computer}', { computer: command.targetLabel })}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <p role="status" className="flex min-h-5 items-center gap-2">
          {command.state === 'running' && !command.stopRequested ? <Spinner size="xs" /> : null}
          <span>
            {!terminal && command.state !== 'unknown' && command.stopRequested
              ? t('Stoppen is nog niet bevestigd.')
              : status}
          </span>
        </p>
        {!unified && !terminal && command.canStop ? (
          <Button
            size="small"
            variant="text"
            color="secondary"
            disabled={pending}
            onClick={onStop}
            onFocus={(event) => onFocus(event.currentTarget)}
          >
            {t('Stoppen')}
          </Button>
        ) : null}
      </div>
      {error && !terminal && !command.stopRequested ? (
        <p role="alert" className="mt-1 text-danger-700">
          {error}
        </p>
      ) : null}
    </div>
  )
}
