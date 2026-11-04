'use client'

import { useLocalBridge } from '@internal/context/LocalBridgeProvider'
import { useI18n } from '@internal/locales'
import { Button } from '@internal/ui/Button'
import { IconButton } from '@internal/ui/IconButton'
import { Spinner } from '@internal/ui/Spinner'
import {
  type CaptureFilterMode,
  type InstalledApp,
  PASSWORD_MANAGER_APPS,
  type RememberBridge,
  summarizeAppUsage,
} from '@remember/shared'
import {
  Info as IconCircleInfo,
  CircleX as IconCircleX,
  EyeOff as IconEyeSlash,
  KeyRound as IconKey1,
  Plus as IconPlusSmall,
  Globe as IconWebsite,
  AppWindow as IconWindowApp,
} from 'lucide-react'
import Image from 'next/image'
import { type FormEvent, useEffect, useMemo, useState } from 'react'

type ExclusionView = 'apps' | 'websites'
const EMPTY_STRING_LIST: string[] = []
let installedAppsSnapshot: InstalledApp[] | null = null
let installedAppsRequest: Promise<InstalledApp[]> | null = null

function loadInstalledApps(bridge: RememberBridge) {
  if (installedAppsSnapshot !== null) return Promise.resolve(installedAppsSnapshot)
  installedAppsRequest ??= bridge
    .listInstalledApps()
    .then((apps) => {
      installedAppsSnapshot = apps
      return apps
    })
    .catch((error) => {
      installedAppsRequest = null
      throw error
    })
  return installedAppsRequest
}

function normalizeWebsite(value: string) {
  const trimmed = value.trim().toLowerCase()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
    const hostname = url.hostname.replace(/^www\./, '').replace(/\.$/, '')
    return hostname.includes('.') || hostname === 'localhost' ? hostname : null
  } catch {
    return null
  }
}

function Checkmark({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`flex size-5 shrink-0 items-center justify-center rounded-md border transition-[background-color,border-color,color] duration-150 ease-out motion-reduce:transition-none ${
        checked ? 'border-blue-700 bg-blue-700 text-on-brand' : 'border-slate-300 bg-white text-transparent'
      }`}
    >
      <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5" fill="none">
        <path
          d="m3.5 8.2 2.7 2.7 6.3-6.3"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  )
}

function EmptyState({ children }: { children: string }) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <span className="flex size-10 items-center justify-center rounded-xl bg-slate-100 text-slate-400">
        <IconEyeSlash className="size-5" />
      </span>
      <p className="max-w-sm text-pretty text-slate-500 text-sm">{children}</p>
    </div>
  )
}

function CaptureModeSwitch({
  value,
  disabled,
  onChange,
}: {
  value: CaptureFilterMode
  disabled: boolean
  onChange: (mode: CaptureFilterMode) => void
}) {
  const { t } = useI18n()
  return (
    <div className="inline-flex shrink-0 rounded-md bg-slate-100 p-0.5" role="group" aria-label={t('Vastlegmodus')}>
      {(
        [
          ['exclude', 'Alles behalve'],
          ['include', 'Alleen geselecteerd'],
        ] as const
      ).map(([mode, label]) => (
        <button
          key={mode}
          type="button"
          aria-pressed={value === mode}
          disabled={disabled}
          onClick={() => onChange(mode)}
          className={`relative h-7 whitespace-nowrap rounded-[5px] px-2.5 font-medium text-sm outline-none transition-[background-color,color,box-shadow,transform] duration-150 ease-out before:absolute before:-inset-y-2 before:inset-x-0 before:content-[''] focus-visible:ring-2 focus-visible:ring-slate-400 active:scale-[0.96] disabled:cursor-wait motion-reduce:transition-none ${
            value === mode ? 'bg-selected text-slate-900 shadow-raised' : 'text-slate-600 hover:text-slate-800'
          }`}
        >
          {t(label)}
        </button>
      ))}
    </div>
  )
}

