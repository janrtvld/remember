import { type LocalSettings, PASSWORD_MANAGER_APPS } from '@remember/shared'

const PASSWORD_MANAGER_BUNDLE_IDS = new Set(PASSWORD_MANAGER_APPS.map((app) => app.bundleId.toLowerCase()))
const PASSWORD_MANAGER_NAMES = new Set(PASSWORD_MANAGER_APPS.map((app) => app.name.toLowerCase()))
const BROWSER_BUNDLE_IDS = new Set([
  'com.apple.safari',
  'com.brave.browser',
  'com.google.chrome',
  'com.microsoft.edgemac',
  'company.thebrowser.browser',
  'org.mozilla.firefox',
  'org.chromium.chromium',
])
const BROWSER_NAMES = new Set([
  'arc',
  'brave browser',
  'chromium',
  'firefox',
  'google chrome',
  'microsoft edge',
  'safari',
])
const PRIVATE_BROWSING_PATTERN =
  /\b(?:incognito|inprivate|private browsing|private window|prive browsing|privevenster|privenavigatie)\b/i

export function normalizeWebsite(value: string): string | null {
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

export function isExcludedContext(
  event: { appName: string; bundleId: string; windowTitle: string; text: string; url?: string },
  settings: Pick<
    LocalSettings,
    | 'excludePasswordManagers'
    | 'excludePrivateBrowsing'
    | 'appCaptureMode'
    | 'excludedAppBundleIds'
    | 'includedAppBundleIds'
    | 'websiteCaptureMode'
    | 'excludedWebsites'
    | 'includedWebsites'
  >
): boolean {
  const bundleId = event.bundleId.trim().toLowerCase()
  const appName = event.appName.trim().toLowerCase()
  const browserContext = BROWSER_BUNDLE_IDS.has(bundleId) || BROWSER_NAMES.has(appName) || Boolean(event.url)
  if (settings.excludePasswordManagers) {
    if (PASSWORD_MANAGER_BUNDLE_IDS.has(bundleId) || PASSWORD_MANAGER_NAMES.has(appName)) return true
  }
  if (
    settings.excludePrivateBrowsing &&
    browserContext &&
    PRIVATE_BROWSING_PATTERN.test(`${event.windowTitle}\n${event.text}`.normalize('NFKD').replace(/\p{M}/gu, ''))
  ) {
    return true
  }
  const selectedApps =
    settings.appCaptureMode === 'include' ? settings.includedAppBundleIds : settings.excludedAppBundleIds
  const appSelected = selectedApps.some((candidate) => candidate.toLowerCase() === bundleId)
  if (
    (settings.appCaptureMode === 'include' && !appSelected) ||
    (settings.appCaptureMode === 'exclude' && appSelected)
  ) {
    return true
  }

  const capturedUrl = event.url ? normalizeWebsite(event.url) : null
  const searchableFallback = `${event.windowTitle}\n${event.text}`.toLowerCase()
  const domainMatches = (website: string) => {
    const domain = normalizeWebsite(website)
    if (!domain) return false
    if (capturedUrl && (capturedUrl === domain || capturedUrl.endsWith(`.${domain}`))) return true
    const escapedDomain = domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^a-z0-9-])${escapedDomain}([^a-z0-9-]|$)`, 'i').test(searchableFallback)
  }
  if (!browserContext) return false
  if (settings.websiteCaptureMode === 'include') {
    return !capturedUrl || !settings.includedWebsites.some(domainMatches)
  }
  return settings.excludedWebsites.some(domainMatches)
}
