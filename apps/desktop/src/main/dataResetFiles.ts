import { existsSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

// Older versions downloaded llama models here. Reset still removes those orphaned files; no runtime reads this path.
const LEGACY_LOCAL_ANALYSIS_DATA_ENTRY = 'local-analysis'
const RESET_ENTRIES = [
  'daily-review',
  'dictation',
  'models',
  LEGACY_LOCAL_ANALYSIS_DATA_ENTRY,
  'integrations',
  'inbox-agent-context.json',
  'license.json',
  'settings.json',
  'settings.last-known-good.json',
] as const

export async function deleteLocalDataAt(
  userData: string,
  removeEntry: (target: string) => Promise<void> = (target) => rm(target, { recursive: true, force: true })
): Promise<void> {
  await Promise.all(RESET_ENTRIES.map((entry) => removeEntry(join(userData, entry))))
  const recoveryEntries = await readdir(userData).catch(() => [])
  const settingsRecoveryEntries = recoveryEntries.filter(
    (entry) => entry.startsWith('settings.invalid-') || entry.endsWith('.json.tmp')
  )
  await Promise.all(settingsRecoveryEntries.map((entry) => removeEntry(join(userData, entry))))

  const remaining = [...RESET_ENTRIES, ...settingsRecoveryEntries].filter((entry) => existsSync(join(userData, entry)))
  if (remaining.length > 0) throw new Error(`local-data-reset-incomplete:${remaining.join(',')}`)
}
