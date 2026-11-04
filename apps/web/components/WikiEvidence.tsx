'use client'

import { useI18n } from '@internal/locales'
import type { WikiSuggestionEvidence } from '@remember/shared'

export function WikiEvidence({ evidence }: { evidence?: WikiSuggestionEvidence[] }) {
  const { t, locale } = useI18n()
  if (!evidence?.length) return null
  return (
    <details className="my-4 text-sm">
      <summary className="cursor-pointer font-medium text-slate-600 focus-visible:outline-2">
        {t('Waarom Remember dit heeft geleerd')}
      </summary>
      <ul className="mt-3 grid gap-4">
        {evidence.map((source) => (
          <li key={`${source.sourceId}:${source.quote}`}>
            <p className="mb-1 text-slate-500 text-xs">
              {source.provider === 'codex' ? 'Codex' : source.provider === 'claude' ? 'Claude' : t('Bron')}
              {source.project ? ` · ${source.project.split('/').filter(Boolean).at(-1)}` : ''}
              {' · '}
              {new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(source.observedAt)}
              {source.role ? ` · ${source.role === 'user' ? t('Jouw bericht') : t('Antwoord van de agent')}` : ''}
            </p>
            <blockquote className="whitespace-pre-wrap break-words border-slate-200 border-l-2 pl-3 text-slate-700 text-sm leading-6">
              {source.quote}
            </blockquote>
          </li>
        ))}
      </ul>
    </details>
  )
}