function CaptureModeInfo({ view, mode }: { view: ExclusionView; mode: CaptureFilterMode }) {
  const { t } = useI18n()
  const description =
    view === 'apps'
      ? mode === 'include'
        ? t(
            'Remember legt alleen schermcontext uit de geselecteerde apps vast. Wachtwoordmanagers hebben daarnaast een aparte beveiligingsregel.'
          )
        : t('Remember legt schermcontext uit alle apps vast behalve de geselecteerde apps en beschermde categorieën.')
      : mode === 'include'
        ? t('In browsers legt Remember alleen schermcontext op de geselecteerde domeinen vast.')
        : t('In browsers legt Remember alle schermcontext vast behalve op de geselecteerde domeinen.')

  return (
    <span className="group relative flex">
      <button
        type="button"
        aria-label={t('Over vastlegmodus')}
        aria-describedby="capture-mode-description"
        className="relative flex size-5 items-center justify-center rounded-md text-slate-400 outline-none before:absolute before:-inset-1 hover:bg-slate-100 hover:text-slate-600 focus-visible:ring-2 focus-visible:ring-slate-400"
      >
        <IconCircleInfo className="size-3.5" aria-hidden="true" />
      </button>
      <span
        id="capture-mode-description"
        role="tooltip"
        className="invisible absolute top-full right-0 z-30 mt-1.5 w-64 rounded-lg bg-white px-3 py-2 font-medium text-slate-800 text-xs leading-5 opacity-0 shadow-raised transition-[opacity,visibility] duration-[125ms] ease-out group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100 motion-reduce:transition-none"
      >
        {description}
      </span>
    </span>
  )
}

