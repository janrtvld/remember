'use client'

import { useI18n } from '@internal/locales'
import { IconButton } from '@internal/ui/IconButton'
import { Check as IconCheckmark1Small, Copy as IconSquareBehindSquare1 } from 'lucide-react'
import { isValidElement, type ReactNode, useState } from 'react'

export function AssistantCodeBlock({ children }: { children?: ReactNode }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState(false)
  const code = isValidElement<{ className?: string; children?: ReactNode }>(children) ? children : null
  const language = code?.props.className?.replace(/^language-/, '')
  const text = typeof code?.props.children === 'string' ? code.props.children : ''
  return (
    <div className="not-prose my-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="flex min-h-10 items-center justify-between px-3 text-slate-500 text-sm">
        <span>{language}</span>
        {text ? (
          <IconButton
            size="compact"
            aria-label={copied ? t('Gekopieerd') : t('Kopiëren')}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(text)
                setCopied(true)
                setError(false)
              } catch {
                setError(true)
              }
            }}
          >
            {copied ? <IconCheckmark1Small className="size-4" /> : <IconSquareBehindSquare1 className="size-4" />}
          </IconButton>
        ) : null}
      </div>
      <pre className="m-0 overflow-x-auto bg-transparent px-3 pb-4 font-mono text-sm text-slate-900 leading-6 [&_code]:bg-transparent [&_code]:p-0 [&_code]:font-normal [&_code]:text-inherit">
        {children}
      </pre>
      {error ? (
        <p role="alert" className="px-3 pb-3 text-danger-700 text-sm">
          {t('Kopiëren is niet gelukt. Probeer opnieuw.')}
        </p>
      ) : null}
    </div>
  )
}
