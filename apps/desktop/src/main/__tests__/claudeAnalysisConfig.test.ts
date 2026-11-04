import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  claudeAnalysisConfigPath,
  claudeAnalysisEnvironment,
  initializeClaudeAnalysisConfig,
  loadClaudeAnalysisConfig,
  redactClaudeAnalysisSecrets,
} from '../claudeAnalysisConfig'

const directories: string[] = []

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), 'remember-claude-config-'))
  directories.push(directory)
  return directory
}

function writeConfig(directory: string, value: unknown, mode = 0o600) {
  const configPath = claudeAnalysisConfigPath(directory)
  writeFileSync(configPath, typeof value === 'string' ? value : JSON.stringify(value), { mode })
  chmodSync(configPath, mode)
  return configPath
}

afterEach(() => {
  const emptyDirectory = temporaryDirectory()
  initializeClaudeAnalysisConfig(emptyDirectory)
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Claude analysis configuration', () => {
  it('leaves the Claude environment unchanged when the optional file is absent', () => {
    const directory = temporaryDirectory()
    assert.equal(loadClaudeAnalysisConfig(directory).status, 'absent')
    initializeClaudeAnalysisConfig(directory)
    const environment = { PATH: '/usr/bin' }
    assert.equal(claudeAnalysisEnvironment(environment), environment)
  })

  it('passes only the validated endpoint and token to the Claude analysis environment', () => {
    const directory = temporaryDirectory()
    writeConfig(directory, {
      ANTHROPIC_BASE_URL: 'https://gateway.example.test/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'test-token-value',
    })
    initializeClaudeAnalysisConfig(directory)

    assert.deepEqual(claudeAnalysisEnvironment({ PATH: '/usr/bin', UNRELATED: 'preserved' }), {
      PATH: '/usr/bin',
      UNRELATED: 'preserved',
      ANTHROPIC_BASE_URL: 'https://gateway.example.test/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'test-token-value',
    })
  })

  it('rejects malformed, insecure, over-permissive, and unknown configuration', () => {
    const cases: Array<[string, unknown, number]> = [
      ['malformed JSON', '{', 0o600],
      [
        'non-HTTPS endpoint',
        { ANTHROPIC_BASE_URL: 'http://gateway.example.test', ANTHROPIC_AUTH_TOKEN: 'token' },
        0o600,
      ],
      [
        'embedded credentials',
        { ANTHROPIC_BASE_URL: 'https://user:pass@gateway.example.test', ANTHROPIC_AUTH_TOKEN: 'token' },
        0o600,
      ],
      [
        'unknown key',
        { ANTHROPIC_BASE_URL: 'https://gateway.example.test', ANTHROPIC_AUTH_TOKEN: 'token', DEBUG: '1' },
        0o600,
      ],
      [
        'broad permissions',
        { ANTHROPIC_BASE_URL: 'https://gateway.example.test', ANTHROPIC_AUTH_TOKEN: 'token' },
        0o644,
      ],
    ]

    for (const [label, value, mode] of cases) {
      const directory = temporaryDirectory()
      writeConfig(directory, value, mode)
      assert.equal(loadClaudeAnalysisConfig(directory).status, 'invalid', label)
    }
  })

  it('redacts even opaque configured tokens from captured output', () => {
    const directory = temporaryDirectory()
    const token = 'opaque-value-that-does-not-look-like-a-standard-token'
    writeConfig(directory, {
      ANTHROPIC_BASE_URL: 'https://gateway.example.test',
      ANTHROPIC_AUTH_TOKEN: token,
    })
    initializeClaudeAnalysisConfig(directory)

    assert.equal(redactClaudeAnalysisSecrets(`request failed for ${token}`), 'request failed for [credential redacted]')
  })

  it('does not repeat a token from unsafe configuration in its failure', () => {
    const directory = temporaryDirectory()
    const token = 'opaque-unsafe-config-token'
    writeConfig(directory, {
      ANTHROPIC_BASE_URL: 'http://gateway.example.test',
      ANTHROPIC_AUTH_TOKEN: token,
    })
    const state = initializeClaudeAnalysisConfig(directory)

    assert.equal(state.status, 'invalid')
    assert.doesNotMatch(JSON.stringify(state), new RegExp(token))
    assert.throws(
      () => claudeAnalysisEnvironment({ PATH: '/usr/bin' }),
      (error) => {
        assert.ok(error instanceof Error)
        assert.equal(error.message, 'claude-config-invalid')
        assert.doesNotMatch(`${error.message} ${String(error.cause)}`, new RegExp(token))
        return true
      }
    )
  })
})
