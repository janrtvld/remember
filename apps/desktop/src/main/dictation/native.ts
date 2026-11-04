import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app, clipboard, systemPreferences } from 'electron'

const exec = promisify(execFile)

export function dictationDirectory() {
  return join(app.getPath('userData'), 'dictation')
}

function helperPath(name: string) {
  return app.isPackaged ? join(process.resourcesPath, name) : join(app.getAppPath(), 'native', name)
}

let accessibilityCheckedAt = 0
let accessibilityAllowed = false
export function accessibilityGranted() {
  if (Date.now() - accessibilityCheckedAt > 2000) {
    accessibilityAllowed = process.platform === 'darwin' && systemPreferences.isTrustedAccessibilityClient(false)
    accessibilityCheckedAt = Date.now()
  }
  return accessibilityAllowed
}

export async function insertDictation(text: string, autoInsert: boolean) {
  await clipboard.writeText(text)
  if (!autoInsert || !accessibilityGranted()) return 'copied' as const
  try {
    await exec(helperPath('key-paste'), [], { timeout: 5000 })
    return 'inserted' as const
  } catch {
    return 'copied' as const
  }
}

export async function controlOutput(action: 'duck' | 'restore' | 'playing') {
  if (process.platform !== 'darwin') return 'unsupported'
  try {
    mkdirSync(dictationDirectory(), { recursive: true })
    const args = action === 'playing' ? [action] : [action, join(dictationDirectory(), 'output-ducking.json')]
    const result = await exec(helperPath('output-volume-control'), args, { timeout: 2000 })
    return result.stdout.trim()
  } catch (error) {
    console.warn(`[dictation] Could not ${action} output volume`, error)
    return 'failed'
  }
}
