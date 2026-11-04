import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { deleteLocalDataAt } from '../dataResetFiles'
import { LEGACY_USER_DATA_MIGRATION_MARKER } from '../legacyUserDataMigration'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('deleteLocalDataAt', () => {
  it('removes all personal data without recreating compatibility markers', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'remember-reset-'))
    temporaryDirectories.push(userData)
    await Promise.all([
      mkdir(join(userData, 'daily-review', 'sessions'), { recursive: true }),
      mkdir(join(userData, 'integrations'), { recursive: true }),
      mkdir(join(userData, 'dictation'), { recursive: true }),
      mkdir(join(userData, 'models', 'parakeet'), { recursive: true }),
      mkdir(join(userData, 'local-analysis', 'models', 'balanced'), { recursive: true }),
      writeFile(join(userData, 'settings.json'), '{}'),
      writeFile(join(userData, 'settings.last-known-good.json'), '{}'),
      writeFile(join(userData, 'license.json'), '{"legacy":"license"}'),
      writeFile(join(userData, 'inbox-agent-context.json'), '{"work-item":{"projectPath":"/private/project"}}'),
      writeFile(join(userData, 'settings.invalid-1.json'), '{'),
      writeFile(join(userData, LEGACY_USER_DATA_MIGRATION_MARKER), 'complete'),
    ])
    await Promise.all([
      writeFile(join(userData, 'daily-review', 'sessions', 'audio.wav'), 'private audio'),
      writeFile(join(userData, 'integrations', 'revinote-credentials.enc'), 'encrypted credentials'),
      writeFile(join(userData, 'dictation', 'last-recording.wav'), 'private dictation'),
      writeFile(join(userData, 'models', 'parakeet', 'model.onnx'), 'model'),
      writeFile(join(userData, 'local-analysis', 'models', 'balanced', 'qwen.gguf'), 'local analysis model'),
    ])

    await deleteLocalDataAt(userData)

    assert.equal(existsSync(join(userData, 'daily-review')), false)
    assert.equal(existsSync(join(userData, 'integrations')), false)
    assert.equal(existsSync(join(userData, 'dictation')), false)
    assert.equal(existsSync(join(userData, 'models')), false)
    assert.equal(existsSync(join(userData, 'local-analysis')), false)
    assert.equal(existsSync(join(userData, 'settings.json')), false)
    assert.equal(existsSync(join(userData, 'settings.last-known-good.json')), false)
    assert.equal(existsSync(join(userData, 'license.json')), false)
    assert.equal(existsSync(join(userData, 'inbox-agent-context.json')), false)
    assert.equal(existsSync(join(userData, 'settings.invalid-1.json')), false)
    assert.equal(existsSync(join(userData, LEGACY_USER_DATA_MIGRATION_MARKER)), true)
    assert.equal(existsSync(join(userData, '.legacy-archive-import-complete')), false)
    assert.equal(existsSync(join(userData, '.legacy-model-import-complete')), false)
  })

  it('fails closed when a retired local-analysis directory survives deletion', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'remember-reset-'))
    temporaryDirectories.push(userData)
    await mkdir(join(userData, 'local-analysis', 'models', 'balanced'), { recursive: true })
    await writeFile(join(userData, 'local-analysis', 'models', 'balanced', 'qwen.gguf'), 'local analysis model')

    await assert.rejects(
      deleteLocalDataAt(userData, async () => undefined),
      /local-data-reset-incomplete:local-analysis/
    )
  })
})
