'use client'

import { Description, Field, Label } from '@headlessui/react'
import { DashboardContentHeader } from '@internal/components/DashboardContentHeader'
import { useLocalBridge } from '@internal/context/LocalBridgeProvider'
import { useI18n } from '@internal/locales'
import { Button } from '@internal/ui/Button'
import { Container } from '@internal/ui/Container'
import { DropdownSelect } from '@internal/ui/Dropdown'
import { Spinner } from '@internal/ui/Spinner'
import { Switch } from '@internal/ui/Switch'
import type { InterfaceLanguage, InterfaceTheme, UpdateState } from '@remember/shared'
import { type ReactNode, useState } from 'react'

const controlButtonClassName =
  'outline-none transition-[background-color,border-color,color,transform] duration-150 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 active:scale-[0.96] disabled:bg-slate-50 disabled:text-slate-400 disabled:text-opacity-100 motion-reduce:transition-none'
const interfaceLanguageOptions = ['system', 'en', 'nl'] as const satisfies readonly InterfaceLanguage[]
const interfaceThemeOptions = ['system', 'light', 'dark'] as const satisfies readonly InterfaceTheme[]

function SettingsRow({ title, description, children }: { title: string; description: ReactNode; children: ReactNode }) {
  return (
    <section className="grid min-h-[64px] gap-2 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <h2 className="text-balance font-medium text-slate-900 text-ui">{title}</h2>
        <div className="mt-0.5 max-w-prose text-pretty text-slate-500 text-xs leading-[1.5]">{description}</div>
      </div>
      <div className="flex shrink-0 items-center sm:justify-end">{children}</div>
    </section>
  )
}

function updateDescription(
  update: UpdateState,
  t: ReturnType<typeof useI18n>['t'],
  automaticUpdates: boolean,
  offlineMode: boolean
) {
  if (update.status === 'downloaded') {
    return t('Versie {version} is klaar. Herstart Remember om de update te installeren.', {
      version: update.version ?? '',
    })
  }
  if (offlineMode) return t('Gepauzeerd zolang Offline mode aanstaat.')
  if (update.status === 'unavailable') {
    return update.availability === 'development'
      ? t('Updates zijn beschikbaar in de geïnstalleerde app.')
      : t('Deze build heeft geen updatekanaal.')
  }
  if (update.status === 'checking') return t('Controleren…')
  if (update.status === 'available') return t('Versie {version} wordt gedownload.', { version: update.version ?? '' })
  if (update.status === 'downloading') {
    return t('Downloaden · {progress}%', { progress: Math.round((update.downloadProgress ?? 0) * 100) })
  }
  if (update.status === 'up-to-date') {
    return automaticUpdates
      ? t('Versie {version} is actueel.', { version: update.currentVersion })
      : t('Versie {version}. Automatische updates staan uit.', { version: update.currentVersion })
  }
  if (update.status === 'error') {
    return update.errorStage === 'download'
      ? t('Downloaden is niet gelukt. Je kunt het opnieuw proberen.')
      : t('Controleren is niet gelukt. Je kunt het opnieuw proberen.')
  }
  return automaticUpdates
    ? t('Versie {version}. Updates worden automatisch gedownload.', { version: update.currentVersion })
    : t('Versie {version}. Automatische updates staan uit.', { version: update.currentVersion })
}

function updateButtonLabel(update: UpdateState, t: ReturnType<typeof useI18n>['t']) {
  if (update.status === 'unavailable') return t('Niet beschikbaar')
  if (update.status === 'downloaded') return t('Herstart en installeer')
  if (update.status === 'available') return t('Downloaden…')
  if (update.status === 'checking') return t('Controleren…')
  if (update.status === 'downloading') return t('Downloaden…')
  if (update.status === 'error')
    return update.errorStage === 'download' ? t('Probeer download opnieuw') : t('Probeer opnieuw')
  return t('Controleer nu')
}