export function ExclusionsSettings({ onPendingChange }: { onPendingChange?: (pending: boolean) => void } = {}) {
  const local = useLocalBridge()
  const { t } = useI18n()
  const [view, setView] = useState<ExclusionView>('apps')
  const [website, setWebsite] = useState('')
  const [websiteError, setWebsiteError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const bridge = local.bridge
  const [icons, setIcons] = useState<Record<string, string>>({})
  const [installedApps, setInstalledApps] = useState<InstalledApp[] | null>(() => installedAppsSnapshot)
  const [installedAppsError, setInstalledAppsError] = useState(false)
  const appCaptureMode = local.settings?.appCaptureMode ?? 'exclude'
  const selectedAppBundleIds =
    appCaptureMode === 'include'
      ? (local.settings?.includedAppBundleIds ?? EMPTY_STRING_LIST)
      : (local.settings?.excludedAppBundleIds ?? EMPTY_STRING_LIST)

  useEffect(() => {
    let active = true
    if (!bridge) return
    void loadInstalledApps(bridge)
      .then((nextApps) => {
        if (active) setInstalledApps(nextApps)
      })
      .catch(() => {
        if (active) setInstalledAppsError(true)
      })
    return () => {
      active = false
    }
  }, [bridge])

  const retryInstalledApps = async () => {
    setInstalledAppsError(false)
    setInstalledApps(null)
    try {
      if (bridge) setInstalledApps(await loadInstalledApps(bridge))
    } catch {
      setInstalledAppsError(true)
    }
  }

  const apps = useMemo(() => {
    if (!installedApps) return []
    const byBundleId = new Map<string, { name: string; bundleId: string }>()
    for (const app of installedApps) byBundleId.set(app.bundleId, app)
    for (const app of summarizeAppUsage(local.days, local.days.length)) {
      if (app.bundleId) byBundleId.set(app.bundleId, { name: app.name, bundleId: app.bundleId })
    }
    for (const bundleId of selectedAppBundleIds) {
      if (byBundleId.has(bundleId)) continue
      const knownPasswordManager = PASSWORD_MANAGER_APPS.find((app) => app.bundleId === bundleId)
      byBundleId.set(bundleId, { name: knownPasswordManager?.name ?? bundleId, bundleId })
    }
    return Array.from(byBundleId.values()).sort((first, second) => first.name.localeCompare(second.name))
  }, [installedApps, local.days, selectedAppBundleIds])

  useEffect(() => {
    const bundleIds = apps.slice(0, 20).map((app) => app.bundleId)
    if (!bundleIds.length) return
    let active = true
    if (!bridge) return
    void bridge
      .getAppIcons(bundleIds)
      .then((nextIcons) => {
        if (active) setIcons((current) => ({ ...current, ...nextIcons }))
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [apps, bridge])

  if (!local.settings) return null
  const settings = local.settings
  const passwordManagerIds = new Set<string>(PASSWORD_MANAGER_APPS.map((app) => app.bundleId))
  const selectedWebsites =
    settings.websiteCaptureMode === 'include' ? settings.includedWebsites : settings.excludedWebsites

  const save = async (key: string, patch: Parameters<typeof window.remember.updateSettings>[0]) => {
    if (!bridge || pending) return
    setPending(key)
    setSaveError(null)
    onPendingChange?.(true)
    try {
      await bridge.updateSettings(patch)
      await local.refresh()
    } catch {
      setSaveError(t('De privacy-instellingen konden niet worden opgeslagen. Probeer het opnieuw.'))
    } finally {
      onPendingChange?.(false)
      setPending(null)
    }
  }

  const toggleApp = (bundleId: string) => {
    const selectedIds =
      settings.appCaptureMode === 'include' ? settings.includedAppBundleIds : settings.excludedAppBundleIds
    const selected = selectedIds.includes(bundleId)
    const next = selected ? selectedIds.filter((candidate) => candidate !== bundleId) : [...selectedIds, bundleId]
    void save(
      bundleId,
      settings.appCaptureMode === 'include' ? { includedAppBundleIds: next } : { excludedAppBundleIds: next }
    )
  }

  const addWebsite = (event: FormEvent) => {
    event.preventDefault()
    const domain = normalizeWebsite(website)
    if (!domain) {
      setWebsiteError(t('Voer een geldig domein in, bijvoorbeeld example.com.'))
      return
    }
    setWebsiteError(null)
    setWebsite('')
    const selectedWebsites =
      settings.websiteCaptureMode === 'include' ? settings.includedWebsites : settings.excludedWebsites
    if (selectedWebsites.includes(domain)) return
    void save(
      domain,
      settings.websiteCaptureMode === 'include'
        ? { includedWebsites: [...selectedWebsites, domain] }
        : { excludedWebsites: [...selectedWebsites, domain] }
    )
  }

  const normalizedWebsite = normalizeWebsite(website)

  return (
    <div className="grid gap-4">
      {saveError ? (
        <p role="alert" className="text-danger-700 text-sm">
          {saveError}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-md bg-slate-100 p-0.5" role="tablist" aria-label={t('Type uitsluiting')}>
          {(
            [
              ['apps', 'Apps'],
              ['websites', 'Websites'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={view === id}
              aria-controls={`exclusions-${id}-panel`}
              onClick={() => setView(id)}
              className={`relative h-7 rounded-[5px] px-2.5 font-medium text-sm outline-none transition-[background-color,color,box-shadow,transform] duration-150 ease-out before:absolute before:-inset-y-1.5 before:inset-x-0 before:content-[''] focus-visible:ring-2 focus-visible:ring-slate-400 active:scale-[0.96] motion-reduce:transition-none ${
                view === id ? 'bg-selected text-slate-900 shadow-raised' : 'text-slate-600 hover:text-slate-800'
              }`}
            >
              {t(label)}
            </button>
          ))}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <CaptureModeInfo view={view} mode={view === 'apps' ? settings.appCaptureMode : settings.websiteCaptureMode} />
          <CaptureModeSwitch
            value={view === 'apps' ? settings.appCaptureMode : settings.websiteCaptureMode}
            disabled={pending !== null}
            onChange={(mode) =>
              void save(
                view === 'apps' ? 'app-capture-mode' : 'website-capture-mode',
                view === 'apps' ? { appCaptureMode: mode } : { websiteCaptureMode: mode }
              )
            }
          />
        </div>
      </div>

      {view === 'apps' ? (
        <div id="exclusions-apps-panel" role="tabpanel" className="overflow-hidden rounded-xl bg-white shadow-raised">
          <div className="px-3 pt-3 pb-1 font-semibold text-slate-500 text-xs">{t('Categorieën')}</div>
          <button
            type="button"
            aria-pressed={settings.excludePasswordManagers}
            disabled={pending !== null}
            onClick={() =>
              void save('password-managers', { excludePasswordManagers: !settings.excludePasswordManagers })
            }
            className="grid min-h-[64px] w-full grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-3 px-3 text-left outline-none transition-[background-color,transform] duration-150 ease-out hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-400 active:scale-[0.99] disabled:cursor-wait motion-reduce:transition-none"
          >
            <span className="flex size-9 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
              <IconKey1 className="size-5" />
            </span>
            <span className="min-w-0">
              <span className="block font-medium text-slate-900 text-ui">{t('Wachtwoordmanagers')}</span>
              <span className="block text-slate-500 text-xs">{t('Sluit bekende wachtwoordapps automatisch uit.')}</span>
            </span>
            <Checkmark checked={settings.excludePasswordManagers} />
          </button>
          <button
            type="button"
            aria-pressed={settings.excludePrivateBrowsing}
            disabled={pending !== null}
            onClick={() => void save('private-browsing', { excludePrivateBrowsing: !settings.excludePrivateBrowsing })}
            className="grid min-h-[64px] w-full grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-3 px-3 text-left outline-none transition-[background-color,transform] duration-150 ease-out hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-400 active:scale-[0.99] disabled:cursor-wait motion-reduce:transition-none"
          >
            <span className="flex size-9 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
              <IconEyeSlash className="size-5" />
            </span>
            <span className="min-w-0">
              <span className="block font-medium text-slate-900 text-ui">{t('Privénavigatie')}</span>
              <span className="block text-slate-500 text-xs">
                {t('Sla schermcontext uit herkende privé- en incognitovensters automatisch over.')}
              </span>
            </span>
            <Checkmark checked={settings.excludePrivateBrowsing} />
          </button>

          <div className="border-slate-100 border-t px-3 pt-3 pb-1 font-semibold text-slate-500 text-xs">
            {t('Geïnstalleerde en gebruikte apps')}
          </div>
          {installedAppsError ? (
            <div className="flex min-h-40 flex-col items-center justify-center px-6 text-center">
              <p className="max-w-sm text-pretty text-slate-600 text-sm" role="alert">
                {t('Geïnstalleerde apps konden niet worden geladen.')}
              </p>
              <Button
                size="small"
                variant="outline"
                color="secondary"
                className="mt-3"
                onClick={() => void retryInstalledApps()}
              >
                {t('Probeer opnieuw')}
              </Button>
            </div>
          ) : installedApps === null ? (
            <div className="flex min-h-40 items-center justify-center">
              <Spinner size="lg" label={t('Apps laden')} />
            </div>
          ) : apps.length ? (
            <div className="divide-y divide-slate-100 px-3">
              {apps.map((app) => {
                const coveredByCategory = settings.excludePasswordManagers && passwordManagerIds.has(app.bundleId)
                const selected =
                  settings.appCaptureMode === 'include'
                    ? settings.includedAppBundleIds.includes(app.bundleId)
                    : settings.excludedAppBundleIds.includes(app.bundleId)
                const checked = settings.appCaptureMode === 'exclude' ? coveredByCategory || selected : selected
                const icon = icons[app.bundleId]
                return (
                  <button
                    key={app.bundleId}
                    type="button"
                    aria-pressed={checked}
                    disabled={pending !== null || coveredByCategory}
                    title={coveredByCategory ? t('Uitgesloten via de categorie Wachtwoordmanagers') : undefined}
                    onClick={() => toggleApp(app.bundleId)}
                    className="grid min-h-[56px] w-full grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 text-left outline-none transition-[background-color,transform] duration-150 ease-out hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-400 active:scale-[0.99] disabled:cursor-default disabled:hover:bg-white motion-reduce:transition-none"
                  >
                    <span
                      className={`flex size-8 items-center justify-center overflow-hidden rounded-lg ${icon ? '' : 'bg-slate-100 text-slate-400'}`}
                    >
                      {icon ? (
                        <Image
                          unoptimized
                          src={icon}
                          alt=""
                          width={32}
                          height={32}
                          className="size-full object-contain"
                        />
                      ) : (
                        <IconWindowApp className="size-4" />
                      )}
                    </span>
                    <span className="min-w-0 truncate font-medium text-slate-800 text-ui">{app.name}</span>
                    <Checkmark checked={checked} />
                  </button>
                )
              })}
            </div>
          ) : (
            <EmptyState>{t('Geen apps gevonden. Apps verschijnen hier nadat je ze hebt gebruikt.')}</EmptyState>
          )}
        </div>
      ) : (
        <div
          id="exclusions-websites-panel"
          role="tabpanel"
          className="overflow-hidden rounded-xl bg-white shadow-raised"
        >
          <form onSubmit={addWebsite} className="grid gap-2 border-slate-100 border-b p-3">
            <label htmlFor="excluded-website" className="font-medium text-slate-900 text-ui">
              {settings.websiteCaptureMode === 'include' ? t('Toegestane website toevoegen') : t('Website uitsluiten')}
            </label>
            <div className="flex gap-2">
              <div className="relative min-w-0 grow">
                <IconWebsite className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
                <input
                  id="excluded-website"
                  type="text"
                  value={website}
                  onChange={(event) => {
                    setWebsite(event.target.value)
                    if (websiteError) setWebsiteError(null)
                  }}
                  placeholder="example.com"
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={Boolean(websiteError)}
                  aria-describedby={websiteError ? 'excluded-website-error' : undefined}
                  className={`h-10 w-full rounded-lg border bg-white pr-3 pl-9 text-slate-800 text-ui outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-slate-400 focus-visible:ring-2 motion-reduce:transition-none ${websiteError ? 'border-danger-700 focus-visible:ring-danger-100' : 'border-slate-200 focus-visible:border-slate-400 focus-visible:ring-slate-200'}`}
                />
              </div>
              <button
                type="submit"
                disabled={!normalizedWebsite || pending !== null}
                className="flex h-10 shrink-0 items-center gap-1.5 rounded-lg bg-slate-900 px-3 font-medium text-on-accent text-ui outline-none transition-[background-color,transform] duration-150 ease-out hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2 active:scale-[0.96] disabled:cursor-not-allowed disabled:bg-slate-300 motion-reduce:transition-none"
              >
                <IconPlusSmall className="size-4" />
                {t('Voeg toe')}
              </button>
            </div>
            {websiteError ? (
              <p id="excluded-website-error" role="alert" className="text-danger-700 text-xs">
                {websiteError}
              </p>
            ) : (
              <p className="text-slate-500 text-xs">
                {settings.websiteCaptureMode === 'include'
                  ? t('Alleen pagina’s op dit domein en subdomeinen worden vastgelegd.')
                  : t('Pagina’s op dit domein en subdomeinen worden niet vastgelegd.')}
              </p>
            )}
          </form>

          {selectedWebsites.length ? (
            <div className="divide-y divide-slate-100 px-3">
              {selectedWebsites.map((domain) => (
                <div key={domain} className="grid min-h-[56px] grid-cols-[32px_minmax(0,1fr)_40px] items-center gap-3">
                  <span className="flex size-8 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                    <IconWebsite className="size-4" />
                  </span>
                  <span className="min-w-0 truncate font-medium text-slate-800 text-ui">{domain}</span>
                  <IconButton
                    aria-label={t('Verwijder {domain}', { domain })}
                    disabled={pending !== null}
                    onClick={() =>
                      void save(
                        domain,
                        settings.websiteCaptureMode === 'include'
                          ? { includedWebsites: selectedWebsites.filter((candidate) => candidate !== domain) }
                          : { excludedWebsites: selectedWebsites.filter((candidate) => candidate !== domain) }
                      )
                    }
                    className="size-10 disabled:cursor-wait"
                  >
                    <IconCircleX className="size-4" />
                  </IconButton>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState>
              {settings.websiteCaptureMode === 'include'
                ? t('Er zijn nog geen websites toegestaan. Browserpagina’s worden nu niet vastgelegd.')
                : t('Je hebt nog geen websites uitgesloten. Voeg hierboven een domein toe.')}
            </EmptyState>
          )}
        </div>
      )}
    </div>
  )
}
