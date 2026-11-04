import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { LEGACY_USER_DATA_MIGRATION_MARKER, migrateLegacyUserDataAt } from './legacyUserDataMigration'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('legacy user data migration', () => {
  it('runs once so deleted Remember data is not restored from a legacy directory', async () => {
    const appDataDirectory = await mkdtemp(join(tmpdir(), 'remember-legacy-migration-'))
    temporaryDirectories.push(appDataDirectory)
    const legacyDirectory = join(appDataDirectory, 'Daymark')
    await mkdir(legacyDirectory)
    await writeFile(join(legacyDirectory, 'settings.json'), 'legacy settings', 'utf8')

    const productDirectory = migrateLegacyUserDataAt(appDataDirectory, 'Remember')
    assert.equal(await readFile(join(productDirectory, 'settings.json'), 'utf8'), 'legacy settings')
    assert.notEqual(await readFile(join(productDirectory, LEGACY_USER_DATA_MIGRATION_MARKER), 'utf8'), '')

    await rm(join(productDirectory, 'settings.json'))
    migrateLegacyUserDataAt(appDataDirectory, 'Remember')

    await assert.rejects(readFile(join(productDirectory, 'settings.json'), 'utf8'), { code: 'ENOENT' })
  })
})
