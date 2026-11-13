'use client'

import { useI18n } from '@internal/locales'
import { Button } from '@internal/ui/Button'
import { Spinner } from '@internal/ui/Spinner'
import { Switch } from '@internal/ui/Switch'
import type { ContextImportPreview, ContextImportResult, RememberBridge } from '@remember/shared'
import { Check } from 'lucide-react'
import { useEffect, useState } from 'react'
import { SetupButton } from './SetupButton'

export function SetupContextImport({ bridge, onRefresh }: { bridge: RememberBridge; onRefresh: () => Promise<void> }) {
  const { t } = useI18n()
  const [preview, setPreview] = useState<ContextImportPreview | null>(null)
  const [result, setResult] = useState<ContextImportResult | null>(null)
  const [keepLearning, setKeepLearning] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'importing' | 'finishing'>('idle')
  const [error, setError] = useState<string | null>(null)
  const busy = phase !== 'idle'

  useEffect(() => {
    let active = true
    void bridge
      .getContextImportPreview()
      .then((next) => {
        if (active) setPreview(next)
      })
      .catch(() => {
        if (active) {
          setPreview({ providers: [] })
          setError(t('Bestaande agentcontext kon niet worden gevonden. Je kunt deze stap overslaan.'))
        }
      })
    return () => {
      active = false
    }
  }, [bridge, t])

  async function importContext() {
    if (busy) return
    setPhase('importing')
    setError(null)
    try {
      setResult(await bridge.importAgentContext())
    } catch {
      setError(t('Je Wiki kon niet worden opgebouwd. Probeer het opnieuw of sla deze stap over.'))
    } finally {
      setPhase('idle')
    }
  }

  async function finish() {
    if (busy) return
    setPhase('finishing')
    setError(null)
    try {
      await bridge.updateSettings({ contextImportOnboardingCompleted: true, agentLearningEnabled: keepLearning })
      await onRefresh()
    } catch {
      setError(t('De keuze kon niet worden opgeslagen. Probeer het opnieuw.'))
      setPhase('idle')
    }
  }

  const sources = preview?.providers.filter((provider) => provider.available) ?? []
  const canImport = sources.length > 0 && !result
  const changedPages = result ? result.createdPages.length + result.updatedPages.length : 0

  return (
    <div className="mt-6 grid w-full max-w-sm gap-5">
      <ul className="divide-y divide-black/6 border-black/6 border-y" aria-busy={!preview || phase === 'importing'}>
        {!preview ? (
          <li className="flex min-h-10 items-center">
            <Spinner size="sm" label={t('Context zoeken…')} />
          </li>
        ) : !sources.length ? (
          <li className="flex min-h-10 items-center text-slate-500 text-ui">
            {t('Geen bestaande Codex- of Claude-context gevonden.')}
          </li>
        ) : (
          sources.map((source) => (
            <li key={source.provider} className="grid min-h-10 grid-cols-[minmax(0,1fr)_auto_16px] items-center gap-3">
              <span className="truncate font-medium text-slate-900 text-ui">
                {source.provider === 'codex' ? 'Codex' : 'Claude Code'}
              </span>
              <span className="text-slate-500 text-xs tabular-nums">
                {t('{projects} projecten · {sessions} recente sessies', {
                  projects: source.projectCount,
                  sessions: source.sessionCount,
                })}
              </span>
              <span className="flex size-4 items-center justify-center" aria-hidden="true">
                {result ? (
                  <Check className="size-4 text-blue-700 transition-[opacity,scale] duration-200 ease-out starting:scale-75 starting:opacity-0 motion-reduce:transition-none" />
                ) : null}
              </span>
            </li>
          ))
        )}
      </ul>

      <div className="-my-1.5 flex items-center justify-between gap-6">
        <label htmlFor="setup-keep-learning" className="min-w-0 font-medium text-slate-700 text-sm">
          {t('Blijf leren van nieuwe agentgesprekken')}
        </label>
        <Switch
          id="setup-keep-learning"
          size="small"
          checked={keepLearning}
          onChange={setKeepLearning}
          disabled={busy}
        />
      </div>

      {error ? (
        <p role="alert" className="text-danger-700 text-sm">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {canImport ? (
          <>
            <SetupButton
              size="small"
              pending={phase === 'importing'}
              disabled={busy}
              onClick={() => void importContext()}
            >
              {t('Bouw mijn Wiki')}
            </SetupButton>
            {phase === 'importing' ? null : (
              <Button size="small" variant="text" color="secondary" disabled={busy} onClick={() => void finish()}>
                {t('Sla over')}
              </Button>
            )}
          </>
        ) : (
          <SetupButton
            size="small"
            pending={phase === 'finishing'}
            disabled={busy || !preview}
            onClick={() => void finish()}
          >
            {t('Verder')}
          </SetupButton>
        )}
        <span className="ml-1 text-slate-500 text-xs tabular-nums" aria-live="polite">
          {phase === 'importing'
            ? t('Wiki opbouwen…')
            : result
              ? changedPages === 1
                ? t('1 Wiki-pagina bijgewerkt')
                : changedPages
                  ? t('{count} wiki-pagina’s bijgewerkt', { count: changedPages })
                  : t('Je Wiki was al actueel.')
              : null}
        </span>
      </div>
    </div>
  )
}
