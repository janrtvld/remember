'use client'

import { useI18n } from '@internal/locales'
import { Button } from '@internal/ui/Button'
import { PendingIndicator } from '@internal/ui/PendingIndicator'
import type { AgentUsageSummary } from '@remember/shared'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'

function UsageTotal({ value, label }: { value: string; label: string }) {
  const reducedMotion = useReducedMotion()

  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap tabular-nums">
      <span className="sr-only">{label}</span>
      <span aria-hidden="true" className="inline-flex items-center">
        {Array.from(value, (digit, index) => (
          <span
            key={value.length - index}
            className={
              /\d/.test(digit)
                ? 'relative inline-flex h-[1.25em] w-[1ch] items-center justify-center overflow-hidden'
                : 'inline-block'
            }
          >
            {reducedMotion || !/\d/.test(digit) ? (
              digit
            ) : (
              <AnimatePresence initial={false}>
                <motion.span
                  key={digit}
                  initial={{ y: '45%', opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ y: '-45%', opacity: 0 }}
                  transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                  className="absolute inset-0 flex items-center justify-center"
                >
                  {digit}
                </motion.span>
              </AnimatePresence>
            )}
          </span>
        ))}
      </span>
      <span aria-hidden="true" className="text-slate-500">
        tokens
      </span>
    </span>
  )
}

export function AgentUsageSection() {
  const { dateLocale, t } = useI18n()
  const [usage, setUsage] = useState<AgentUsageSummary | null>(null)
  const [error, setError] = useState(false)
  const [period, setPeriod] = useState<'today' | 'week'>('today')
  const activeRef = useRef(true)
  const loadUsage = useCallback(() => {
    return window.remember.getAgentUsage().then(
      (value) => {
        if (!activeRef.current) return
        setUsage(value)
        setError(false)
      },
      () => {
        if (activeRef.current) setError(true)
      }
    )
  }, [])

  useEffect(() => {
    activeRef.current = true
    void loadUsage()
    const interval = window.setInterval(() => void loadUsage(), 30_000)
    return () => {
      activeRef.current = false
      window.clearInterval(interval)
    }
  }, [loadUsage])

  const number = (value: number) => new Intl.NumberFormat(dateLocale).format(value)
  const rows = usage?.providers.filter((entry) => entry[period].inputTokens + entry[period].outputTokens > 0) ?? []
  const total = rows.reduce((sum, entry) => sum + entry[period].inputTokens + entry[period].outputTokens, 0)

  return (
    <li
      aria-labelledby="agent-usage-title"
      className="flex min-h-16 flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-3"
    >
      <h3 id="agent-usage-title" className="text-slate-900 text-sm">
        {t('Gebruik door Remember')}
      </h3>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <div className="flex min-h-7 min-w-[16ch] items-center justify-end text-slate-700">
          {error ? (
            <div className="flex items-center gap-2">
              <p role="alert" className="text-danger-700 text-xs">
                {t('Gebruik niet beschikbaar')}
              </p>
              <Button
                size="small"
                variant="text"
                color="secondary"
                onClick={() => {
                  setError(false)
                  setUsage(null)
                  void loadUsage()
                }}
              >
                {t('Probeer opnieuw')}
              </Button>
            </div>
          ) : usage ? (
            <UsageTotal value={number(total)} label={t('{count} tokens', { count: number(total) })} />
          ) : (
            <PendingIndicator label={t('Gebruik laden')} />
          )}
        </div>
        <fieldset className="app-no-drag shrink-0">
          <legend className="sr-only">{t('Periode voor AI-gebruik')}</legend>
          <div className="inline-flex rounded-md bg-slate-100 p-0.5">
            {(['today', 'week'] as const).map((value) => (
              <label
                key={value}
                className="relative cursor-pointer select-none before:absolute before:-inset-y-2 before:inset-x-0 before:content-['']"
              >
                <input
                  type="radio"
                  name="agent-usage-period"
                  value={value}
                  aria-label={value === 'today' ? t('Vandaag') : t('Laatste 7 dagen')}
                  checked={period === value}
                  onChange={() => setPeriod(value)}
                  className="peer sr-only"
                />
                <span className="flex h-6 items-center whitespace-nowrap rounded-[5px] px-2 font-medium text-slate-500 text-xs outline-none transition-[background-color,color,box-shadow] duration-150 ease-out hover:text-slate-800 peer-checked:bg-selected peer-checked:text-slate-900 peer-checked:shadow-raised peer-focus-visible:ring-2 peer-focus-visible:ring-slate-400 motion-reduce:transition-none">
                  {value === 'today' ? t('Vandaag') : t('Laatste 7 dagen')}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>
    </li>
  )
}
