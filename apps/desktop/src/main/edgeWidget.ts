import path from 'node:path'
import {
  EDGE_WIDGET_CHANNELS,
  type EdgeWidgetEdge,
  type EdgeWidgetState,
  edgeWidgetBounds,
  edgeWidgetDropTarget,
  isEdgeWidgetEdge,
} from '@remember/shared'
import {
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  powerMonitor,
  screen,
} from 'electron'
import { getAssistantAttention, subscribeAssistantAttention } from './assistantAttention'
import { getDailyReviewState, onDailyReviewStateChange, pauseDailyReviewSourcesFor } from './dailyReview'
import {
  cancelDictation,
  copyDictation,
  getDictationState,
  onDictationStateChange,
  retryDictation,
  toggleDictation,
  toggleVoiceNote,
} from './dictation'
import { isEdgeWidgetSetupComplete } from './edgeWidgetSetup'
import { createRendererRecovery } from './rendererRecovery'
import { getInterfaceLocale, getSettings, subscribeSettingsChanges, updateSettings } from './settings'

export function createEdgeWidget({ rendererUrl, openPath }: { rendererUrl: string; openPath: (path: string) => void }) {
  let widget: BrowserWindow | null = null
  let disposed = false
  let positionTimer: NodeJS.Timeout | null = null
  let docking: EdgeWidgetState['docking'] = null
  let dragTimeout: NodeJS.Timeout | null = null
  let escapeRegistered = false
  let contextMenu: Menu | null = null
  let interactive = false
  let wakeTimer: NodeJS.Timeout | null = null
  let dailyReviewState = getDailyReviewState()
  let dictationState = getDictationState()
  let lastPublishedState: string | null = null

  function state(): EdgeWidgetState {
    return {
      edge: getSettings().edgeWidgetEdge,
      docking,
      locale: getInterfaceLocale(),
      alwaysOn: getSettings().audioCaptureEnabled,
      recording: dailyReviewState.manualMeeting?.status === 'recording',
      agentAttention: getAssistantAttention(),
      dictation: (() => {
        const value = dictationState
        if (!value) return null
        const { status, startedAt, level, result, error, canRetry } = value
        return { status, startedAt, level, result, error, canRetry }
      })(),
    }
  }

  function publish() {
    if (!widget || widget.isDestroyed()) return
    const value = state()
    const serialized = JSON.stringify(value)
    if (serialized === lastPublishedState) return
    lastPublishedState = serialized
    widget.webContents.send(EDGE_WIDGET_CHANNELS.stateChanged, value)
  }

  function position() {
    if (!widget || widget.isDestroyed() || contextMenu) return
    const pointer = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(pointer)
    const bounds = docking ? display.bounds : edgeWidgetBounds(display.workArea, getSettings().edgeWidgetEdge)
    const current = widget.getBounds()
    if (
      current.x !== bounds.x ||
      current.y !== bounds.y ||
      current.width !== bounds.width ||
      current.height !== bounds.height
    )
      widget.setBounds(bounds)
    if (docking) {
      const cursor = { x: pointer.x - bounds.x, y: pointer.y - bounds.y }
      const target = edgeWidgetDropTarget(cursor, bounds)
      if (cursor.x !== docking.cursor.x || cursor.y !== docking.cursor.y || target !== docking.target) {
        docking = { cursor, target }
        publish()
      }
    }
  }

  function stopPositionTracking() {
    if (positionTimer) clearInterval(positionTimer)
    positionTimer = null
  }

  function clearDocking() {
    docking = null
    if (dragTimeout) clearTimeout(dragTimeout)
    dragTimeout = null
    if (escapeRegistered) globalShortcut.unregister('Escape')
    escapeRegistered = false
  }

  function finishDrag(edge?: EdgeWidgetEdge | null) {
    if (!docking) return
    position()
    const destination = edge === undefined ? docking.target : edge
    clearDocking()
    stopPositionTracking()
    if (!widget || widget.isDestroyed()) return
    widget.setAlwaysOnTop(true, 'floating')
    widget.setIgnoreMouseEvents(true, { forward: true })
    try {
      if (destination) updateSettings({ edgeWidgetEdge: destination })
    } finally {
      position()
      publish()
      if (widget) {
        positionTimer = setInterval(position, 250)
        positionTimer.unref()
      }
    }
  }

  function beginDrag() {
    if (docking || contextMenu || !widget || !shouldShow()) return
    stopPositionTracking()
    docking = { cursor: { x: -1, y: -1 }, target: null }
    widget.setIgnoreMouseEvents(false)
    widget.setAlwaysOnTop(true, 'screen-saver')
    position()
    escapeRegistered = globalShortcut.register('Escape', () => finishDrag(null))
    positionTimer = setInterval(position, 32)
    positionTimer.unref()
    dragTimeout = setTimeout(() => finishDrag(null), 30_000)
    dragTimeout.unref()
  }

  function shouldShow() {
    const settings = getSettings()
    const status = dictationState?.status
    // Hiding the idle bar must not remove controls for an active dictation.
    const dictationVisible =
      status === 'starting' || status === 'recording' || status === 'transcribing' || status === 'error'
    return (
      !disposed &&
      isEdgeWidgetSetupComplete(settings, dailyReviewState) &&
      (dictationVisible ||
        (settings.edgeWidgetEnabled &&
          (settings.edgeWidgetHiddenUntil === null || settings.edgeWidgetHiddenUntil <= Date.now())))
    )
  }

  function scheduleWake() {
    if (wakeTimer) clearTimeout(wakeTimer)
    wakeTimer = null
    const { edgeWidgetEnabled, edgeWidgetHiddenUntil } = getSettings()
    if (disposed || !edgeWidgetEnabled || edgeWidgetHiddenUntil === null) return
    const remaining = edgeWidgetHiddenUntil - Date.now()
    if (remaining <= 0) {
      updateSettings({ edgeWidgetHiddenUntil: null })
      return
    }
    wakeTimer = setTimeout(
      () => {
        scheduleWake()
        sync()
      },
      Math.min(remaining, 2_147_483_647)
    )
    wakeTimer.unref()
  }

  function resume() {
    scheduleWake()
    sync()
  }

  function showContextMenu(point: { x: number; y: number }) {
    if (!widget || docking || contextMenu) return
    const dutch = getInterfaceLocale() === 'nl'
    const menu = Menu.buildFromTemplate([
      {
        label:
          dictationState?.status === 'recording'
            ? dutch
              ? 'Stop opname'
              : 'Stop recording'
            : dutch
              ? 'Dicteren'
              : 'Dictate',
        enabled: dictationState?.status !== 'starting' && dictationState?.status !== 'transcribing',
        click: () => {
          void toggleDictation().catch((error) => {
            console.error('[edge-widget] Could not toggle dictation', error)
            openPath('/notes/?preferences=1')
          })
        },
      },
      { label: dutch ? 'Notities' : 'Notes', click: () => openPath('/notes/') },
      { type: 'separator' },
      {
        label: dutch ? 'Verberg voor 1 uur' : 'Hide for 1 hour',
        click: () => updateSettings({ edgeWidgetHiddenUntil: Date.now() + 60 * 60 * 1_000 }),
      },
      {
        label: dutch ? 'Verberg voorgoed' : 'Hide forever',
        click: () => updateSettings({ edgeWidgetEnabled: false, edgeWidgetHiddenUntil: null }),
      },
      { type: 'separator' },
      { label: dutch ? 'Instellingen…' : 'Settings…', click: () => openPath('/settings/') },
    ])
    popupMenu(menu, point)
  }

  function popupMenu(menu: Menu, point?: { x: number; y: number }) {
    if (!widget || docking || contextMenu) return
    contextMenu = menu
    widget.setIgnoreMouseEvents(false)
    menu.popup({
      window: widget,
      ...(point ? { x: Math.round(point.x), y: Math.round(point.y) } : {}),
      callback: () => {
        if (contextMenu !== menu) return
        contextMenu = null
        if (widget && !widget.isDestroyed()) widget.setIgnoreMouseEvents(!interactive, { forward: true })
        position()
      },
    })
  }

  function showConversationMenu() {
    const dutch = getInterfaceLocale() === 'nl'
    const template: MenuItemConstructorOptions[] = [
      { label: dutch ? 'Pauzeer…' : 'Pause…', click: () => openPath('/exclusions/?pause=1&source=audio') },
      {
        label: dutch ? 'Pauzeer voor 1 uur' : 'Pause for 1 hour',
        click: () => {
          const settings = getSettings()
          const sources = settings.capturePaused ? settings.capturePauseSources : []
          void pauseDailyReviewSourcesFor(Array.from(new Set([...sources, 'audio'])), 60 * 60_000).catch((error) => {
            console.error('[edge-widget] Could not pause conversations', error)
            openPath('/exclusions/?pause=1&source=audio')
          })
        },
      },
      { type: 'separator' },
      { label: dutch ? 'Voorkeuren…' : 'Preferences…', click: () => openPath('/conversations/?preferences=1') },
    ]
    popupMenu(Menu.buildFromTemplate(template))
  }

  function sync() {
    if (!shouldShow()) {
      stopPositionTracking()
      clearDocking()
      contextMenu?.closePopup()
      contextMenu = null
      widget?.destroy()
      widget = null
      return
    }
    if (widget) {
      publish()
      return
    }
    const window = new BrowserWindow({
      width: 360,
      height: 240,
      title: 'Remember widget',
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      backgroundColor: '#00000000',
      ...(process.platform === 'darwin'
        ? { type: 'panel' as const, enableLargerThanScreen: true, hiddenInMissionControl: true }
        : {}),
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    widget = window
    lastPublishedState = null
    interactive = false
    window.on('page-title-updated', (event) => event.preventDefault())
    window.setAlwaysOnTop(true, 'floating')
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    window.setIgnoreMouseEvents(true, { forward: true })
    position()
    positionTimer = setInterval(position, 250)
    positionTimer.unref()
    window.once('ready-to-show', () => {
      if (!window.isDestroyed() && shouldShow()) {
        position()
        window.showInactive()
      } else {
        sync()
      }
    })
    const widgetUrl = new URL('/edge-widget/', rendererUrl).toString()
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event, url) => {
      if (url !== widgetUrl) event.preventDefault()
    })
    const recovery = createRendererRecovery({
      canRecover: () => !disposed && widget === window && !window.isDestroyed(),
      reload: () => window.loadURL(widgetUrl),
      onError: (error) => console.error('[edge-widget] Recovery failed', error),
    })
    window.on('closed', () => {
      recovery.dispose()
      if (widget === window) {
        stopPositionTracking()
        clearDocking()
        contextMenu = null
        widget = null
      }
    })
    window.webContents.on('render-process-gone', (_event, details) => {
      finishDrag(null)
      window.setIgnoreMouseEvents(true, { forward: true })
      if (!recovery.recover(details.reason)) window.hide()
    })
    void window.loadURL(widgetUrl).catch((error) => {
      console.error('[edge-widget] Could not load widget', error)
    })
  }

  ipcMain.handle(EDGE_WIDGET_CHANNELS.getState, (event) => {
    if (event.sender !== widget?.webContents) throw new Error('edge-widget-sender-required')
    return state()
  })
  ipcMain.on(EDGE_WIDGET_CHANNELS.setInteractive, (event, next: unknown) => {
    if (event.sender !== widget?.webContents || typeof next !== 'boolean') return
    interactive = next
    widget.setIgnoreMouseEvents(docking || contextMenu ? false : !interactive, { forward: true })
  })
  ipcMain.on(EDGE_WIDGET_CHANNELS.showContextMenu, (event, point: unknown) => {
    if (event.sender !== widget?.webContents) return
    if (
      !point ||
      typeof point !== 'object' ||
      !('x' in point) ||
      !('y' in point) ||
      typeof point.x !== 'number' ||
      typeof point.y !== 'number' ||
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y)
    )
      return
    showContextMenu({ x: point.x, y: point.y })
  })
  ipcMain.handle(EDGE_WIDGET_CHANNELS.beginDrag, (event) => {
    if (event.sender !== widget?.webContents) throw new Error('edge-widget-sender-required')
    beginDrag()
  })
  ipcMain.handle(EDGE_WIDGET_CHANNELS.finishDrag, (event, edge: unknown) => {
    if (event.sender !== widget?.webContents) throw new Error('edge-widget-sender-required')
    if (edge !== undefined && edge !== null && !isEdgeWidgetEdge(edge)) throw new Error('edge-widget-edge-invalid')
    finishDrag(edge)
  })
  ipcMain.handle(EDGE_WIDGET_CHANNELS.open, (event, action: unknown) => {
    if (event.sender !== widget?.webContents) throw new Error('edge-widget-sender-required')
    if (action === 'assistant') return openPath('/assistant/')
    if (action === 'privacy') return openPath('/exclusions/')
    if (action === 'dictation') {
      return toggleVoiceNote()
    }
    if (action === 'dictation-cancel') return cancelDictation()
    if (action === 'dictation-retry') return retryDictation()
    if (action === 'dictation-copy') return copyDictation()
    if (action === 'dictation-settings') {
      openPath('/notes/?preferences=1')
      return cancelDictation()
    }
    if (action !== 'conversation') throw new Error('edge-widget-action-invalid')
    const current = state()
    if (current.recording) return openPath('/conversations/')
    if (current.alwaysOn) return showConversationMenu()
    openPath('/conversations/?start=1')
  })
  const removeSettings = subscribeSettingsChanges(() => {
    dailyReviewState = getDailyReviewState()
    scheduleWake()
    sync()
  })
  const removeState = onDailyReviewStateChange((state) => {
    dailyReviewState = state
    sync()
  })
  const removeDictation = onDictationStateChange((state) => {
    dictationState = state
    if (dailyReviewState.modelDownloaded !== state.modelReady) {
      dailyReviewState = { ...dailyReviewState, modelDownloaded: state.modelReady }
    }
    sync()
  })
  const removeAgentAttention = subscribeAssistantAttention(() => publish())
  screen.on('display-added', position)
  screen.on('display-removed', position)
  screen.on('display-metrics-changed', position)
  powerMonitor.on('resume', resume)
  resume()

  return () => {
    disposed = true
    if (wakeTimer) clearTimeout(wakeTimer)
    contextMenu?.closePopup()
    contextMenu = null
    stopPositionTracking()
    clearDocking()
    removeSettings()
    removeState()
    removeDictation()
    removeAgentAttention()
    screen.removeListener('display-added', position)
    screen.removeListener('display-removed', position)
    screen.removeListener('display-metrics-changed', position)
    powerMonitor.removeListener('resume', resume)
    ipcMain.removeHandler(EDGE_WIDGET_CHANNELS.getState)
    ipcMain.removeHandler(EDGE_WIDGET_CHANNELS.open)
    ipcMain.removeHandler(EDGE_WIDGET_CHANNELS.beginDrag)
    ipcMain.removeHandler(EDGE_WIDGET_CHANNELS.finishDrag)
    ipcMain.removeAllListeners(EDGE_WIDGET_CHANNELS.setInteractive)
    ipcMain.removeAllListeners(EDGE_WIDGET_CHANNELS.showContextMenu)
    widget?.destroy()
    widget = null
  }
}
