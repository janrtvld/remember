const assert = require('node:assert/strict')
const { mkdtemp, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { verifyMainBundle, verifyPreloadBundle } = require('../verify-main-bundle.cjs')

test('bundle verification ignores JSDoc and source examples while checking actual runtime imports', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'remember-main-bundle-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const entry = path.join(directory, 'entry.js')
  const allowed = `
    import { app } from 'electron';
    export { readFile } from 'node:fs/promises';
    const local = () => import('./local.js');
    /** @param {import('estree').Program} program */
    function parse(program) { return program; }
    // import('comment-only-package')
    const example = "import('example-only-package')";
    const expression = /import('regex-only-package')/;
  `
  await writeFile(entry, allowed)
  await verifyMainBundle(directory)
  for (const runtimeImport of [
    `import missing from 'missing-static-package';`,
    `export * from 'missing-export-package';`,
    `const load = () => import('missing-dynamic-package');`,
  ]) {
    await writeFile(entry, `${allowed}\n${runtimeImport}`)
    await assert.rejects(verifyMainBundle(directory), /unpackaged runtime import:[\s\S]*missing-/)
  }

  const preload = `
    const { contextBridge } = require('electron');
    /** @see require('comment-only-package') */
    const example = "require('example-only-package')";
  `
  await writeFile(entry, preload)
  await verifyPreloadBundle(directory)
  await writeFile(entry, `${preload}\nconst missing = require('missing-runtime-package');`)
  await assert.rejects(verifyPreloadBundle(directory), /unpackaged runtime import:[\s\S]*missing-runtime-package/)
})
