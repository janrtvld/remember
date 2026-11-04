'use client'

import { useI18n } from '@internal/locales'
import { Button } from '@internal/ui/Button'
import { Switch } from '@internal/ui/Switch'
import type { AgentProvider, AgentSetup, CaptureState, LocalSettings, RememberBridge } from '@remember/shared'
import { Check as IconCheckmark1Small } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { AgentProviderPicker } from './AgentProviderPicker'
import { agentSetupPresentation } from './agentSetupPresentation'
import { Logo } from './Logo'
import { modelSetupPresentation } from './modelSetupPresentation'
import { SetupButton } from './SetupButton'
import { SetupPrivacy } from './SetupPrivacy'

type SetupStep = {
  id: string
  label: string
  detail: string
  ready: boolean
  action: () => Promise<unknown>
  actionLabel: string
  disabled?: boolean
}

export function SetupState({
  state,
  settings,
  bridge,
  onRefresh,
}: {
  state: CaptureState
  settings: LocalSettings
  bridge: RememberBridge
  onRefresh: () => Promise<void>
}) {
  const { locale, t } = useI18n()
  const [busyStepId, setBusyStepId] = useState<string | null>(null)
  const [stepError, setStepError] = useState<string | null>(null)
  const [setupAgent, setSetupAgent] = useState<AgentSetup | null>(
    state.agent.provider === settings.defaultAgentProvider ? state.agent : null
  )
  const [automaticDayRefresh, setAutomaticDayRefresh] = useState(settings.frequentDayRefresh)
  const modelPresentation = modelSetupPresentation(state, false, locale)
  const selectedCloudProvider = settings.defaultAgentProvider
  const audioCaptureDetail = (() => {
    if (state.microphonePermission === 'not-determined') {
      return t(
        'Neem gesprekken zelf op, of laat Remember continu meeluisteren. Audio wordt lokaal op je Mac getranscribeerd.'
      )
    }
    if (state.microphonePermission === 'denied' || state.microphonePermission === 'restricted') {
      return t('Geef Remember microfoontoegang in Systeeminstellingen om gesprekken vast te leggen.')
    }
    if (state.restartRequired) return t('Herstart Remember één keer om de nieuwe audiomachtigingen te activeren.')
    if (state.systemAudioCheckStatus === 'failed') {
      return t('Systeemaudio kon niet starten. Probeer opnieuw; controleer de macOS-toegang als dit blijft gebeuren.')
    }
    return t(
      'Neem gesprekken zelf op, of laat Remember continu meeluisteren. Audio wordt lokaal op je Mac getranscribeerd.'
    )
  })()
  const audioCaptureActionLabel =
    state.microphonePermission === 'not-determined'
      ? t('Altijd aan')
      : state.microphonePermission !== 'granted'
        ? t('Open instellingen')
        : state.restartRequired
          ? t('Herstart app')
          : state.systemAudioCheckStatus === 'failed'
            ? t('Controleer opnieuw')
            : state.systemAudioCheckStatus === 'checking'
              ? t('Controleren…')
              : state.systemAudioCheckStatus !== 'ready'
                ? t('Controleer toegang')
                : t('Altijd aan')
  const audioCaptureStepReady =
    settings.audioCaptureOnboardingCompleted &&
    state.modelDownloaded &&
    !state.restartRequired &&
    (!settings.audioCaptureEnabled ||
      (state.microphonePermission === 'granted' && state.systemAudioCheckStatus === 'ready'))
  const prepareAudioModel = async () => {
    if (state.modelDownloaded) return
    const nextState = await bridge.prepareModel()
    if (!nextState.modelDownloaded) throw new Error('model-download-failed')
  }
  const steps: SetupStep[] = [
    {
      id: 'privacy',
      label: t('Privacy instellen'),
      detail: t('Kies uit welke apps en websites Remember schermcontext mag vastleggen.'),
      ready: settings.privacyOnboardingCompleted,
      action: async () => {
        await bridge.updateSettings({ privacyOnboardingCompleted: true })
      },
      actionLabel: t('Gebruik standaardinstellingen'),
    },
    {
      id: 'accessibility',
      label: t('Toegankelijkheid'),
      detail: t(
        'Geef Remember toegang tot tekst in je actieve app en venster. Je privacyfilters bepalen wat wordt bewaard.'
      ),
      ready: state.accessibilityPermission === 'granted',
      action: async () => {
        const nextState = await bridge.requestAccessibilityPermission()
        if (nextState.accessibilityPermission !== 'granted') {
          await bridge.showAccessibilityPermissionGuide()
        }
      },
      actionLabel: t('Geef toegang'),
    },
    {
      id: 'audio-capture',
      label: t('Opnamemodus'),
      detail: audioCaptureDetail,
      ready: audioCaptureStepReady,
      action: async () => {
        await bridge.updateSettings({ audioCaptureEnabled: true })
        if (state.microphonePermission === 'not-determined') {
          await bridge.requestMicrophonePermission()
          return
        }
        if (state.microphonePermission !== 'granted') {
          await bridge.openMicrophoneSettings()
          return
        }
        if (state.restartRequired) {
          await bridge.restartApp()
          return
        }
        if (state.systemAudioCheckStatus !== 'ready') {
          const nextState = await bridge.verifySystemAudio()
          if (nextState.systemAudioCheckStatus !== 'ready') return
        }
        await prepareAudioModel()
        await bridge.updateSettings({
          audioCaptureEnabled: true,
          audioCaptureOnboardingCompleted: true,
        })
      },
      actionLabel: audioCaptureActionLabel,
      disabled: state.systemAudioCheckStatus === 'checking' || modelPresentation.disabled,
    },
    {
      id: 'day-analysis',
      label: t('Koppel je AI'),
      detail: t(
        'Remember gebruikt je AI om je taken bij te houden en je op tijd te helpen. Relevante schermcontext en tekst gaan naar de gekozen provider. Audiobestanden blijven op je Mac.'
      ),
      ready:
        settings.dayAnalysisOnboardingCompleted &&
        settings.dayAnalysisProvider !== null &&
        settings.cloudAnalysisConsent,
      action: async () => undefined,
      actionLabel: t('Kies agent'),
    },
  ]

  const currentStepIndex = steps.findIndex((step) => !step.ready)
  const currentStep = currentStepIndex >= 0 ? steps[currentStepIndex] : null
  const completedStepCount = steps.filter((step) => step.ready).length
  const headingRef = useRef<HTMLHeadingElement>(null)
  const previousStepId = useRef(currentStep?.id)

  useEffect(() => {
    if (previousStepId.current !== currentStep?.id) headingRef.current?.focus()
    previousStepId.current = currentStep?.id
  }, [currentStep?.id])

  useEffect(() => {
    if (currentStep?.id !== 'day-analysis') return
    let active = true
    setSetupAgent({ provider: selectedCloudProvider, status: 'checking', executable: null, detail: null })
    void bridge
      .checkAgent()
      .then((agent) => {
        if (active) setSetupAgent(agent)
      })
      .catch(() => {
        if (active) {
          setSetupAgent({
            provider: selectedCloudProvider,
            status: 'error',
            executable: null,
            detail: t('De agentstatus kon niet worden gecontroleerd.'),
          })
        }
      })
    return () => {
      active = false
    }
  }, [bridge, currentStep?.id, selectedCloudProvider, t])

  useEffect(() => {
    if (
      currentStep?.id !== 'day-analysis' ||
      setupAgent?.provider !== selectedCloudProvider ||
      (setupAgent.status !== 'missing' && setupAgent.status !== 'signed-out')
    )
      return

    let checking = false
    const interval = window.setInterval(() => {
      if (checking) return
      checking = true
      void bridge
        .checkAgent()
        .then(setSetupAgent)
        .catch(() => undefined)
        .finally(() => {
          checking = false
        })
    }, 2_000)
    return () => window.clearInterval(interval)
  }, [bridge, currentStep?.id, selectedCloudProvider, setupAgent?.provider, setupAgent?.status])

  const chooseDayProvider = async (provider: AgentProvider) => {
    if (busyStepId || provider === selectedCloudProvider) return
    setStepError(null)
    setBusyStepId('day-analysis')
    try {
      setSetupAgent({ provider, status: 'checking', executable: null, detail: null })
      await bridge.updateSettings({ dayAnalysisProvider: provider, defaultAgentProvider: provider })
      setSetupAgent(await bridge.checkAgent())
      await onRefresh()
    } catch {
      setStepError(t('De keuze kon niet worden gecontroleerd. Probeer het opnieuw.'))
      await onRefresh().catch(() => undefined)
    } finally {
      setBusyStepId(null)
    }
  }

  const finishDayAnalysisStep = async () => {
    const provider = selectedCloudProvider
    if (busyStepId || setupAgent?.status !== 'ready') return
    setStepError(null)
    setBusyStepId('day-analysis')
    try {
      await bridge.updateSettings({
        dayAnalysisProvider: provider,
        defaultAgentProvider: provider,
        dayAnalysisOnboardingCompleted: true,
        cloudAnalysisConsent: true,
        cloudConsentNoticeSeen: true,
        frequentDayRefresh: automaticDayRefresh,
      })
      await onRefresh()
    } catch {
      setStepError(t('De keuze kon niet worden opgeslagen. Probeer het opnieuw.'))
    } finally {
      setBusyStepId(null)
    }
  }

  const handleDayAnalysisAction = async () => {
    if (busyStepId) return
    if (!setupAgent) return
    if (setupAgent.status === 'ready') {
      await finishDayAnalysisStep()
      return
    }
    if (setupAgent.status === 'missing' || setupAgent.status === 'signed-out') {
      setStepError(null)
      setBusyStepId('day-analysis')
      try {
        await bridge.openAgentLogin()
      } catch {
        setStepError(
          selectedCloudProvider === 'codex'
            ? t('ChatGPT kon niet worden geopend. Probeer het opnieuw.')
            : t('Claude Code kon niet worden geopend. Probeer het opnieuw.')
        )
      } finally {
        setBusyStepId(null)
      }
      return
    }

    setBusyStepId('day-analysis')
    try {
      setSetupAgent(await bridge.checkAgent())
    } catch {
      setStepError(t('De agentstatus kon niet worden gecontroleerd.'))
    } finally {
      setBusyStepId(null)
    }
  }

  const agentPresentation = agentSetupPresentation(
    selectedCloudProvider,
    setupAgent?.provider === selectedCloudProvider ? setupAgent.status : null,
    busyStepId === 'day-analysis',
    locale
  )

  const chooseManualRecording = async () => {
    if (busyStepId) return
    setStepError(null)
    setBusyStepId('audio-capture')
    try {
      await prepareAudioModel()
      await bridge.updateSettings({
        audioCaptureEnabled: false,
        audioCaptureOnboardingCompleted: true,
      })
      if (state.restartRequired) {
        await bridge.restartApp()
        return
      }
      await onRefresh()
    } catch {
      setStepError(
        !state.modelDownloaded
          ? t('Het audiomodel kon niet worden gedownload. Controleer je verbinding en probeer het opnieuw.')
          : t('De keuze kon niet worden opgeslagen. Probeer het opnieuw.')
      )
    } finally {
      setBusyStepId(null)
    }
  }

  const runCurrentStep = async () => {
    if (!currentStep || busyStepId) return
    setStepError(null)
    setBusyStepId(currentStep.id)
    try {
      await currentStep.action()
      await onRefresh()
    } catch {
      setStepError(
        currentStep.id === 'audio-capture' && !state.modelDownloaded
          ? t('Het audiomodel kon niet worden gedownload. Controleer je verbinding en probeer het opnieuw.')
          : t('Deze stap kon niet worden voltooid. Controleer de machtiging en probeer het opnieuw.')
      )
    } finally {
      setBusyStepId(null)
    }
  }

  return (
    <section className="app-no-drag m-auto grid w-full max-w-[800px] items-center gap-12 md:min-h-[340px] md:grid-cols-[minmax(0,1fr)_340px] lg:gap-16">
      <div className="flex min-w-0 flex-col md:self-stretch">
        <div className="shrink-0">
          <Logo wordmark />
        </div>

        {currentStep ? (
          <div className="mt-14 max-w-xl">
            <p className="font-medium text-blue-700 text-xs tabular-nums">
              {t('Stap {current} van {total}', { current: currentStepIndex + 1, total: steps.length })}
            </p>
            <h1
              id="current-setup-step"
              ref={headingRef}
              tabIndex={-1}
              className="mt-2 max-w-[24ch] text-balance font-display font-semibold text-2xl text-slate-950 leading-[1.15] tracking-[-0.02em] outline-none sm:text-3xl"
            >
              {currentStep.label}
            </h1>
            <p className="mt-3 max-w-[58ch] text-pretty text-slate-500 text-md leading-6">{currentStep.detail}</p>
            {stepError ? (
              <p
                className="mt-4 max-w-[58ch] border-danger-500 border-l-2 pl-3 text-danger-700 text-ui leading-5"
                role="alert"
              >
                {stepError}
              </p>
            ) : null}
            {currentStep.id === 'privacy' ? (
              <SetupPrivacy settings={settings} busy={busyStepId !== null} onContinue={() => void runCurrentStep()} />
            ) : currentStep.id === 'day-analysis' ? (
              <div className="mt-6 grid justify-items-start gap-4">
                <div className="flex w-full items-center justify-between gap-3">
                  <AgentProviderPicker
                    name="setup-cloud-provider"
                    value={selectedCloudProvider}
                    disabled={busyStepId !== null}
                    onChange={(provider) => void chooseDayProvider(provider)}
                  />
                  <div className="flex min-w-0 items-center gap-2" title={t('Dagoverzicht automatisch bijwerken')}>
                    <label htmlFor="setup-auto-refresh" className="text-right text-slate-700 text-sm">
                      {t('Automatisch samenvatten')}
                    </label>
                    <Switch
                      id="setup-auto-refresh"
                      aria-label={t('Dagoverzicht automatisch bijwerken')}
                      size="small"
                      checked={automaticDayRefresh}
                      disabled={busyStepId !== null}
                      onChange={setAutomaticDayRefresh}
                    />
                  </div>
                </div>
                {setupAgent?.status === 'missing' ? (
                  <p role="status" className="text-slate-600 text-sm">
                    {t('De ingebouwde agent is niet beschikbaar. Herstart Remember of kies een andere provider.')}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <SetupButton
                    size="small"
                    disabled={busyStepId !== null || agentPresentation.disabled}
                    pending={busyStepId === 'day-analysis' || setupAgent?.status === 'checking'}
                    onClick={() => void handleDayAnalysisAction()}
                  >
                    {agentPresentation.actionLabel}
                  </SetupButton>
                </div>
              </div>
            ) : currentStep.id === 'audio-capture' ? (
              <div className="mt-6 flex flex-wrap items-center gap-2">
                <SetupButton
                  size="small"
                  className="min-w-36 tabular-nums"
                  disabled={busyStepId !== null}
                  pending={busyStepId === currentStep.id && !modelPresentation.disabled}
                  aria-busy={busyStepId === currentStep.id}
                  onClick={() => void chooseManualRecording()}
                >
                  {modelPresentation.disabled ? modelPresentation.actionLabel : t('Handmatig opnemen')}
                </SetupButton>
                <Button
                  size="small"
                  variant="text"
                  color="secondary"
                  disabled={currentStep.disabled || busyStepId !== null}
                  onClick={() => void runCurrentStep()}
                >
                  {currentStep.actionLabel}
                </Button>
              </div>
            ) : (
              <SetupButton
                size="small"
                className="mt-6"
                disabled={currentStep.disabled || busyStepId !== null}
                pending={busyStepId === currentStep.id}
                onClick={() => void runCurrentStep()}
              >
                {currentStep.actionLabel}
              </SetupButton>
            )}
          </div>
        ) : null}
      </div>

      <aside
        aria-labelledby="setup-steps-title"
        className="flex min-w-0 flex-col rounded-xl bg-white p-5 shadow-raised"
      >
        <div className="flex items-baseline justify-between gap-4">
          <h2 id="setup-steps-title" className="font-semibold text-slate-900 text-md">
            {t('Installatie')}
          </h2>
          <span className="shrink-0 whitespace-nowrap text-slate-400 text-xs tabular-nums">
            {t('{completed} van {total} gereed', { completed: completedStepCount, total: steps.length })}
          </span>
        </div>

        <div className="mt-4 h-1 overflow-hidden rounded-full bg-slate-200" aria-hidden="true">
          <div
            className="pointer-events-none h-full rounded-full bg-blue-700 transition-transform duration-200 ease-out motion-reduce:transition-none"
            style={{
              transform: `scaleX(${completedStepCount / steps.length})`,
              transformOrigin: 'left',
            }}
          />
        </div>

        <ol className="mt-4 grid">
          {steps.map((step, index) => {
            const isCurrent = step.id === currentStep?.id
            return (
              <li
                key={step.id}
                aria-current={isCurrent ? 'step' : undefined}
                className="grid min-h-8 grid-cols-[20px_minmax(0,1fr)] items-center gap-3"
              >
                <span
                  className={`flex size-5 shrink-0 select-none items-center justify-center rounded-full font-medium text-xs tabular-nums transition-colors duration-150 motion-reduce:transition-none ${
                    step.ready ? 'text-blue-700' : isCurrent ? 'bg-blue-700 text-on-brand' : 'text-slate-400'
                  }`}
                  aria-hidden="true"
                >
                  {step.ready ? <IconCheckmark1Small className="size-4" /> : index + 1}
                </span>
                <span
                  className={`min-w-0 truncate font-medium text-ui ${
                    step.ready ? 'text-slate-400' : isCurrent ? 'text-slate-900' : 'text-slate-500'
                  }`}
                  title={step.label}
                >
                  {step.label}
                </span>
              </li>
            )
          })}
        </ol>
      </aside>
    </section>
  )
}
