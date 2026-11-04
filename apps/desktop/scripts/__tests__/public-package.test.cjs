const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const { finished } = require('node:stream/promises')
const test = require('node:test')
const { asarTools, assertStableVersion, verifyPublicPackage } = require('../verify-public-package.cjs')
const { escrowSourceMaps, verifySourceMaps } = require('../release-source-maps.cjs')
const { releaseAssets, assetRecords, readReleaseSource, verifyPreparedAssets } = require('../prepare-release.cjs')
const version = '0.2.299'

async function fixture(t, change = () => {}) {
  const root = mkdtempSync('/private/tmp/remember-public-package-')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const files = path.join(root, 'files')
  const app = path.join(root, 'Remember.app')
  const resources = path.join(app, 'Contents', 'Resources')
  const write = (name, contents) => {
    const file = path.join(files, name)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, contents)
  }
  mkdirSync(path.join(resources, 'licenses'), { recursive: true })
  for (const name of [
    'THIRD_PARTY_NOTICES.md',
    'codex-APACHE-2.0.txt',
    'claude-agent-sdk.txt',
    'electron-LICENSE.txt',
    'LICENSES.chromium.html',
  ])
    writeFileSync(path.join(resources, 'licenses', name), 'Synthetic notice fixture')
  write('package.json', JSON.stringify({ version, main: './out/main/index.js' }))
  write('out/main/index.js', '// package privacy fixture, not executable Remember')
  writeFileSync(
    path.join(resources, 'app-update.yml'),
    'provider: github\nowner: janrtvld\nrepo: remember\nchannel: latest\n'
  )
  change({ write, resources })
  const output = await asarTools().createPackage(files, path.join(resources, 'app.asar'))
  await finished(output)
  return { app, resources }
}

test('one public package requires stable metadata and the configured public updater', async (t) => {
  const f = await fixture(t)
  const verified = verifyPublicPackage(f.app, version)
  assert.equal(verified.version, version)
  assert.equal(verified.updater, 'public-latest')
  assert.ok(verified.contentScan.files > 0)
  for (const value of ['0.2.299-personal.1', '0.2.299 --publish always', '$(touch /tmp/x)', ''])
    assert.throws(() => assertStableVersion(value), /stable-version-required/)
  assert.throws(() => verifyPublicPackage(f.app, '0.2.300'), /metadata-mismatch/)
  writeFileSync(
    path.join(f.resources, 'app-update.yml'),
    'provider: github\nowner: someone-else\nrepo: remember\nchannel: latest'
  )
  assert.throws(() => verifyPublicPackage(f.app, version), /updater-invalid/)
})

test('private configuration, credentials, captures and source maps fail public verification', async (t) => {
  for (const name of [
    'resources/personal/capability.v1.json',
    'out/private-agent/runtime.json',
    'out/auth.json',
    'out/evidence.sqlite',
    'out/capture.wav',
    'out/main/index.js.map',
    'out/main/index.js.map.gz',
  ]) {
    const f = await fixture(t, ({ write }) => write(name, '{}'))
    assert.throws(() => verifyPublicPackage(f.app, version), /public-package-private-file/)
  }
  const f = await fixture(t)
  mkdirSync(path.join(f.resources, 'web'), { recursive: true })
  writeFileSync(path.join(f.resources, 'web', 'source.js.map'), '{}')
  assert.throws(() => verifyPublicPackage(f.app, version), /public-package-private-file/)
})

