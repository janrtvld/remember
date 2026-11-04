'use client'

import { LocalBridgeProvider, useLocalBridge } from '@internal/context/LocalBridgeProvider'
import { LocalI18nProvider, useI18n } from '@internal/locales'
import { Button } from '@internal/ui/Button'
import { PendingIndicator } from '@internal/ui/PendingIndicator'
import { Spinner } from '@internal/ui/Spinner'
import dynamic from 'next/dynamic'
import { usePathname, useRouter } from 'next/navigation'
import { Activity, type ReactNode, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { twMerge } from 'tailwind-merge'
import { ManualMeetingFloatingControl } from './MeetingRecordingControls'
import { NavigationControls } from './NavigationControls'
import { SetupState } from './SetupState'
import { Sidebar } from './Sidebar'
import { hasCompletedSetupChoices, isSetupComplete, isSetupResolving } from './setupStatus'

const AssistantView = dynamic(() => import('./AssistantView').then((module) => module.AssistantView), { ssr: false })

export function DashboardShell({ children }: { children: ReactNode }) {
  return (
    <LocalBridgeProvider>
      <LocalI18nProvider>
        <Suspense fallback={<DashboardLoadingState />}>
          <DashboardFrame>{children}</DashboardFrame>
        </Suspense>
      </LocalI18nProvider>
    </LocalBridgeProvider>
  )
}

function DashboardFrame({ children }: { children: ReactNode }) {
  const local = useLocalBridge()
  const { t } = useI18n()
  const pathname = usePathname()
  const assistantActive = pathname === '/assistant' || pathname === '/assistant/'
  const [assistantVisited, setAssistantVisited] = useState(assistantActive)
  useEffect(() => {
    if (assistantActive) setAssistantVisited(true)
  }, [assistantActive])
  const router = useRouter()
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)
  const [setupOnlineError, setSetupOnlineError] = useState(false)
  const setupOnlineRequest = useRef(false)
  const toggleSidebar = useCallback(() => setIsSidebarOpen((current) => !current), [])
  const openSidebar = useCallback(() => setIsSidebarOpen(true), [])
  const setupStatus = local.state && local.settings ? { state: local.state, settings: local.settings } : null
  const canReadNotes =
    (pathname === '/notes' || pathname === '/notes/') && local.settings && hasCompletedSetupChoices(local.settings)
  const setupIncomplete = setupStatus ? !isSetupComplete(setupStatus) && !canReadNotes : false
  const setupMustGoOnline =
    setupIncomplete &&
    local.bootstrapLoadStatus === 'ready' &&
    local.ready &&
    local.bridge !== null &&
    local.state?.permissionsResolved === true &&
    local.state.settingsHealth.status !== 'recovery-required' &&
    local.settings?.offlineMode === true

  const switchSetupOnline = useCallback(async () => {
    if (setupOnlineRequest.current) return
    setupOnlineRequest.current = true
    setSetupOnlineError(false)
    try {
      await local.updateSettings({ offlineMode: false })
    } catch {
      setSetupOnlineError(true)
    } finally {
      setupOnlineRequest.current = false
    }
  }, [local.updateSettings])

  useEffect(() => local.bridge?.onMeetingReminder(() => router.push('/conversations/')), [local.bridge, router])
  useEffect(() => {
    if (setupMustGoOnline) void switchSetupOnline()
  }, [setupMustGoOnline, switchSetupOnline])

  if (local.bootstrapLoadStatus === 'error') {
    return (
      <DashboardBootstrapError
        onRetry={async () => {
          if (local.bridge) await local.refresh()
          else window.location.reload()
        }}
      />
    )
  }

  if (!local.ready || !local.bridge || !local.state || !local.settings || !local.state.permissionsResolved) {
    return <DashboardLoadingState />
  }
  const bridge = local.bridge

  if (!canReadNotes && isSetupResolving({ state: local.state, settings: local.settings }))
    return <DashboardLoadingState />

  if (local.state.settingsHealth.status === 'recovery-required') {
    return (
      <SettingsRecoveryState
        hasLastKnownGood={local.state.settingsHealth.lastKnownGoodAvailable}
        onRepair={async (action) => {
          await bridge.repairSettings(action)
          await local.refresh()
        }}
      />
    )
  }

  if (setupIncomplete) {
    if (local.settings.offlineMode) {
      return setupOnlineError ? <SetupOnlineError onRetry={switchSetupOnline} /> : <DashboardLoadingState />
    }
    return (
      <div className="relative flex h-screen w-screen overflow-hidden bg-canvas">
        <a
          href="#setup-content"
          className="fixed top-2 left-2 z-50 -translate-y-16 rounded-lg bg-slate-950 px-3 py-2 font-medium text-on-accent text-ui outline-none transition-transform duration-150 focus:translate-y-0 motion-reduce:transition-none"
        >
          {t('Naar installatie')}
        </a>
        <main
          id="setup-content"
          tabIndex={-1}
          className="app-drag flex flex-1 flex-col overflow-x-hidden overflow-y-auto bg-canvas px-6 py-14 outline-none sm:px-8"
        >
          <SetupState state={local.state} settings={local.settings} bridge={local.bridge} onRefresh={local.refresh} />
        </main>
      </div>
    )
  }

  return (
    <div className="relative app-drag flex h-screen w-screen overflow-hidden bg-canvas">
      <nav aria-label={t('Snelkoppelingen')}>
        <a
          key={pathname}
          href="#main-content"
          className="fixed top-2 left-2 z-50 -translate-y-16 rounded-lg bg-slate-950 px-3 py-2 font-medium text-on-accent text-ui outline-none transition-transform duration-150 focus:translate-y-0 motion-reduce:transition-none"
        >
          {t('Naar inhoud')}
        </a>
      </nav>
      <Sidebar open={isSidebarOpen} onOpen={openSidebar} />
      <NavigationControls isSidebarOpen={isSidebarOpen} onToggleSidebar={toggleSidebar} />
      <ManualMeetingFloatingControl />

      <div
        className={twMerge(
          'flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-canvas px-2 pt-11 pb-4',
          isSidebarOpen && 'sm:pt-2 sm:pl-0'
        )}
      >
        <div className="-outline-offset-1 relative flex h-full w-full overflow-hidden bg-white flex-col rounded-xl shadow-shell outline outline-black/6">
          <div id="dashboard-page-header" className="shrink-0 empty:hidden" />
          <main
            id="main-content"
            tabIndex={-1}
            className={twMerge(
              'app-no-drag flex-1 grow bg-white outline-none',
              pathname.startsWith('/inbox') || pathname.startsWith('/assistant')
                ? 'overflow-hidden'
                : 'custom-scrollbar overflow-x-hidden overflow-y-scroll'
            )}
          >
            {assistantVisited || assistantActive ? (
              <Activity
                key={JSON.stringify([
                  local.settings.cloudAnalysisConsent,
                  local.settings.offlineMode,
                  local.settings.liveTaskUpdates,
                  local.settings.excludePasswordManagers,
                  local.settings.excludePrivateBrowsing,
                  local.settings.appCaptureMode,
                  local.settings.excludedAppBundleIds,
                  local.settings.includedAppBundleIds,
                  local.settings.websiteCaptureMode,
                  local.settings.excludedWebsites,
                  local.settings.includedWebsites,
                ])}
                mode={assistantActive ? 'visible' : 'hidden'}
              >
                <AssistantView active={assistantActive} />
              </Activity>
            ) : null}
            {!assistantActive ? children : null}
          </main>
          <div
            id="dashboard-page-footer"
            className="pointer-events-none app-no-drag custom-scrollbar absolute inset-x-0 bottom-0 z-20 overflow-hidden empty:hidden"
          />
        </div>
      </div>
    </div>
  )
}

