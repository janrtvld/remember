import { type LocalSettings, resolveInterfaceLocale } from '@remember/shared'
import { app, nativeTheme } from 'electron'
import { createCachedSettingsStore, type SettingsHealth } from './settingsStore'

const settingsStore = createCachedSettingsStore()
const settingsListeners = new Set<() => void>()

export function subscribeSettingsChanges(listener: () => void) {
  settingsListeners.add(listener)
  return () => {
    settingsListeners.delete(listener)
  }
}

function emitSettingsChanged() {
  for (const listener of settingsListeners) listener()
}

function settingsDirectory() {
  return app.getPath('userData')
}

export function getSettings() {
  return settingsStore.get(settingsDirectory())
}

export function getSettingsHealth(): SettingsHealth {
  return settingsStore.refresh(settingsDirectory()).health
}

export function repairSettings(action: 'restore-last-known-good' | 'use-safe-settings') {
  const settings = settingsStore.repair(settingsDirectory(), action)
  applyLoginItem(settings)
  applyInterfaceTheme(settings)
  emitSettingsChanged()
  return settings
}

function applyLoginItem(settings: LocalSettings) {
  if (process.platform !== 'darwin' || !app.isPackaged) return
  app.setLoginItemSettings({
    openAtLogin: settings.launchAtLogin,
  })
}

export function updateSettings(patch: Partial<LocalSettings>) {
  const next = settingsStore.update(settingsDirectory(), patch, Date.now())
  applyLoginItem(next)
  applyInterfaceTheme(next)
  emitSettingsChanged()
  return next
}

function applyInterfaceTheme(settings: LocalSettings) {
  nativeTheme.themeSource = settings.interfaceTheme
}

export function applyLaunchAtLoginSetting() {
  applyLoginItem(getSettings())
}

export function applyInterfaceThemeSetting() {
  applyInterfaceTheme(getSettings())
}

export function getInterfaceLocale() {
  return resolveInterfaceLocale(getSettings().interfaceLanguage, app.getLocale())
}
