import assert from 'node:assert/strict'
import test from 'node:test'
import { bundledClaudeExecutablePath, withClaudeRuntimeEnvironment } from '../claudeRuntimePaths'

test('resolves the packaged Claude runtime from Electron resources', () => {
  assert.equal(
    bundledClaudeExecutablePath({
      isPackaged: true,
      appPath: '/Applications/Remember.app/Contents/Resources/app.asar',
      resourcesPath: '/Applications/Remember.app/Contents/Resources',
      platform: 'darwin',
      architecture: 'arm64',
    }),
    '/Applications/Remember.app/Contents/Resources/claude'
  )
})

test('resolves the development Claude runtime from the desktop dependency', () => {
  assert.equal(
    bundledClaudeExecutablePath({
      isPackaged: false,
      appPath: '/workspace/apps/desktop',
      resourcesPath: '/unused',
      platform: 'darwin',
      architecture: 'arm64',
    }),
    '/workspace/apps/desktop/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'
  )
})

test('does not claim support for an unbundled Claude platform', () => {
  assert.equal(
    bundledClaudeExecutablePath({
      isPackaged: false,
      appPath: '/workspace/apps/desktop',
      resourcesPath: '/unused',
      platform: 'darwin',
      architecture: 'x64',
    }),
    null
  )
})

test('isolates credentials and identifies Claude runs as an SDK integration', () => {
  assert.deepEqual(
    withClaudeRuntimeEnvironment(
      {
        PATH: '/usr/bin:/bin',
        ANTHROPIC_API_KEY: 'ambient-api-key',
        CLAUDE_CODE_OAUTH_TOKEN: 'ambient-oauth-token',
        CLAUDE_CODE_USE_BEDROCK: '1',
        CLAUDE_CONFIG_DIR: '/Users/tom/.claude',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
      },
      '/Users/tom/Library/Application Support/Remember/claude'
    ),
    {
      PATH: '/usr/bin:/bin',
      CLAUDE_CONFIG_DIR: '/Users/tom/Library/Application Support/Remember/claude',
      CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
      CLAUDE_AGENT_SDK_VERSION: '0.3.317',
    }
  )
})