test('private values inside ordinary bundled code and resource files cannot ship', async (t) => {
  for (const content of [
    'const project = "/Users/jan/Developer/example"',
    'const project = "\\/Users\\/jan\\/Developer\\/example"',
    'const email = "jan@pionyr.nl"',
    `const key = "sk-proj-${'s'.repeat(40)}"`,
    `const key = "prefix-sk-proj-${'s'.repeat(40)}"`,
    `const key = "sk-svcacct-${'s'.repeat(40)}"`,
    `const key = "sk-admin-${'s'.repeat(40)}"`,
    `const key = "sk-${'s'.repeat(48)}"`,
    `const key = "sk-ant-api03-${'s'.repeat(40)}"`,
    `const key = "sk-ant-oat01-${'s'.repeat(40)}"`,
    `const key = "sk-ant-admin01-${'s'.repeat(40)}"`,
    `const key = "github_pat_${'s'.repeat(40)}"`,
    `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(100)}\n-----END PRIVATE KEY-----`,
    `//# sourceMappingURL=data:application/json;base64,${'A'.repeat(100)}`,
  ]) {
    const f = await fixture(t, ({ write }) => write('out/main/index.js', content))
    assert.throws(() => verifyPublicPackage(f.app, version), /public-package-private-content/)
  }
  const resource = await fixture(t)
  mkdirSync(path.join(resource.resources, 'web'), { recursive: true })
  writeFileSync(
    path.join(resource.resources, 'web', 'page.html'),
    `${'x'.repeat(1024 * 1024 - 5)}/Users/jan/Developer/private`
  )
  assert.throws(() => verifyPublicPackage(resource.app, version), /private-content:private-home-path:web\/page.html/)
})

test('adjacent public credential-prefix constants are not a provider credential or a file exemption', async (t) => {
  const constants = [
    'api.openai.comOPENAI_BASE_URL',
    'sk-proj-',
    'sk-svcacct-',
    'sk-admin-',
    'sk-',
    'sk-ant-',
    'sk-or-',
    'T3BlbkFJ',
    'public-provider-constant',
  ].join('')
  const f = await fixture(t, ({ write }) => write('out/main/index.js', constants))
  assert.ok(verifyPublicPackage(f.app, version).contentScan.files > 0)
  writeFileSync(path.join(f.resources, 'codex'), `${constants}\nsk-ant-api03-${'s'.repeat(40)}`)
  assert.throws(() => verifyPublicPackage(f.app, version), /private-content:provider-token:codex/)
})

test('a missing notice or escaping resource symlink cannot ship', async (t) => {
  const f = await fixture(t)
  rmSync(path.join(f.resources, 'licenses', 'THIRD_PARTY_NOTICES.md'))
  assert.throws(() => verifyPublicPackage(f.app, version), /license-missing/)
  const linked = await fixture(t)
  symlinkSync(__filename, path.join(linked.resources, 'outside'))
  assert.throws(() => verifyPublicPackage(linked.app, version), /external-symlink/)
})

