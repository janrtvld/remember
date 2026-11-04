import type { Server } from 'node:http'
import path from 'node:path'
import { CHANNELS } from '@remember/shared'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, protocol, session, shell } from 'electron'
import { checkAgent, logoutAgent, openAgentChat, openAgentLogin } from './agent'
import { getAgentAccountUsage } from './agentAccountUsage'
import { isAgentDisplayUrl } from './agentComputerDisplay'
import { createAgentInteractions } from './agentInteractions'
import { checkAgentLearning, getAgentLearningStatus, startAgentLearning, stopAgentLearning } from './agentLearning'
import {
  chooseAgentProject,
  getWorkItemAgentContext,
  getWorkItemAgentExecution,
  listAgentProjects,
  setWorkItemAgentProject,
  setWorkItemAgentThread,
} from './agentProjects'
import { listAgentTrace } from './agentTraceRepository'
import { cancelAgentTurn, runAgentTurn } from './agentTurn'
import { getAgentUsage } from './agentUsageRepository'
import { parseRememberDeepLink, type RememberDeepLink } from './appDeepLink'
import { registerAppIconIpc } from './appIcons'
import { createAppExitStrategy, createAppShutdown } from './appShutdown'
import { initializeClaudeAnalysisConfig } from './claudeAnalysisConfig'
import { getClaudeMcpSetupStatus, installClaudeMcp } from './claudeMcpSetup'
import { ensureCliAccess, getCliSetupStatus, installCliAccess } from './cliSetup'
import { getCodexModels } from './codexModels'
import { getContextImportPreview, importAgentContext } from './contextImport'
import { conversationAudioResponse } from './conversationAudioProtocol'
import {
  disposeDailyReview,
  finalizeDailyReviewAudioCapture,
  prepareDailyReviewForDataReset,
  queueAutomaticRevinoteProcessing,
  recordOfflineModeTransition,
  refreshDailyReviewSetup,
  refreshImportedRevinoteMeetings,
  registerDailyReviewIpc,
  rememberContextForWorkItem,
  resolveAudioConversation,
  resolveConversationAudioFile,
  startDailyReview,
} from './dailyReview'
import { cancelActiveAgentProcesses, shutdownAgentProcesses } from './dailyReview/agentProcessLifecycle'
import { getEvidenceStore } from './dailyReview/evidenceRepository'
import { disposeSharedMicrophoneCapture } from './dailyReview/microphoneAudio'
import { deleteAllLocalData } from './dataReset'
import { resetDevelopmentPermissions } from './developmentPermissions'
import { disposeDictation, startDictation } from './dictation'
import { createEdgeWidget } from './edgeWidget'
import { installElectronNetworkPolicy } from './electronNetworkPolicy'
import {
  initializeErrorReporting,
  reportAppError,
  reportRendererError,
  setErrorReportingEnabled,
} from './errorReporting'
import { externalNavigationUrl } from './externalNavigation'
import { migrateLegacyUserDataAt } from './legacyUserDataMigration'
import { localText } from './localization'
import {
  cancelNetworkRequests,
  isOfflineMode,
  setForcedOfflineMode,
  shouldBlockNetworkRequest,
  syncOfflineModeSentinel,
} from './networkAccess'
import { createPackagedWebServer } from './packagedWebServer'
import { closePermissionGuide, registerPermissionGuideIpc } from './permissionGuide'
import { profileLaunchDirectory } from './profileLaunch'
import { createRendererRecovery } from './rendererRecovery'
import { registerResidentAgent } from './residentAgentRuntime'
import {
  completeRevinoteOAuth,
  disposeRevinoteIntegration,
  fetchRevinoteConversationAudio,
  registerRevinoteIntegration,
  syncRevinote,
} from './revinoteIntegration'
import { acquireRememberDataLock } from './runtimeDataLock'
import {
  applyInterfaceThemeSetting,
  applyLaunchAtLoginSetting,
  getInterfaceLocale,
  getSettings,
  repairSettings,
  subscribeSettingsChanges,
  updateSettings,
} from './settings'
import { startupErrorPath, startupErrorReason } from './startupError'
import { createTray, disposeTray, refreshTray } from './tray'
import { applyAutomaticUpdatePolicy, applyOfflineUpdatePolicy, registerUpdater } from './updater'
import { developmentUserDataDirectory } from './userDataDirectory'
import { getUserName } from './userName'
import { cancelDownload } from './voiceNotes/models'
import { disposeWikiCliServer, startWikiCliServer } from './wikiCliServer'

