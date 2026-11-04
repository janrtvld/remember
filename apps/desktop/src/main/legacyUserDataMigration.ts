import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const LEGACY_USER_DATA_MIGRATION_MARKER = '.legacy-user-data-migration-complete'

const LEGACY_PRODUCT_NAMES = ['Daymark', 'Revinote Local'] as const
const LEGACY_ENTRIES = [
  'daily-review',
  'models',
  'settings.json',
  '.legacy-archive-import-complete',
  '.legacy-model-import-complete',
] as const

export function migrateLegacyUserDataAt(appDataDirectory: string, productName: string): string {
  const productDirectory = join(appDataDirectory, productName)
  const migrationMarker = join(productDirectory, LEGACY_USER_DATA_MIGRATION_MARKER)

  mkdirSync(productDirectory, { recursive: true })
  if (existsSync(migrationMarker)) return productDirectory

  for (const legacyName of LEGACY_PRODUCT_NAMES) {
    const legacyDirectory = join(appDataDirectory, legacyName)
    for (const entry of LEGACY_ENTRIES) {
      const source = join(legacyDirectory, entry)
      const target = join(productDirectory, entry)
      if (existsSync(source) && !existsSync(target)) cpSync(source, target, { recursive: true })
    }
  }

  writeFileSync(migrationMarker, `${new Date().toISOString()}\n`, 'utf8')
  return productDirectory
}
