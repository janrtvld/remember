'use client'

import { useI18n } from '@internal/locales'
import { Button } from '@internal/ui/Button'
import { Spinner } from '@internal/ui/Spinner'
import { Switch } from '@internal/ui/Switch'
import type { ContextImportPreview, RememberBridge } from '@remember/shared'
import { useEffect, useState } from 'react'
import { SetupButton } from './SetupButton'

export function SetupContextImport({ bridge, onRefresh }: { bridge: RememberBridge; onRefresh: () => Promise<void> }) {
  const { t } = useI18n()
  const [preview, setPreview] = useState<ContextImportPreview | null>(null)
  const [keepLearning, setKeepLearning] = useState(false)
  const [pendingAction, setPendingAction] = useState<'build' | 'skip' | null>(null)
  const [error, setError] = useState<string | null>(null)

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

  async function finish(action: 'build' | 'skip') {
    if (pendingAction) return
    setPendingAction(action)
    setError(null)
    // The import keeps running in the main process; the Wiki shows it until it finishes.
    if (action === 'build') void bridge.importAgentContext().catch(() => undefined)
    try {
      await bridge.updateSettings({ contextImportOnboardingCompleted: true, agentLearningEnabled: keepLearning })
      await onRefresh()
    } catch {
      setError(t('De keuze kon niet worden opgeslagen. Probeer het opnieuw.'))
      setPendingAction(null)
    }
  }

  const sources = preview?.providers.filter((provider) => provider.available) ?? []

  return (
    <div className="mt-6 grid w-full max-w-sm gap-5">
      <ul className="divide-y divide-black/6 border-black/6 border-y" aria-busy={!preview}>
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
            <li key={source.provider} className="grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
              <span className="truncate font-medium text-slate-900 text-ui">
                {source.provider === 'codex' ? 'Codex' : 'Claude Code'}
              </span>
              <span className="text-slate-500 text-xs tabular-nums">
                {t('{projects} projecten · {sessions} recente sessies', {
                  projects: source.projectCount,
                  sessions: source.sessionCount,
                })}
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
          disabled={pendingAction !== null}
        />
      </div>

      {error ? (
        <p role="alert" className="text-danger-700 text-sm">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {sources.length ? (
          <>
            <SetupButton
              size="small"
              pending={pendingAction === 'build'}
              disabled={pendingAction !== null}
              onClick={() => void finish('build')}
            >
              {t('Bouw mijn Wiki')}
            </SetupButton>
            <Button
              size="small"
              variant="text"
              color="secondary"
              disabled={pendingAction !== null}
              onClick={() => void finish('skip')}
            >
              {t('Sla over')}
            </Button>
          </>
        ) : (
          <SetupButton
            size="small"
            pending={pendingAction === 'skip'}
            disabled={pendingAction !== null || !preview}
            onClick={() => void finish('skip')}
          >
            {t('Verder')}
          </SetupButton>
        )}
      </div>
    </div>
  )
}