test('source maps are retained privately, removed from build inputs and checked before publication', () => {
  const root = mkdtempSync('/private/tmp/remember-source-map-')
  try {
    const project = path.join(root, 'desktop')
    for (const name of ['out/main', 'out/preload', '../web/out']) {
      const directory = path.resolve(project, name)
      mkdirSync(directory, { recursive: true })
      writeFileSync(path.join(directory, 'entry.js'), '//# debugId=synthetic')
      writeFileSync(path.join(directory, 'entry.js.map'), '{"version":3}')
    }
    const result = escrowSourceMaps(project, version)
    assert.equal(result.maps, 3)
    assert.equal(verifySourceMaps(project, version).maps, 3)
    assert.throws(() => readFileSync(path.join(project, 'out/main/entry.js.map')), /ENOENT/)
    assert.equal(readFileSync(path.join(project, 'out/main/entry.js'), 'utf8'), '//# debugId=synthetic')
    writeFileSync(path.join(result.directory, 'unexpected.txt'), 'Must not be uploaded')
    assert.throws(() => verifySourceMaps(project, version), /source-map-inventory-mismatch/)
    rmSync(path.join(result.directory, 'unexpected.txt'))
    writeFileSync(path.join(result.directory, 'out/main/entry.js.map'), 'changed')
    assert.throws(() => verifySourceMaps(project, version), /source-map-modified/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

async function preparedFixture(t) {
  const directory = mkdtempSync('/private/tmp/remember-prepared-assets-')
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const assets = path.join(directory, 'release')
  mkdirSync(assets)
  writeFileSync(path.join(directory, '.gitignore'), 'release/\n')
  writeFileSync(path.join(directory, 'source.js'), 'Synthetic source')
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: directory })
  const commit = () => {
    git('add', '.')
    git(
      '-c',
      'user.name=Release test',
      '-c',
      'user.email=release@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'Synthetic fixture'
    )
  }
  git('init', '--quiet')
  commit()
  for (const name of releaseAssets) writeFileSync(path.join(assets, name), `Synthetic ${name}`)
  const manifest = {
    version,
    source: await readReleaseSource(directory),
    app: {
      version,
      updater: 'public-latest',
      contentScan: { files: 1, rules: 'private-paths-emails-keys-tokens-inline-maps' },
      appArchiveSha512: Buffer.alloc(64).toString('base64'),
      teamId: 'SYNTHETIC1',
      codeHash: 'a'.repeat(40),
    },
    sourceMapsSha512: Buffer.alloc(64).toString('base64'),
    sourceMapCount: 1,
    assets: await assetRecords(assets),
  }
  const save = () => writeFileSync(path.join(assets, 'prepared-release.json'), JSON.stringify(manifest))
  save()
  return {
    directory,
    assets,
    git,
    commit,
    manifest,
    save,
    verify: (releaseVersion = version) => verifyPreparedAssets(assets, releaseVersion, directory),
  }
}

test('publication rejects changed prepared artifacts and another version without rebuilding', async (t) => {
  const f = await preparedFixture(t)
  assert.equal((await f.verify()).version, version)
  await assert.rejects(() => f.verify('0.2.300'), /version-or-assets-mismatch/)
  writeFileSync(path.join(f.assets, 'Remember-arm64.zip'), 'different bytes')
  await assert.rejects(() => f.verify(), /asset-modified/)
})

test('prepare and publish require clean tracked and untracked source files', async (t) => {
  const f = await preparedFixture(t)
  for (const name of ['source.js', 'new-source.js']) {
    const file = path.join(f.directory, name)
    writeFileSync(file, 'Changed source')
    await assert.rejects(() => readReleaseSource(f.directory), /source-tree-dirty/)
    await assert.rejects(() => f.verify(), /source-tree-dirty/)
    if (name === 'source.js') f.git('restore', 'source.js')
    else rmSync(file)
  }
  assert.equal((await f.verify()).source.commit, f.manifest.source.commit)
})

test('publication rejects missing, malformed, dirty or stale source provenance', async (t) => {
  const f = await preparedFixture(t)
  const source = f.manifest.source
  for (const value of [undefined, { commit: 'main', dirty: false }, { commit: source.commit, dirty: true }]) {
    f.manifest.source = value
    f.save()
    await assert.rejects(() => f.verify(), /public-metadata-invalid/)
  }
  f.manifest.source = source
  f.save()
  writeFileSync(path.join(f.directory, 'source.js'), 'Next source commit')
  f.commit()
  await assert.rejects(() => readReleaseSource(f.directory, source.commit), /source-commit-mismatch/)
  await assert.rejects(() => f.verify(), /source-commit-mismatch/)
})

test('public provenance excludes extra fields and arbitrary values', async (t) => {
  const f = await preparedFixture(t)
  for (const change of [
    () => {
      f.manifest.privateData = 'Must never be published'
    },
    () => {
      f.manifest.app.privateData = 'Must never be published'
    },
    () => {
      f.manifest.app.teamId = '/private/local/signing/path'
    },
  ]) {
    change()
    f.save()
    await assert.rejects(() => f.verify(), /public-metadata-invalid/)
    delete f.manifest.privateData
    delete f.manifest.app.privateData
    f.manifest.app.teamId = 'SYNTHETIC1'
  }
})