const agentInteractions = createAgentInteractions(() => {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(CHANNELS.agentInteractionsChanged)
})
let residentAgent: ReturnType<typeof registerResidentAgent> | null = null
const activeWorkItems = new Set<string>()
function notifyWorkerStateChanged() {
  if (isQuitting) return
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(CHANNELS.memoryChanged)
}

let mainWindow: BrowserWindow | null = null
let disposeEdgeWidget: (() => void) | null = null
let isQuitting = false
let webServer: Server | null = null
let rendererBaseUrl: string | null = null
let startupErrorRendererUrl: string | null = null
let activateHandlerRegistered = false
let pendingActivation = false
let pendingDeepLink: Extract<RememberDeepLink, { kind: 'renderer' }> | null = null
let pendingRevinoteOAuth: Extract<RememberDeepLink, { kind: 'revinote-oauth' }> | null = null
let electronNetworkPolicy: ReturnType<typeof installElectronNetworkPolicy> | null = null
const LOADING_HTML = path.join(app.getAppPath(), 'resources', 'loading.html')
const PRODUCT_NAME = 'Remember'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'remember-audio',
    privileges: { secure: true, standard: true, stream: true, supportFetchAPI: true },
  },
])

function windowBackgroundColor() {
  return nativeTheme.shouldUseDarkColors ? '#070707' : '#f9fafb'
}

function syncWindowTheme() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.setBackgroundColor(windowBackgroundColor())
}

function useRememberUserData() {
  const profileDirectory = profileLaunchDirectory(process.argv, {
    isPackaged: app.isPackaged,
    uid: process.getuid?.() ?? -1,
  })
  if (profileDirectory) {
    app.setPath('userData', profileDirectory)
    return
  }

  const developmentDirectory = developmentUserDataDirectory(process.env.REMEMBER_USER_DATA_DIR, app.isPackaged)
  if (developmentDirectory) {
    app.setPath('userData', developmentDirectory)
    return
  }

  const appDataDirectory = app.getPath('appData')
  const rememberDirectory = migrateLegacyUserDataAt(appDataDirectory, PRODUCT_NAME)

  app.setPath('userData', rememberDirectory)
}