function SetupOnlineError({ onRetry }: { onRetry: () => Promise<void> }) {
  const { t } = useI18n()

  return (
    <div className="app-drag flex h-screen w-screen items-center justify-center bg-canvas px-6">
      <main className="app-no-drag w-full max-w-md rounded-xl bg-white p-6 shadow-shell outline outline-1 outline-black/[0.06]">
        <h1 className="font-semibold text-slate-950 text-xl">{t('Offline mode kon niet worden uitgezet')}</h1>
        <p className="mt-2 text-slate-600 text-sm leading-6" role="alert">
          {t('Remember moet online zijn om de installatie en de eenmalige modeldownload af te ronden.')}
        </p>
        <Button size="small" className="mt-5" onClick={() => void onRetry()}>
          {t('Probeer opnieuw')}
        </Button>
      </main>
    </div>
  )
}

function DashboardBootstrapError({ onRetry }: { onRetry: () => Promise<void> }) {
  const { t } = useI18n()
  const [retrying, setRetrying] = useState(false)

  const retry = async () => {
    if (retrying) return
    setRetrying(true)
    try {
      await onRetry()
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div className="app-drag flex h-screen w-screen items-center justify-center bg-canvas px-6">
      <main className="app-no-drag w-full max-w-md rounded-xl bg-white p-6 shadow-shell outline outline-1 outline-black/[0.06]">
        <h1 className="font-semibold text-slate-950 text-xl">{t('Remember kon niet worden geladen')}</h1>
        <p className="mt-2 text-slate-600 text-sm leading-6" role="alert">
          {t('De lokale gegevens konden niet worden gelezen. Je bestaande archief is niet gewijzigd.')}
        </p>
        <Button size="small" className="mt-5" disabled={retrying} onClick={() => void retry()}>
          {retrying ? <Spinner size="xs" /> : null}
          {t('Probeer opnieuw')}
        </Button>
      </main>
    </div>
  )
}

function SettingsRecoveryState({
  hasLastKnownGood,
  onRepair,
}: {
  hasLastKnownGood: boolean
  onRepair: (action: 'restore-last-known-good' | 'use-safe-settings') => Promise<void>
}) {
  const { t } = useI18n()
  const [pending, setPending] = useState<'restore-last-known-good' | 'use-safe-settings' | null>(null)
  const [failed, setFailed] = useState(false)

  const repair = async (action: 'restore-last-known-good' | 'use-safe-settings') => {
    setPending(action)
    setFailed(false)
    try {
      await onRepair(action)
    } catch {
      setFailed(true)
      setPending(null)
    }
  }

  return (
    <div className="app-drag flex h-screen w-screen items-center justify-center bg-canvas px-6">
      <main className="app-no-drag w-full max-w-md rounded-xl bg-white p-6 shadow-shell outline outline-1 outline-black/[0.06]">
        <h1 className="font-semibold text-slate-950 text-xl">{t('Instellingen moeten worden hersteld')}</h1>
        <p className="mt-2 text-slate-600 text-sm leading-6">
          {t(
            'Remember heeft opname en AI-verwerking gepauzeerd omdat de privacy-instellingen niet betrouwbaar konden worden gelezen. Je bestaande archief is niet verwijderd.'
          )}
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          {hasLastKnownGood ? (
            <Button size="small" disabled={pending !== null} onClick={() => void repair('restore-last-known-good')}>
              {pending === 'restore-last-known-good' ? t('Herstellen…') : t('Vorige instellingen herstellen')}
            </Button>
          ) : null}
          <Button
            size="small"
            variant={hasLastKnownGood ? 'outline' : 'solid'}
            disabled={pending !== null}
            onClick={() => void repair('use-safe-settings')}
          >
            {pending === 'use-safe-settings' ? t('Herstellen…') : t('Veilige instellingen gebruiken')}
          </Button>
        </div>
        {failed ? (
          <p className="mt-3 text-danger-700 text-sm" role="alert">
            {t('De instellingen konden niet worden hersteld. Remember blijft gepauzeerd.')}
          </p>
        ) : null}
      </main>
    </div>
  )
}

function DashboardLoadingState() {
  return (
    <div className="app-drag flex h-screen w-screen items-center justify-center bg-canvas">
      <PendingIndicator size="xl" label="Remember" />
    </div>
  )
}
