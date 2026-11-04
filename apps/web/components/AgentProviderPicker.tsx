import { useI18n } from '@internal/locales'
import type { AgentProvider } from '@remember/shared'

export function AgentProviderPicker({
  value,
  disabled = false,
  name,
  onChange,
}: {
  value: AgentProvider
  disabled?: boolean
  name: string
  onChange: (provider: AgentProvider) => void
}) {
  const { t } = useI18n()

  return (
    <fieldset disabled={disabled} aria-busy={disabled} className="app-no-drag">
      <legend className="sr-only">{t('Kies je agent')}</legend>
      <div className="inline-flex rounded-md bg-slate-100 p-0.5">
        {(['codex', 'claude'] as const).map((provider) => (
          <label
            key={provider}
            className="relative cursor-pointer select-none before:absolute before:-inset-y-1.5 before:inset-x-0 before:content-['']"
          >
            <input
              type="radio"
              aria-label={provider === 'codex' ? 'ChatGPT' : 'Claude'}
              name={name}
              value={provider}
              checked={value === provider}
              onChange={() => onChange(provider)}
              className="peer sr-only"
            />
            <span className="flex h-7 items-center whitespace-nowrap rounded-[5px] px-2.5 font-medium text-slate-600 text-sm outline-none transition-[background-color,color,box-shadow,transform] duration-150 ease-out peer-checked:bg-selected peer-checked:text-slate-900 peer-checked:shadow-raised peer-focus-visible:ring-2 peer-focus-visible:ring-slate-400 active:scale-[0.96] peer-disabled:cursor-wait peer-disabled:text-slate-400 motion-reduce:transition-none">
              {provider === 'codex' ? 'ChatGPT' : 'Claude'}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}
