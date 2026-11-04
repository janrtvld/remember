import assert from 'node:assert/strict'
import test from 'node:test'
import { bundledCodexExecutablePath } from '../codexRuntimePaths'

test('resolves the packaged Codex runtime from Electron resources', () => {
  assert.equal(
    bundledCodexExecutablePath({
      isPackaged: true,
      appPath: '/Applications/Remember.app/Contents/Resources/app.asar',
      resourcesPath: '/Applications/Remember.app/Contents/Resources',
      platform: 'darwin',
      architecture: 'arm64',
    }),
    '/Applications/Remember.app/Contents/Resources/codex'
  )
})

test('resolves the development Codex runtime from the desktop dependency', () => {
  assert.equal(
    bundledCodexExecutablePath({
      isPackaged: false,
      appPath: '/workspace/apps/desktop',
      resourcesPath: '/unused',
      platform: 'darwin',
      architecture: 'arm64',
    }),
    '/workspace/apps/desktop/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex'
  )
})

test('does not claim support for an unbundled platform', () => {
  assert.equal(
    bundledCodexExecutablePath({
      isPackaged: false,
      appPath: '/workspace/apps/desktop',
      resourcesPath: '/unused',
      platform: 'darwin',
      architecture: 'x64',
    }),
    null
  )
})
