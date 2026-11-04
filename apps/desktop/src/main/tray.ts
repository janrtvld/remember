import { join } from 'node:path'
import { app, Menu, nativeImage, Tray } from 'electron'
import {
  getDailyReviewState,
  onDailyReviewStateChange,
  pauseDailyReviewSourcesFor,
  resumeDailyReview,
} from './dailyReview'
import { localText } from './localization'
import { getInterfaceLocale, getSettings } from './settings'
import { getTrayPauseActions, getTrayPresentation, getTrayUpdatePresentation } from './trayPresentation'
import { checkForUpdates, downloadUpdate, getUpdateState, onUpdateStateChange, restartToUpdate } from './updater'

let tray: Tray | null = null
let removeDailyReviewStateListener: (() => void) | null = null
let removeUpdateStateListener: (() => void) | null = null
let rebuildCurrentTray: (() => void) | null = null

const ONE_HOUR_MS = 60 * 60 * 1_000

function trayImage(filename: 'trayTemplate.png' | 'trayPausedTemplate.png') {
  // app.getAppPath() is apps/desktop in development and app.asar when packaged.
  // The adjacent @2x asset is discovered automatically from this Template name.
  const iconPath = join(app.getAppPath(), 'resources', filename)
  const image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) {
    throw new Error(`Could not load tray icon: ${iconPath}`)
  }
  image.setTemplateImage(true)
  return image
}

export function disposeTray() {
  removeDailyReviewStateListener?.()
  removeDailyReviewStateListener = null
  removeUpdateStateListener?.()
  removeUpdateStateListener = null
  if (tray && !tray.isDestroyed()) tray.destroy()
  tray = null
  rebuildCurrentTray = null
}

export function refreshTray() {
  rebuildCurrentTray?.()
}

export function createTray({
  showWindow,
  showSettings,
  showPauseDialog,
  startupError = false,
}: {
  showWindow: () => void
  showSettings: () => void
  showPauseDialog: () => void
  startupError?: boolean
}) {
  disposeTray()
  const images = {
    normal: trayImage('trayTemplate.png'),
    paused: trayImage('trayPausedTemplate.png'),
  }
  const currentTray = new Tray(images.normal)
  tray = currentTray
  let lastPresentation: string | null = null

  const rebuild = (state = getDailyReviewState()) => {
    if (currentTray.isDestroyed()) return
    const settings = getSettings()
    const locale = getInterfaceLocale()
    const presentation = getTrayPresentation(
      {
        status: state.status,
        capturePausedUntil: settings.capturePausedUntil,
        pauseReason: state.pauseReason,
        nextScheduleTransitionAt: state.nextScheduleTransitionAt,
        now: Date.now(),
      },
      locale
    )
    const updatePresentation = getTrayUpdatePresentation(getUpdateState(), locale, settings.offlineMode)
    const presentationKey = JSON.stringify([locale, presentation, updatePresentation])
    if (presentationKey === lastPresentation) return
    lastPresentation = presentationKey
    const pauseActions = getTrayPauseActions(locale)
    currentTray.setImage(images[presentation.icon])
    currentTray.setToolTip(updatePresentation.tooltip ?? presentation.tooltip)
    currentTray.setContextMenu(
      Menu.buildFromTemplate([
        { label: localText(locale, 'Open Remember', 'Open Remember'), click: showWindow },
        ...(!startupError
          ? [
              { label: localText(locale, 'Open instellingen', 'Open settings'), click: showSettings },
              { type: 'separator' as const },
            ]
          : []),
        ...(!startupError && presentation.canResume
          ? [
              {
                label: presentation.pauseActionLabel,
                enabled: presentation.canResume,
                click: async () => {
                  await resumeDailyReview()
                },
              },
            ]
          : []),
        ...(!startupError
          ? pauseActions.map(({ action, label }) => ({
              label,
              click: () => {
                if (action === 'dialog') {
                  showPauseDialog()
                  return
                }
                void pauseDailyReviewSourcesFor([action === 'audio-one-hour' ? 'audio' : 'capture'], ONE_HOUR_MS)
              },
            }))
          : []),
        {
          label: updatePresentation.label,
          enabled: updatePresentation.enabled,
          click: async () => {
            if (updatePresentation.action === 'restart') {
              restartToUpdate()
              return
            }
            if (updatePresentation.action === 'download') {
              await downloadUpdate()
              return
            }
            if (updatePresentation.action === 'check') await checkForUpdates()
          },
        },
        { type: 'separator' },
        { label: localText(locale, 'Stop Remember', 'Quit Remember'), role: 'quit', click: () => app.quit() },
      ])
    )
  }

  rebuild()
  rebuildCurrentTray = rebuild
  removeDailyReviewStateListener = onDailyReviewStateChange(rebuild)
  removeUpdateStateListener = onUpdateStateChange(() => rebuild())
  return {
    rebuild,
    dispose: () => {
      if (tray === currentTray) disposeTray()
    },
  }
}