useRememberUserData()
app.setName(PRODUCT_NAME)
initializeErrorReporting(!getSettings().offlineMode)
const ownsSingleInstanceLock = app.requestSingleInstanceLock()
const dataLock = ownsSingleInstanceLock ? acquireRememberDataLock(app.getPath('userData')) : null
const ownsRuntime = ownsSingleInstanceLock && dataLock != null
if (!ownsRuntime) app.quit()
const claudeAnalysisConfig = initializeClaudeAnalysisConfig(app.getPath('userData'))
if (claudeAnalysisConfig.status === 'invalid') {
  console.warn(`[claude-config] ${claudeAnalysisConfig.detail} File: ${claudeAnalysisConfig.path}`)
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (!rendererBaseUrl) return
    const rendererUrl = startupErrorRendererUrl
      ? startupErrorRendererUrl
      : pendingDeepLink
        ? new URL(pendingDeepLink.rendererPath, rendererBaseUrl).toString()
        : rendererBaseUrl
    pendingDeepLink = null
    createWindow(rendererUrl, true)
    return
  }
  if (process.platform === 'darwin') {
    app.show()
    app.focus({ steal: true })
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function openPendingDeepLinkInRenderer() {
  if (startupErrorRendererUrl || !pendingDeepLink || !mainWindow || mainWindow.isDestroyed() || !rendererBaseUrl) return
  let currentUrl: URL
  try {
    currentUrl = new URL(mainWindow.webContents.getURL())
  } catch {
    return
  }
  const targetUrl = new URL(pendingDeepLink.rendererPath, rendererBaseUrl)
  if (currentUrl.origin !== targetUrl.origin) return

  pendingDeepLink = null
  if (
    currentUrl.pathname !== targetUrl.pathname ||
    currentUrl.search !== targetUrl.search ||
    currentUrl.hash !== targetUrl.hash
  )
    void mainWindow.loadURL(targetUrl.toString())
}

function openRememberDeepLink(value: string) {
  const deepLink = parseRememberDeepLink(value)
  if (!deepLink) return false
  if (deepLink.kind === 'activate') {
    pendingActivation = true
    if (app.isReady() && ownsRuntime) {
      showWindow()
      pendingActivation = false
    }
    return true
  }
  if (deepLink.kind === 'revinote-oauth') {
    pendingRevinoteOAuth = deepLink
    if (app.isReady() && ownsRuntime) void completePendingRevinoteOAuth()
    return true
  }
  pendingDeepLink = deepLink
  if (!app.isReady() || !ownsRuntime) return true

  showWindow()
  openPendingDeepLinkInRenderer()
  return true
}

async function completePendingRevinoteOAuth() {
  const callback = pendingRevinoteOAuth
  if (!callback) return
  pendingRevinoteOAuth = null
  try {
    await completeRevinoteOAuth(callback)
  } catch {
    // The connection controls receive the actionable error through the status channel.
  } finally {
    showWindow()
  }
}

function showSettings() {
  showWindow()
  if (startupErrorRendererUrl) return
  if (!mainWindow || mainWindow.isDestroyed() || !rendererBaseUrl) return
  void mainWindow.loadURL(new URL('/settings/', rendererBaseUrl).toString())
}

function showPauseDialog() {
  showWindow()
  if (startupErrorRendererUrl) return
  if (!mainWindow || mainWindow.isDestroyed() || !rendererBaseUrl) return
  void mainWindow.loadURL(new URL('/exclusions/?pause=1', rendererBaseUrl).toString())
}

if (ownsRuntime) {
  app.on('open-url', (event, url) => {
    if (!openRememberDeepLink(url)) return
    event.preventDefault()
  })
  app.on('second-instance', (_event, commandLine) => {
    const handled = commandLine.some((argument) => openRememberDeepLink(argument))
    if (!handled) showWindow()
  })
  for (const argument of process.argv) {
    if (openRememberDeepLink(argument)) break
  }
}
app.on('will-quit', () => dataLock?.release())

async function startPackagedWebServer(): Promise<string> {
  const root = path.join(process.resourcesPath, 'web')
  webServer = createPackagedWebServer(root)
  await new Promise<void>((resolve, reject) => {
    webServer?.once('error', reject)
    webServer?.listen(0, '127.0.0.1', resolve)
  })
  const address = webServer.address()
  if (!address || typeof address === 'string') throw new Error('local-web-server-address-missing')
  return `http://127.0.0.1:${address.port}`
}

async function warmRenderer(webUrl: string) {
  if (shouldBlockNetworkRequest(webUrl)) return
  try {
    const response = await fetch(webUrl, { cache: 'no-store' })
    if (!response.ok) throw new Error(`Renderer warmup returned ${response.status}`)
    await response.arrayBuffer()
  } catch (error) {
    console.warn('[renderer] Warmup failed; navigating normally.', error)
  }
}

function createWindow(webUrl: string, showWhenReady?: boolean) {
  const wasOpenedAtLogin = process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin
  let shouldShowWhenReady = showWhenReady ?? !wasOpenedAtLogin
  const window = new BrowserWindow({
    width: 1220,
    height: 740,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'Remember',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 13 },
    backgroundColor: windowBackgroundColor(),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow = window
  let initialLoadInterrupted = false
  const rendererOrigin = new URL(webUrl).origin
  const recovery = createRendererRecovery({
    canRecover: () =>
      !isQuitting && mainWindow === window && !window.isDestroyed() && !window.webContents.isDestroyed(),
    reload: async () => {
      const currentUrl = window.webContents.getURL()
      // A crash during the loading screen must still enter the app.
      const target = currentUrl && new URL(currentUrl).origin === rendererOrigin ? currentUrl : webUrl
      await window.loadURL(target)
    },
    onError: (error) => {
      console.error('[renderer] recovery failed:', error)
    },
  })

  window.once('ready-to-show', () => {
    if (shouldShowWhenReady && !isQuitting) window.show()
  })
  window.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    shouldShowWhenReady = false
    window.hide()
    if (process.platform === 'darwin' && !getSettings().edgeWidgetEnabled) app.hide()
  })
  window.on('closed', () => {
    recovery.dispose()
    if (mainWindow === window) mainWindow = null
  })
  window.on('app-command', (event, command) => {
    const navigationHistory = window.webContents.navigationHistory
    if (!navigationHistory) return

    if (command === 'browser-backward') {
      event.preventDefault()
      if (navigationHistory.canGoBack()) navigationHistory.goBack()
      return
    }

    if (command !== 'browser-forward') return

    event.preventDefault()
    if (navigationHistory.canGoForward()) navigationHistory.goForward()
  })
  const openRendererLink = (value: string) => {
    if (openRememberDeepLink(value)) return
    const url = externalNavigationUrl(value)
    if (!url || isAgentDisplayUrl(url) || shouldBlockNetworkRequest(url)) return
    void shell.openExternal(url).catch(() => console.warn('[navigation] External link could not open'))
  }
  window.webContents.setWindowOpenHandler(({ url }) => {
    openRendererLink(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    try {
      if (new URL(url).origin === rendererOrigin) return
    } catch {
      // Invalid renderer destinations are blocked below.
    }
    event.preventDefault()
    openRendererLink(url)
  })
  window.webContents.on('console-message', (_event, level, message) => {
    if (!app.isPackaged) console.log(`[renderer:${level}] ${message}`)
  })
  window.webContents.on('did-finish-load', () => {
    openPendingDeepLinkInRenderer()
  })
  window.webContents.on('did-fail-load', (_event, code, description) => {
    console.error(`[renderer] load failed (${code}): ${description}`)
    reportAppError(new Error(description), {
      area: 'renderer-load',
      code: 'renderer-load-failed',
      diagnostics: { exit_code: code },
    })
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    initialLoadInterrupted = true
    reportAppError(new Error(`Renderer process exited: ${details.reason}`), {
      area: 'renderer-process',
      code: 'renderer-process-gone',
      diagnostics: { exit_code: details.exitCode },
      tags: { reason: details.reason },
    })
    recovery.recover(details.reason)
  })
  void window
    .loadFile(LOADING_HTML)
    .then(() => warmRenderer(webUrl))
    .then(async () => {
      if (initialLoadInterrupted || isQuitting || mainWindow !== window || window.isDestroyed()) return
      await window.loadURL(webUrl)
      window.webContents.navigationHistory.clear()
    })
    .catch((error) => {
      console.error('[renderer] initial load failed:', error)
    })
}

function registerActivateHandler() {
  if (activateHandlerRegistered) return
  activateHandlerRegistered = true
  app.on('activate', showWindow)
}

async function showStartupError(error: unknown) {
  const reason = startupErrorReason(error)
  console.error('[startup] Remember could not start', error)
  reportAppError(error, {
    area: 'startup',
    code: 'startup-failed',
    tags: { reason },
  })

  const webUrl =
    rendererBaseUrl ??
    (app.isPackaged ? await startPackagedWebServer() : (process.env.REMEMBER_WEB_URL ?? 'http://localhost:3000'))
  rendererBaseUrl = webUrl
  startupErrorRendererUrl = new URL(startupErrorPath(reason), webUrl).toString()
  pendingDeepLink = null

  if (mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.loadURL(startupErrorRendererUrl)
    showWindow()
  } else {
    createWindow(startupErrorRendererUrl, true)
  }

  try {
    createTray({ showWindow, showSettings, showPauseDialog, startupError: true })
  } catch (trayError) {
    console.error('[startup] Could not create the recovery tray', trayError)
  }
  registerActivateHandler()
}

const appExitStrategy = createAppExitStrategy({
  exit: () => app.exit(0),
})
const shutdownApplication = createAppShutdown({
  stopProcesses: shutdownAgentProcesses,
  stopCapture: [
    disposeDailyReview,
    disposeDictation,
    async () => {
      await residentAgent?.dispose()
      residentAgent = null
    },
  ],
  cleanup: [
    disposeTray,
    () => {
      disposeEdgeWidget?.()
      disposeEdgeWidget = null
    },
    closePermissionGuide,
    disposeWikiCliServer,
    disposeRevinoteIntegration,
    stopAgentLearning,
    disposeSharedMicrophoneCapture,
    () => nativeTheme.removeListener('updated', syncWindowTheme),
    () => {
      webServer?.close()
      webServer = null
    },
    () => dataLock?.release(),
  ],
  exit: appExitStrategy.finishShutdown,
  reportError: (message, error) => console.error(`[shutdown] ${message}`, error),
})

async function applyOfflineModePolicy(offlineMode: boolean) {
  setForcedOfflineMode(offlineMode)
  syncOfflineModeSentinel(offlineMode)
  applyOfflineUpdatePolicy(offlineMode)
  const errorReportingUpdate = setErrorReportingEnabled(!offlineMode)
  if (offlineMode) {
    cancelNetworkRequests()
    cancelDownload()
    await Promise.all([cancelActiveAgentProcesses(), electronNetworkPolicy?.closeAllConnections()])
  } else {
    void syncRevinote({ force: true }).catch(() => undefined)
  }
  await errorReportingUpdate
  refreshTray()
}

async function recordOfflineModeTransitionOrFailClosed(previous: boolean, next: boolean) {
  if (previous === next) return
  try {
    recordOfflineModeTransition(next)
  } catch (error) {
    setForcedOfflineMode(true)
    if (!next) {
      try {
        updateSettings({ offlineMode: true })
      } catch (rollbackError) {
        console.error('[offline] Failed to persist the fail-closed settings rollback', rollbackError)
      }
    }
    await applyOfflineModePolicy(true)
    throw error
  }
}

function shutdownFromTerminalSignal() {
  isQuitting = true
  void shutdownApplication()
}

process.once('SIGINT', shutdownFromTerminalSignal)
process.once('SIGTERM', shutdownFromTerminalSignal)

async function startApplication() {
  if (!ownsRuntime) return
  syncOfflineModeSentinel(getSettings().offlineMode)
  electronNetworkPolicy = installElectronNetworkPolicy({
    defaultSession: session.defaultSession,
    fromPartition: (partition) => session.fromPartition(partition),
    shouldBlock: shouldBlockNetworkRequest,
  })
  protocol.handle('remember-audio', async (request) => {
    const url = new URL(request.url)
    if (url.hostname === 'revinote') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } })
      }
      const conversation = resolveAudioConversation(
        url.searchParams.get('dayId') ?? '',
        url.searchParams.get('conversation') ?? ''
      )
      if (conversation?.source !== 'revinote' || !conversation.externalId) {
        return new Response(null, { status: 404 })
      }
      try {
        const response = await fetchRevinoteConversationAudio(conversation.externalId, request.headers)
        if (!response) return new Response(null, { status: 404 })
        if (request.method === 'HEAD') {
          await response.body?.cancel()
          return new Response(null, { status: response.status, headers: response.headers })
        }
        return response
      } catch {
        return new Response(null, { status: 502 })
      }
    }
    if (url.hostname !== 'conversation') return new Response(null, { status: 404 })
    const file = resolveConversationAudioFile(
      url.searchParams.get('dayId') ?? '',
      url.searchParams.get('episodeId') ?? ''
    )
    return file ? conversationAudioResponse(file, request) : new Response(null, { status: 404 })
  })
  await ensureCliAccess()
  applyInterfaceThemeSetting()
  applyLaunchAtLoginSetting()
  nativeTheme.on('updated', syncWindowTheme)
  subscribeSettingsChanges(() => {
    const settings = getSettings()
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.webContents.isDestroyed()) window.webContents.send(CHANNELS.settingsChanged, settings)
    }
  })
  registerDailyReviewIpc({ onModelPrepared: showWindow })
  try {
    await startWikiCliServer()
  } catch (error) {
    console.error('[wiki-cli] Failed to start local bridge', error)
  }
  registerAppIconIpc()
  registerPermissionGuideIpc({
    getRendererBaseUrl: () => rendererBaseUrl,
    onPermissionGranted: async () => {
      showWindow()
      await refreshDailyReviewSetup()
    },
  })
  registerUpdater({
    prepareToQuit: (install) => {
      isQuitting = true
      appExitStrategy.prepareForUpdate(install)
      void shutdownApplication()
    },
  })
  ipcMain.on(CHANNELS.reportRendererError, (_event, input) => reportRendererError(input))
  ipcMain.handle(CHANNELS.getUserName, () => getUserName())
  ipcMain.handle(CHANNELS.revealDataFolder, () => shell.openPath(app.getPath('userData')))
  ipcMain.handle(CHANNELS.getSettings, () => getSettings())
  ipcMain.handle(CHANNELS.updateSettings, async (_event, patch) => {
    const previousSettings = getSettings()
    const previousOfflineMode = isOfflineMode()
    const settings = updateSettings(patch)
    await recordOfflineModeTransitionOrFailClosed(previousOfflineMode, settings.offlineMode)
    if ('offlineMode' in patch) await applyOfflineModePolicy(settings.offlineMode)
    if ('automaticUpdates' in patch) applyAutomaticUpdatePolicy(settings.automaticUpdates)
    if ('interfaceLanguage' in patch) refreshTray()
    if (previousSettings.audioCaptureEnabled && !settings.audioCaptureEnabled) {
      await finalizeDailyReviewAudioCapture()
    }
    if (!previousSettings.automaticRevinoteProcessing && settings.automaticRevinoteProcessing) {
      void queueAutomaticRevinoteProcessing()
    }
    await refreshDailyReviewSetup()
    return settings
  })
  ipcMain.handle(CHANNELS.repairSettings, async (_event, action) => {
    if (action !== 'restore-last-known-good' && action !== 'use-safe-settings') {
      throw new Error('invalid-settings-recovery-action')
    }
    const previousOfflineMode = isOfflineMode()
    const settings = repairSettings(action)
    await recordOfflineModeTransitionOrFailClosed(previousOfflineMode, settings.offlineMode)
    await applyOfflineModePolicy(settings.offlineMode)
    await refreshDailyReviewSetup()
    return settings
  })
  ipcMain.handle(CHANNELS.resetPermissionsForDevelopment, async () => {
    if (app.isPackaged || process.platform !== 'darwin') return false

    const locale = getInterfaceLocale()
    const options = {
      type: 'warning' as const,
      title: localText(locale, 'Onboarding opnieuw testen?', 'Test onboarding again?'),
      message: localText(
        locale,
        'Dit trekt de macOS-machtigingen van de ontwikkelapp in.',
        'This revokes the macOS permissions of the development app.'
      ),
      detail: localText(
        locale,
        'Toegankelijkheid, microfoon en systeem-audio worden gereset. De app start daarna opnieuw en toont de onboarding.',
        'Accessibility, microphone, and system audio will be reset. The app will then restart and show onboarding.'
      ),
      buttons: [localText(locale, 'Annuleren', 'Cancel'), localText(locale, 'Reset en herstart', 'Reset and restart')],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }
    const result = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options)
    if (result.response !== 1) return false

    await shutdownAgentProcesses()
    await disposeDailyReview()
    updateSettings({
      offlineMode: false,
      dayAnalysisProvider: 'codex',
      dayAnalysisOnboardingCompleted: false,
      privacyOnboardingCompleted: false,
      cloudAnalysisConsent: false,
      cloudConsentNoticeSeen: false,
      contextImportOnboardingCompleted: false,
      contextImportCompletedAt: null,
      audioCaptureEnabled: false,
      audioCaptureOnboardingCompleted: false,
      automaticRevinoteProcessing: false,
      capturePaused: false,
      capturePausedUntil: null,
      capturePauseSources: ['audio', 'capture'],
    })
    try {
      await resetDevelopmentPermissions()
    } catch (error) {
      console.error('[settings] could not reset development permissions', error)
      dialog.showErrorBox(
        localText(locale, 'Machtigingen konden niet worden gereset', 'Permissions could not be reset'),
        localText(
          locale,
          'De ontwikkelapp wordt opnieuw gestart. Probeer de reset daarna opnieuw.',
          'The development app will restart. Try resetting again afterward.'
        )
      )
    }
    setImmediate(() => {
      app.relaunch()
      app.exit(0)
    })
    return true
  })
  ipcMain.handle(CHANNELS.resetAllData, async (event) => {
    const rendererSession = event.sender.session
    const rendererWindow = BrowserWindow.fromWebContents(event.sender)
    const locale = getInterfaceLocale()
    const options = {
      type: 'warning' as const,
      title: localText(locale, 'Alle lokale gegevens verwijderen?', 'Delete all local data?'),
      message: localText(
        locale,
        'Dit verwijdert alle gegevens van Remember permanent.',
        'This permanently deletes all Remember data.'
      ),
      detail: localText(
        locale,
        'Opnames, transcripties, activiteit, dagen, wiki, instellingen en het lokale transcriptiemodel worden verwijderd. macOS-machtigingen en je ChatGPT- en Claude-login blijven behouden.',
        'Recordings, transcripts, activity, days, wiki, settings, and the local transcription model will be deleted. macOS permissions and your ChatGPT and Claude sign-ins will remain.'
      ),
      buttons: [localText(locale, 'Annuleren', 'Cancel'), localText(locale, 'Verwijder alles', 'Delete everything')],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }
    const result = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options)
    if (result.response !== 1) return false

    await shutdownAgentProcesses()
    await stopAgentLearning()
    await disposeDictation()
    await residentAgent?.prepareForDeletion()
    await residentAgent?.dispose()
    residentAgent = null
    await prepareDailyReviewForDataReset()
    let resetSucceeded = true
    try {
      await deleteAllLocalData()
      if (!rendererWindow) throw new Error('reset-renderer-window-missing')
      rendererWindow.destroy()
      await rendererSession.clearStorageData({ storages: ['localstorage'] })
    } catch (error) {
      resetSucceeded = false
      console.error('[settings] could not reset local data', error)
      dialog.showErrorBox(
        localText(locale, 'Gegevens konden niet volledig worden verwijderd', 'Data could not be fully deleted'),
        localText(
          locale,
          'Remember wordt opnieuw gestart. Probeer de reset daarna opnieuw.',
          'Remember will restart. Try deleting the data again afterward.'
        )
      )
    }
    setImmediate(() => {
      app.relaunch()
      app.exit(0)
    })
    return resetSucceeded
  })
  ipcMain.handle(CHANNELS.getCodexModels, () => getCodexModels())
  ipcMain.handle(CHANNELS.checkAgent, async (_event, provider) => {
    const setup = await checkAgent(provider)
    if (setup.provider === getSettings().defaultAgentProvider) await refreshDailyReviewSetup(setup)
    return setup
  })
  ipcMain.handle(CHANNELS.openAgentLogin, (_event, provider) => openAgentLogin(provider))
  ipcMain.handle(CHANNELS.logoutAgent, async () => {
    await logoutAgent()
    await refreshDailyReviewSetup()
  })
  ipcMain.handle(CHANNELS.contextImportPreview, () => getContextImportPreview())
  ipcMain.handle(CHANNELS.contextImportRun, () => importAgentContext())
  ipcMain.handle(CHANNELS.agentLearningStatus, () => getAgentLearningStatus())
  ipcMain.handle(CHANNELS.agentLearningCheck, () => checkAgentLearning())
  ipcMain.handle(CHANNELS.openAgentChat, (_event, input) => openAgentChat(input))
  ipcMain.handle(CHANNELS.listAgentProjects, () => listAgentProjects())
  ipcMain.handle(CHANNELS.chooseAgentProject, () => chooseAgentProject())
  ipcMain.handle(CHANNELS.getWorkItemAgentContext, (_event, itemId) => getWorkItemAgentContext(itemId))
  ipcMain.handle(CHANNELS.setWorkItemAgentProject, (_event, itemId, project) => {
    if (activeWorkItems.has(itemId)) throw new Error('agent-work-item-already-running')
    return setWorkItemAgentProject(itemId, project)
  })
  const assertTaskReviewSender = (event: Electron.IpcMainInvokeEvent) => {
    if (
      !app.isPackaged &&
      process.env.REMEMBER_QA_HOST_TASK_ENABLED === '1' &&
      (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame)
    )
      throw new Error('host-task-untrusted-sender')
  }
  ipcMain.handle(CHANNELS.getAgentInteractions, (event) => {
    assertTaskReviewSender(event)
    return agentInteractions.list()
  })
  ipcMain.handle(CHANNELS.answerAgentInteraction, (event, answer) => {
    assertTaskReviewSender(event)
    return agentInteractions.answer(answer)
  })
  ipcMain.handle(CHANNELS.cancelAgentTurn, (_event, turnId) => {
    if (typeof turnId !== 'string') throw new Error('invalid-agent-turn')
    if (!cancelAgentTurn(turnId)) throw new Error('agent-turn-not-running')
  })
  ipcMain.handle(CHANNELS.runAgentTurn, async (event, input) => {
    await syncRevinote().catch(() => undefined)
    const workItemId =
      input && typeof input === 'object' && 'workItemId' in input && typeof input.workItemId === 'string'
        ? input.workItemId
        : null
    const provider =
      input &&
      typeof input === 'object' &&
      'provider' in input &&
      (input.provider === 'codex' || input.provider === 'claude')
        ? input.provider
        : null
    const execution = workItemId && provider ? getWorkItemAgentExecution(workItemId, provider) : {}
    const prompt =
      input && typeof input === 'object' && 'prompt' in input && typeof input.prompt === 'string' ? input.prompt : ''
    const context = workItemId && provider && prompt ? rememberContextForWorkItem(workItemId) : ''
    const enrichedInput =
      context && input && typeof input === 'object'
        ? {
            ...input,
            prompt: `${context}\n\n=== User request ===\n\n${prompt}`,
          }
        : input
    // Persist independently of the renderer: closing or navigating away must not lose the artifact.
    const sessionId =
      input && typeof input === 'object' && 'turnId' in input && typeof input.turnId === 'string' ? input.turnId : null
    const session =
      workItemId && sessionId
        ? getEvidenceStore()
            .getWorkItem(workItemId)
            ?.agentSessions.find((candidate) => candidate.id === sessionId)
        : null
    if (workItemId && activeWorkItems.has(workItemId)) throw new Error('agent-work-item-already-running')
    if (workItemId) activeWorkItems.add(workItemId)
    notifyWorkerStateChanged()
    try {
      const result = await runAgentTurn(
        enrichedInput,
        (update) => {
          if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.agentTurnUpdate, update)
        },
        {
          ...execution,
          onThread: (threadId) => {
            if (workItemId && provider) setWorkItemAgentThread(workItemId, provider, threadId)
          },
          ask: (request, signal) =>
            agentInteractions.ask(
              { ...request, turnId: sessionId ?? '', ...(workItemId ? { workItemId } : {}) },
              signal
            ),
        }
      )
      if (workItemId && session) getEvidenceStore().finishWorkItemAgentSession(workItemId, session.id, result)
      if (workItemId && provider && result.threadId) setWorkItemAgentThread(workItemId, provider, result.threadId)
      return result
    } catch (error) {
      if (
        workItemId &&
        session &&
        getEvidenceStore()
          .getWorkItem(workItemId)
          ?.agentSessions.some((candidate) => candidate.id === session.id && candidate.status === 'running')
      )
        getEvidenceStore().failWorkItemAgentSession(
          workItemId,
          session.id,
          error instanceof Error && error.message === 'agent-cancelled' ? 'cancelled' : 'failed'
        )
      throw error
    } finally {
      if (workItemId) activeWorkItems.delete(workItemId)
      notifyWorkerStateChanged()
    }
  })
  ipcMain.handle(CHANNELS.cliGetSetupStatus, () => getCliSetupStatus())
  ipcMain.handle(CHANNELS.cliInstall, () => installCliAccess())
  ipcMain.handle(CHANNELS.claudeMcpGetSetupStatus, () => getClaudeMcpSetupStatus())
  ipcMain.handle(CHANNELS.claudeMcpInstall, () => installClaudeMcp())
  ipcMain.handle(CHANNELS.getAgentUsage, () => getAgentUsage())
  ipcMain.handle(CHANNELS.getAgentAccountUsage, (_event, provider) => getAgentAccountUsage(provider))
  ipcMain.handle(CHANNELS.listAgentTrace, () => listAgentTrace())
  residentAgent = registerResidentAgent(agentInteractions, (event) =>
    Boolean(mainWindow && event.sender === mainWindow.webContents && event.senderFrame === event.sender.mainFrame)
  )
  startDailyReview(() => mainWindow)
  startDictation(() => mainWindow)
  startAgentLearning()
  registerRevinoteIntegration({ onImportedMeetingsChanged: refreshImportedRevinoteMeetings })
  void completePendingRevinoteOAuth()
  const webUrl = app.isPackaged
    ? await startPackagedWebServer()
    : (process.env.REMEMBER_WEB_URL ?? 'http://localhost:3000')
  rendererBaseUrl = webUrl
  const initialRendererUrl = pendingDeepLink
    ? new URL(pendingDeepLink.rendererPath, webUrl).toString()
    : app.isPackaged
      ? new URL('/day/', webUrl).toString()
      : webUrl
  const openedFromDeepLink = pendingActivation || pendingDeepLink !== null
  pendingActivation = false
  pendingDeepLink = null
  createWindow(initialRendererUrl, openedFromDeepLink ? true : undefined)
  createTray({ showWindow, showSettings, showPauseDialog })
  disposeEdgeWidget = createEdgeWidget({
    rendererUrl: webUrl,
    openPath: (rendererPath) => {
      pendingDeepLink = { kind: 'renderer', rendererPath }
      showWindow()
      openPendingDeepLinkInRenderer()
    },
  })
  registerActivateHandler()
}

app
  .whenReady()
  .then(startApplication)
  .catch((error) => {
    void showStartupError(error).catch((recoveryError) => {
      console.error('[startup] Could not show the in-window error state', recoveryError)
      const locale = getInterfaceLocale()
      dialog.showErrorBox(
        localText(locale, 'Remember kon niet starten', 'Remember could not start'),
        localText(
          locale,
          'Je lokale gegevens zijn niet verwijderd. Installeer de nieuwste versie van Remember en probeer het opnieuw.',
          'Your local data was not deleted. Install the latest version of Remember and try again.'
        )
      )
    })
  })

app.on('before-quit', (event) => {
  isQuitting = true
  if (!appExitStrategy.shouldPreventQuit()) return
  event.preventDefault()
  void shutdownApplication()
})

app.on('window-all-closed', () => {
  // The app intentionally stays available in the menu bar.
})
