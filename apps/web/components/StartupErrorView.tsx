'use client'

import { getRememberBridge } from '@internal/lib/rememberBridge'
import { Button } from '@internal/ui/Button'
import type { UpdateState } from '@remember/shared'
import { localeFromLanguageTag } from '@remember/shared'
import { useEffect, useState } from 'react'

type StartupErrorKind = 'archive' | 'data-version' | 'generic'

function updateActionLabel(update: UpdateState | null, text: (dutch: string, english: string) => string) {
  if (!update) return text('Controleer op updates', 'Check for updates')
  if (update.status === 'checking') return text('Controleren…', 'Checking…')
  if (update.status === 'available') return text('Download update', 'Download update')
  if (update.status === 'downloading') {
    const progress = Math.round((update.downloadProgress ?? 0) * 100)
    return text(`Downloaden… ${progress}%`, `Downloading… ${progress}%`)
  }
  if (update.status === 'downloaded') return text('Herstart en installeer', 'Restart and install')
  if (update.status === 'error') return text('Probeer opnieuw', 'Try again')
  return text('Controleer opnieuw', 'Check again')
}

export function StartupErrorView({ kind }: { kind: StartupErrorKind }) {
  const [locale, setLocale] = useState<'en' | 'nl'>('nl')
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [updateUnavailable, setUpdateUnavailable] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [resetFailed, setResetFailed] = useState(false)
  const text = (dutch: string, english: string) => (locale === 'nl' ? dutch : english)

  useEffect(() => {
    setLocale(localeFromLanguageTag(navigator.language))
    const bridge = getRememberBridge()
    void bridge
      .getUpdateState()
      .then(setUpdate)
      .catch(() => setUpdateUnavailable(true))
    return bridge.onUpdateState(setUpdate)
  }, [])

  const runUpdateAction = async () => {
    try {
      const bridge = getRememberBridge()
      if (update?.status === 'available' || (update?.status === 'error' && update.errorStage === 'download')) {
        setUpdate(await bridge.downloadUpdate())
        return
      }
      if (update?.status === 'downloaded') {
        await bridge.restartToUpdate()
        return
      }
      setUpdate(await bridge.checkForUpdate())
    } catch {
      setUpdateUnavailable(true)
    }
  }

  const revealDataFolder = async () => {
    try {
      await getRememberBridge().revealDataFolder()
    } catch {
      setUpdateUnavailable(true)
    }
  }

  const resetAllData = async () => {
    setResetting(true)
    setResetFailed(false)
    try {
      const confirmed = await getRememberBridge().resetAllData()
      if (!confirmed) setResetting(false)
    } catch {
      setResetting(false)
      setResetFailed(true)
    }
  }

  const busy = update?.status === 'checking' || update?.status === 'downloading'
  const noNewerVersion = update?.status === 'up-to-date'

  return (
    <div className="app-drag relative flex h-screen w-screen overflow-hidden bg-canvas">
      <main className="app-no-drag flex flex-1 items-center justify-center px-6 py-14">
        <div className="w-full max-w-sm">
          <h1 className="font-semibold text-slate-950 text-xl">
            {kind === 'archive'
              ? text('Je archief moet worden hersteld', 'Your archive needs recovery')
              : kind === 'data-version'
                ? text('Deze versie kan je gegevens niet openen', 'This version cannot open your data')
                : text('Remember kon niet starten', 'Remember could not start')}
          </h1>
          <p className="mt-2 text-pretty text-slate-500 text-sm leading-6">
            {kind === 'archive'
              ? text(
                  'Remember heeft een beschadigd leeg archief gevonden. Het bestand is niet vervangen en nieuwe opname is niet gestart.',
                  'Remember found a damaged empty archive. The file was not replaced and new capture did not start.'
                )
              : kind === 'data-version'
                ? text(
                    'Je lokale gegevens zijn gemaakt met een nieuwere versie van Remember. Ze zijn niet verwijderd of aangepast.',
                    'Your local data was created by a newer version of Remember. It was not deleted or changed.'
                  )
                : text(
                    'Je lokale gegevens zijn niet verwijderd of aangepast. Installeer de nieuwste versie en probeer het opnieuw.',
                    'Your local data was not deleted or changed. Install the latest version and try again.'
                  )}
          </p>

          {kind === 'archive' ? (
            <Button className="mt-6" variant="outline" color="secondary" onClick={revealDataFolder}>
              {text('Toon gegevensmap', 'Show data folder')}
            </Button>
          ) : !updateUnavailable ? (
            <Button
              className="mt-6"
              variant="outline"
              color="secondary"
              disabled={busy || resetting}
              onClick={runUpdateAction}
            >
              {updateActionLabel(update, text)}
            </Button>
          ) : null}

          {noNewerVersion ? (
            <p className="mt-3 text-slate-500 text-sm" role="status">
              {text(
                'Er is nog geen nieuwere update beschikbaar. Probeer het later opnieuw.',
                'A newer update is not available yet. Try again later.'
              )}
            </p>
          ) : null}
          {kind !== 'archive' && updateUnavailable ? (
            <p className="mt-3 text-slate-500 text-sm" role="status">
              {text(
                'De updatecontrole is niet beschikbaar. Download de nieuwste versie van Remember en installeer die opnieuw.',
                'Update checking is unavailable. Download and reinstall the latest version of Remember.'
              )}
            </p>
          ) : null}

          {kind === 'data-version' ? (
            <div className="mt-6">
              <Button size="small" variant="solid" color="danger" disabled={resetting} onClick={resetAllData}>
                {resetting ? text('Resetten…', 'Resetting…') : text('Reset alle gegevens', 'Reset all data')}
              </Button>
              {resetFailed ? (
                <p className="mt-3 text-danger-700 text-sm" role="alert">
                  {text('Resetten is mislukt. Probeer het opnieuw.', 'Reset failed. Please try again.')}
                </p>
              ) : null}
            </div>
          ) : null}

          <p className="mt-6 font-mono text-slate-400 text-xs">
            {text('Foutcode', 'Error code')}:{' '}
            {kind === 'archive'
              ? 'archive-damaged'
              : kind === 'data-version'
                ? 'data-version-unsupported'
                : 'startup-failed'}
          </p>
        </div>
      </main>
    </div>
  )
}
