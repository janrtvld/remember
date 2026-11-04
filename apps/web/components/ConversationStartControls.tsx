'use client'

import { useLocalBridge } from '@internal/context/LocalBridgeProvider'
import { useI18n } from '@internal/locales'
import { Button } from '@internal/ui/Button'
import { Spinner } from '@internal/ui/Spinner'
import { Plus as IconPlusSmall } from 'lucide-react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import {
  conversationSpaceContext,
  saveManualMeetingSpaceContext,
  withConversationSpaceContext,
} from './conversationSpaceContext'

type MeetingRecovery = 'restart' | 'accessibility' | 'system-audio' | null

export function useConversationStartControls() {
  const local = useLocalBridge()
  const { t } = useI18n()
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recovery, setRecovery] = useState<MeetingRecovery>(null)
  const manualMeetingActive = local.state?.manualMeeting?.status === 'recording'
  const canStart = local.ready && Boolean(local.bridge) && !local.state?.manualMeeting
  const router = useRouter()
  const inWorkspace = usePathname().replace(/\/$/, '') === '/conversations/live'
  const searchParams = useSearchParams()
  const startRequested = searchParams.get('start') === '1'
  const consumedStart = useRef(false)

  useEffect(() => {
    if (!startRequested) {
      consumedStart.current = false
      return
    }
    if (consumedStart.current || !local.ready || !local.state || !local.settings) return
    consumedStart.current = true
    if (!inWorkspace) {
      router.replace(
        withConversationSpaceContext('/conversations/live/?start=1', conversationSpaceContext(searchParams))
      )
      return
    }
    if (manualMeetingActive) {
      router.replace(withConversationSpaceContext('/conversations/live/', conversationSpaceContext(searchParams)))
    } else {
      void start()
    }
  })

  async function start() {
    if (starting || !canStart || !local.bridge) return
    if (!inWorkspace) {
      router.push(withConversationSpaceContext('/conversations/live/?start=1', conversationSpaceContext(searchParams)))
      return
    }
    const bridge = local.bridge
    setStarting(true)
    setError(null)
    setRecovery(null)
    try {
      let captureState = local.state
      if (!captureState) throw new Error('capture-state-unavailable')
      if (!captureState.modelDownloaded) {
        captureState = await bridge.prepareModel()
        local.acceptState(captureState)
      }
      if (!captureState.modelDownloaded) throw new Error(captureState.error ?? 'model-required')
      if (captureState.microphonePermission === 'not-determined') {
        captureState = await bridge.requestMicrophonePermission()
        local.acceptState(captureState)
      }
      if (captureState.restartRequired) throw new Error('permissions-restart-required')
      if (captureState.microphonePermission !== 'granted') {
        await bridge.openMicrophoneSettings()
        throw new Error('microphone-permission')
      }
      const next = await bridge.startManualMeeting()
      local.acceptState(next)
      if (next.manualMeeting?.status !== 'recording') throw new Error(next.error ?? 'manual-meeting-not-started')
      const context = conversationSpaceContext(searchParams)
      if (context && local.wikiOverview?.spaces.some((space) => space.id === context.spaceId)) {
        saveManualMeetingSpaceContext(next.manualMeeting.id, context)
      }
    } catch (caughtError) {
      const errorCode =
        caughtError instanceof Error
          ? caughtError.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
          : null
      if (errorCode === 'microphone-permission') {
        setError(t('Geef Remember microfoontoegang in Systeeminstellingen om gesprekken vast te leggen.'))
      } else if (errorCode === 'system-audio-unavailable' || errorCode === 'manual-meeting-system-audio-not-ready') {
        setRecovery('system-audio')
        setError(
          t('Systeemaudio kon niet starten. Probeer opnieuw; controleer de macOS-toegang als dit blijft gebeuren.')
        )
      } else if (errorCode === 'permissions-restart-required') {
        setRecovery('restart')
        setError(t('Herstart Remember één keer om de nieuwe microfoontoegang te gebruiken.'))
      } else if (errorCode === 'accessibility-permission') {
        setRecovery('accessibility')
        setError(t('Geef Remember toegankelijkheidstoegang om een meeting op je scherm te herkennen.'))
      } else if (errorCode === 'context-capture-unavailable') {
        setRecovery('restart')
        setError(t('De schermcontextmodule kon niet starten. Herstart Remember en probeer het opnieuw.'))
      } else if (
        errorCode === 'model-required' ||
        errorCode === 'model-download-failed' ||
        errorCode === 'model-download-offline'
      ) {
        setError(t('Het audiomodel kon niet worden gedownload of gestart.'))
      } else if (errorCode === 'manual-meeting-audio-not-ready') {
        setError(t('De audiostream werd niet actief. Er is geen opname gestart; probeer het opnieuw.'))
      } else if (errorCode === 'manual-meeting-microphone-not-ready') {
        setError(t('De microfoonstream werd niet actief. Er is geen opname gestart; probeer het opnieuw.'))
      } else {
        setError(t('De opname kon niet starten. Controleer de microfoon- en systeemaudiotoegang.'))
      }
    } finally {
      if (startRequested) {
        router.replace(withConversationSpaceContext('/conversations/live/', conversationSpaceContext(searchParams)))
      }
      setStarting(false)
    }
  }

  const regularAction = canStart ? (
    <Button
      size="small"
      variant="outline"
      color="secondary"
      disabled={starting}
      aria-busy={starting}
      onClick={() => void start()}
    >
      {starting ? <Spinner size="xs" /> : <IconPlusSmall className="size-4" aria-hidden="true" />}
      {starting ? t('Starten…') : t('Start gesprek')}
    </Button>
  ) : null

  const action = manualMeetingActive ? (
    <Button size="small" variant="outline" color="secondary" onClick={() => router.push('/conversations/live/')}>
      Terug naar opname
    </Button>
  ) : (
    regularAction
  )

  const feedback = error ? (
    <div className="flex flex-wrap items-center gap-3" role="alert">
      <p className="text-danger-700 text-xs">{error}</p>
      {recovery === 'restart' ? (
        <Button size="small" variant="outline" color="secondary" onClick={() => void local.bridge?.restartApp()}>
          {t('Herstart Remember')}
        </Button>
      ) : null}
      {recovery === 'accessibility' ? (
        <Button
          size="small"
          variant="outline"
          color="secondary"
          onClick={() => local.bridge?.showAccessibilityPermissionGuide()}
        >
          {t('Open uitleg')}
        </Button>
      ) : null}
      {recovery === 'system-audio' ? (
        <Button
          size="small"
          variant="outline"
          color="secondary"
          onClick={() => void local.bridge?.openSystemAudioSettings()}
        >
          {t('Open instellingen')}
        </Button>
      ) : null}
    </div>
  ) : null

  return { action, feedback, canStart, starting: starting || startRequested, start }
}