export function SettingsView() {
  const local = useLocalBridge()
  const { t } = useI18n()
  const [resetting, setResetting] = useState(false)
  const [widgetSaving, setWidgetSaving] = useState(false)
  const [widgetError, setWidgetError] = useState(false)
  const [isUpdatingLaunchSetting, setIsUpdatingLaunchSetting] = useState(false)
  const [isUpdatingOfflineMode, setIsUpdatingOfflineMode] = useState(false)
  const [errorReportingSaving, setErrorReportingSaving] = useState(false)
  const [errorReportingError, setErrorReportingError] = useState(false)
  const [isUpdatingAutomaticUpdates, setIsUpdatingAutomaticUpdates] = useState(false)
  if (!local.settings) return null
  const changeWidgetSetting = async (edgeWidgetEnabled: boolean) => {
    setWidgetSaving(true)
    setWidgetError(false)
    try {
      await local.updateSettings({ edgeWidgetEnabled, edgeWidgetHiddenUntil: null })
    } catch {
      setWidgetError(true)
    } finally {
      setWidgetSaving(false)
    }
  }

  const changeLaunchSetting = async (launchAtLogin: boolean) => {
    setIsUpdatingLaunchSetting(true)
    try {
      await window.remember.updateSettings({ launchAtLogin })
      await local.refresh()
    } finally {
      setIsUpdatingLaunchSetting(false)
    }
  }

  const changeInterfaceLanguage = async (interfaceLanguage: InterfaceLanguage) => {
    await window.remember.updateSettings({ interfaceLanguage })
    await local.refresh()
  }

  const changeInterfaceTheme = async (interfaceTheme: InterfaceTheme) => {
    await window.remember.updateSettings({ interfaceTheme })
    await local.refresh()
  }

  const changeOfflineMode = async (offlineMode: boolean) => {
    setIsUpdatingOfflineMode(true)
    try {
      await local.updateSettings({ offlineMode })
    } finally {
      setIsUpdatingOfflineMode(false)
    }
  }

  const changeAutomaticUpdates = async (automaticUpdates: boolean) => {
    setIsUpdatingAutomaticUpdates(true)
    try {
      await window.remember.updateSettings({ automaticUpdates })
      await local.refresh()
    } finally {
      setIsUpdatingAutomaticUpdates(false)
    }
  }

  const changeErrorReporting = async (errorReportingEnabled: boolean) => {
    setErrorReportingSaving(true)
    setErrorReportingError(false)
    try {
      await local.updateSettings({ errorReportingEnabled })
    } catch {
      setErrorReportingError(true)
    } finally {
      setErrorReportingSaving(false)
    }
  }

  const updateBusy = local.update.status === 'checking' || local.update.status === 'downloading'
  const updateUnavailable = local.update.status === 'unavailable'
  return (
    <Container className="flex grow flex-col gap-6 py-8 md:py-12">
      <DashboardContentHeader title={t('Instellingen')} />

      <div className="divide-y divide-slate-100 overflow-hidden rounded-xl bg-white shadow-raised">
        <SettingsRow title={t('Taal')} description={t('De interfacetaal van Remember')}>
          <DropdownSelect
            ariaLabel={t('Taal')}
            value={local.settings.interfaceLanguage}
            options={interfaceLanguageOptions}
            formatLabel={(value) =>
              value === 'system' ? t('Systeemstandaard') : value === 'en' ? 'English' : 'Nederlands'
            }
            onChange={(value) => void changeInterfaceLanguage(value)}
          />
        </SettingsRow>

        <SettingsRow title={t('Weergave')} description={t('Volg je systeeminstelling of kies licht of donker.')}>
          <DropdownSelect
            ariaLabel={t('Weergave')}
            value={local.settings.interfaceTheme}
            options={interfaceThemeOptions}
            formatLabel={(value) =>
              value === 'system' ? t('Systeemstandaard') : value === 'light' ? t('Licht') : t('Donker')
            }
            onChange={(value) => void changeInterfaceTheme(value)}
          />
        </SettingsRow>

        <Field className="grid min-h-[64px] gap-2 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <div className="min-w-0">
            <Label className="block cursor-pointer text-balance font-medium text-slate-900 text-ui">
              {t('Schermwidget')}
            </Label>
            <Description className="mt-0.5 max-w-prose text-pretty text-slate-500 text-xs leading-[1.5]">
              {t('Vragen en gesprekken binnen handbereik aan de rand van je scherm.')}
            </Description>
            {widgetError ? (
              <p role="alert" className="mt-1 text-danger-700 text-xs">
                {t('De instelling kon niet worden opgeslagen. Probeer opnieuw.')}
              </p>
            ) : null}
          </div>
          <Switch
            checked={
              local.settings.edgeWidgetEnabled &&
              (local.settings.edgeWidgetHiddenUntil === null || local.settings.edgeWidgetHiddenUntil <= Date.now())
            }
            disabled={widgetSaving}
            onChange={(checked) => void changeWidgetSetting(checked)}
          />
        </Field>

        <Field className="grid min-h-[64px] gap-2 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <div className="min-w-0">
            <Label className="block cursor-pointer text-balance font-medium text-slate-900 text-ui">
              {t('Start bij inloggen')}
            </Label>
            <Description className="mt-0.5 max-w-prose text-pretty text-slate-500 text-xs leading-[1.5]">
              {t('Begin automatisch na het inloggen op je Mac.')}
            </Description>
          </div>
          <Switch
            checked={local.settings.launchAtLogin}
            disabled={isUpdatingLaunchSetting}
            onChange={(checked) => void changeLaunchSetting(checked)}
          />
        </Field>
      </div>

      <div className="divide-y divide-slate-100 overflow-hidden rounded-xl bg-white shadow-raised">
        <Field className="grid min-h-[64px] gap-2 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <div className="min-w-0">
            <Label className="block cursor-pointer text-balance font-medium text-slate-900 text-ui">
              {t('Offline mode')}
            </Label>
            <Description className="mt-0.5 max-w-prose text-pretty text-slate-500 text-xs leading-[1.5]">
              {t(
                'Alles op je Mac, waaronder opnemen en transcriberen, blijft werken; AI-verzoeken, Revinote-sync, foutmeldingen en updates stoppen.'
              )}
            </Description>
          </div>
          <Switch
            checked={local.settings.offlineMode}
            disabled={isUpdatingOfflineMode}
            onChange={(checked) => void changeOfflineMode(checked)}
          />
        </Field>

        <Field className="grid min-h-[64px] gap-2 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <div className="min-w-0">
            <Label className="block cursor-pointer text-balance font-medium text-slate-900 text-ui">
              {t('Technische foutmeldingen')}
            </Label>
            <Description className="mt-0.5 max-w-prose text-pretty text-slate-500 text-xs leading-[1.5]">
              {local.settings.offlineMode
                ? t('Gepauzeerd zolang Offline mode aanstaat.')
                : t('Stuur technische foutinformatie naar Sentry, zonder opnames, transcripties of prompts.')}
            </Description>
            {errorReportingError ? (
              <p role="alert" className="mt-1 text-danger-700 text-xs">
                {t('De instelling kon niet worden opgeslagen. Probeer opnieuw.')}
              </p>
            ) : null}
          </div>
          <Switch
            checked={local.settings.errorReportingEnabled}
            disabled={errorReportingSaving || local.settings.offlineMode}
            aria-busy={errorReportingSaving}
            onChange={(checked) => void changeErrorReporting(checked)}
          />
        </Field>

        <Field className="grid min-h-[64px] gap-2 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <div className="min-w-0">
            <Label className="block cursor-pointer text-balance font-medium text-slate-900 text-ui">
              {t('Automatische updates')}
            </Label>
            <Description className="mt-0.5 max-w-prose text-pretty text-slate-500 text-xs leading-[1.5]">
              {local.settings.offlineMode
                ? t('Gepauzeerd zolang Offline mode aanstaat.')
                : t('Controleer en download nieuwe versies automatisch.')}
            </Description>
          </div>
          <Switch
            checked={local.settings.automaticUpdates}
            disabled={isUpdatingAutomaticUpdates || local.settings.offlineMode}
            onChange={(checked) => void changeAutomaticUpdates(checked)}
          />
        </Field>

        <SettingsRow
          title={t('Updates')}
          description={
            <span
              className={`flex items-center gap-1.5 tabular-nums ${
                local.update.status === 'error' ? 'text-danger-700' : ''
              }`}
              role={local.update.status === 'error' ? 'alert' : undefined}
              aria-live={local.update.status === 'error' ? undefined : 'polite'}
            >
              {local.update.status === 'error' ? (
                <span className="size-1.5 shrink-0 rounded-full bg-danger-700" aria-hidden="true" />
              ) : null}
              {updateDescription(local.update, t, local.settings.automaticUpdates, local.settings.offlineMode)}
              {local.update.status === 'downloading' ? (
                <progress
                  className="sr-only"
                  max={1}
                  value={local.update.downloadProgress ?? 0}
                  aria-label={t('Update downloaden')}
                />
              ) : null}
            </span>
          }
        >
          <Button
            size="small"
            variant="outline"
            color="secondary"
            disabled={
              updateBusy ||
              updateUnavailable ||
              local.updateRestartPending ||
              (local.settings.offlineMode && local.update.status !== 'downloaded')
            }
            aria-busy={local.updateRestartPending}
            className={controlButtonClassName}
            onClick={() => {
              if (local.update.status === 'downloaded') {
                void local.restartToUpdate()
              } else if (
                local.update.status === 'available' ||
                (local.update.status === 'error' && local.update.errorStage === 'download')
              ) {
                void local.downloadUpdate()
              } else {
                void local.checkForUpdate()
              }
            }}
          >
            {local.update.status === 'downloaded' ? (
              <span
                className={`inline-grid items-center transition-[grid-template-columns] duration-150 ease-in-out motion-reduce:transition-none ${
                  local.updateRestartPending ? 'grid-cols-[16px_auto]' : 'grid-cols-[0px_auto]'
                }`}
              >
                <span className="min-w-0 overflow-hidden" aria-hidden="true">
                  <span className="flex w-4 items-center">
                    {local.updateRestartPending ? <Spinner size="xs" /> : null}
                  </span>
                </span>
                <span>{updateButtonLabel(local.update, t)}</span>
              </span>
            ) : (
              updateButtonLabel(local.update, t)
            )}
          </Button>
        </SettingsRow>

        <SettingsRow
          title={t('Lokale gegevens')}
          description={t('Verwijder opnames, rapporten, Wiki en instellingen.')}
        >
          <Button
            size="small"
            variant="solid"
            color="danger"
            disabled={resetting}
            className={controlButtonClassName}
            onClick={async () => {
              setResetting(true)
              const confirmed = await window.remember.resetAllData()
              if (!confirmed) setResetting(false)
            }}
          >
            {resetting ? t('Verwijderen…') : t('Verwijder alles')}
          </Button>
        </SettingsRow>
      </div>

      {process.env.NODE_ENV === 'development' ? (
        <div className="divide-y divide-slate-100 overflow-hidden rounded-xl bg-white shadow-raised">
          <SettingsRow
            title={t('Ontwikkeltools')}
            description={t(
              'Doorloop onboarding met gesimuleerde machtigingen. Je echte instellingen blijven hetzelfde.'
            )}
          >
            <Button
              size="small"
              variant="outline"
              color="secondary"
              className={controlButtonClassName}
              onClick={() => window.location.assign('/?preview-onboarding=1')}
            >
              {t('Doorloop onboarding')}
            </Button>
          </SettingsRow>
        </div>
      ) : null}
    </Container>
  )
}
