import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'

const require = createRequire(import.meta.url)
const { verifyMainBundle, verifyPreloadBundle } = require('../../../scripts/verify-main-bundle.cjs') as {
  verifyMainBundle: (outputDirectory: string) => Promise<void>
  verifyPreloadBundle: (outputDirectory: string) => Promise<void>
}
const temporaryDirectories: string[] = []

async function createBundle(files: Record<string, string>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'remember-main-bundle-test-'))
  temporaryDirectories.push(directory)
  await Promise.all(
    Object.entries(files).map(async ([relativePath, source]) => {
      const filePath = path.join(directory, relativePath)
      await mkdir(path.dirname(filePath), { recursive: true })
      await writeFile(filePath, source)
    })
  )
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

test('accepts built-in, Electron, and bundled chunk imports', async () => {
  const directory = await createBundle({
    'index.js': `
      import { readFile } from 'node:fs/promises'
      import { app } from 'electron'
      export { value } from './chunks/value.js'
      const chunk = import('./chunks/lazy.js')
    `,
    'chunks/value.js': 'export const value = 1',
    'chunks/lazy.js': 'export const lazy = true',
  })

  await assert.doesNotReject(verifyMainBundle(directory))
})

test('recognizes side-effect and minified ESM imports', async () => {
  const directory = await createBundle({
    'index.js': `
      import "side-effect-package";
      import{value}from"minified-package";
    `,
  })

  await assert.rejects(verifyMainBundle(directory), /index\.js: side-effect-package[\s\S]*index\.js: minified-package/)
})

test('rejects static and dynamic third-party runtime imports', async () => {
  const directory = await createBundle({
    'index.js': `
      import { diff3Merge } from 'node-diff3'
      const dependency = import('another-package')
    `,
  })

  await assert.rejects(verifyMainBundle(directory), /index\.js: node-diff3[\s\S]*index\.js: another-package/)
})

test('fails closed when the main bundle has no inspectable ESM imports', async () => {
  const directory = await createBundle({ 'index.js': 'console.log("built")' })

  await assert.rejects(verifyMainBundle(directory), /output format may have changed/)
})

test('ignores JSDoc type imports and import examples inside comments and strings', async () => {
  const directory = await createBundle({
    'index.js': `
      import { app } from 'electron'
      /** @param {import('estree').Program} node */
      function inspect(node) { return node }
      // import('comment-example')
      const example = "import('string-example')"
    `,
  })
  await assert.doesNotReject(verifyMainBundle(directory))
})

test('commented imports cannot satisfy the main bundle import requirement', async () => {
  const directory = await createBundle({
    'index.js': '/** @type {import("fake-runtime-import").Value} */ const value=1',
  })
  await assert.rejects(verifyMainBundle(directory), /output format may have changed/)
})

test('accepts packaged preload requires and rejects third-party packages', async () => {
  const accepted = await createBundle({ 'index.cjs': `const { contextBridge } = require('electron')` })
  const rejected = await createBundle({ 'index.cjs': `const dependency = require('unpackaged-preload-dependency')` })

  await assert.doesNotReject(verifyPreloadBundle(accepted))
  await assert.rejects(verifyPreloadBundle(rejected), /index\.cjs: unpackaged-preload-dependency/)
})
