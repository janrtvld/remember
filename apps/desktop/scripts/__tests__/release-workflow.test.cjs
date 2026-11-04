const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')

function fixture(t) {
  const directory = mkdtempSync('/private/tmp/remember-release-workflow-')
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const desktop = path.join(directory, 'desktop')
  const bin = path.join(directory, 'bin')
  mkdirSync(path.join(desktop, 'scripts'), { recursive: true })
  mkdirSync(bin)
  copyFileSync(path.join(__dirname, '../release.sh'), path.join(desktop, 'scripts/release.sh'))
  writeFileSync(path.join(desktop, 'package.json'), JSON.stringify({ version: '0.2.299' }))
  for (const name of ['node', 'pnpm', 'gh', 'electron-builder']) {
    writeFileSync(
      path.join(bin, name),
      `#!${process.execPath}
const {appendFileSync}=require('node:fs');
const args=process.argv.slice(2);
appendFileSync(process.env.COMMAND_LOG,JSON.stringify({name:${JSON.stringify(name)},args})+'\\n');
if (${JSON.stringify(name)}==='node' && args[0]==='-p') console.log(args[1].includes('prepared-release.json') ? 'a'.repeat(40) : '0.2.299');
if (${JSON.stringify(name)}==='node' && args.join(' ')==='scripts/prepare-release.cjs --source') {
  if (process.env.FAIL_SOURCE==='1') process.exit(1);
  console.log('a'.repeat(40));
}
if (${JSON.stringify(name)}==='node' && args.join(' ')==='scripts/prepare-release.cjs --verify' && process.env.FAIL_SOURCE==='1') process.exit(1);
if (process.env.FAIL_VERSION==='1' && args[0]==='scripts/verify-release-version.cjs') process.exit(1);
if (process.env.FAIL_MAPS==='1' && args[0]==='scripts/release-source-maps.cjs') process.exit(1);
if (${JSON.stringify(name)}==='gh' && args.includes('isDraft')) {
  if (process.env.MISSING_RELEASE==='1') { console.error('release not found'); process.exit(1); }
  console.log('true');
}
if (${JSON.stringify(name)}==='gh' && args.includes('assets')) console.log('Remember-arm64.dmg\\nRemember-arm64.dmg.blockmap\\nRemember-arm64.zip\\nRemember-arm64.zip.blockmap\\nlatest-mac.yml\\nprepared-release.json');
`,
      { mode: 0o700 }
    )
  }
  const log = path.join(directory, 'commands.jsonl')
  const env = {
    ...process.env,
    PATH: `${bin}:/usr/bin:/bin`,
    COMMAND_LOG: log,
    APPLE_TEAM_ID: 'SYNTHETIC_TEAM',
    APPLE_ID: '',
    APPLE_APP_SPECIFIC_PASSWORD: '',
    APPLE_API_KEY: '',
    APPLE_API_KEY_ID: '',
    APPLE_API_ISSUER: '',
    APPLE_KEYCHAIN: '',
    APPLE_KEYCHAIN_PROFILE: 'synthetic-test-profile',
    SENTRY_AUTH_TOKEN: 'synthetic-test-token',
    SENTRY_ORG: 'synthetic-test-org',
    SENTRY_PROJECT: 'synthetic-test-project',
  }
  return {
    desktop,
    directory,
    run: (mode, extra = {}) =>
      execFileSync('/bin/bash', [path.join(desktop, 'scripts/release.sh'), mode], { env: { ...env, ...extra } }),
    runCommand: (command, extra = {}) =>
      execFileSync('/bin/bash', ['-c', command], { cwd: desktop, env: { ...env, ...extra } }),
    commands: () => readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse),
  }
}

test('prepare builds and verifies locally without any publication call', (t) => {
  const f = fixture(t)
  f.run('--prepare')
  const commands = f.commands()
  assert.ok(commands.some(({ name, args }) => name === 'node' && args[0] === 'scripts/verify-release-version.cjs'))
  assert.ok(commands.some(({ name, args }) => name === 'pnpm' && args.join(' ') === '--filter @remember/web build'))
  assert.ok(
    commands.some(({ name, args }) => name === 'pnpm' && args.includes('electron-builder') && args.includes('never'))
  )
  assert.ok(commands.some(({ name, args }) => name === 'node' && args[0] === 'scripts/prepare-release.cjs'))
  assert.ok(
    commands.some(
      ({ name, args }) =>
        name === 'node' && args.join(' ') === `scripts/prepare-release.cjs --prepare ${'a'.repeat(40)}`
    )
  )
  const source = commands.findIndex(({ args }) => args.join(' ') === 'scripts/prepare-release.cjs --source')
  assert.ok(source >= 0 && source < commands.findIndex(({ name }) => name === 'pnpm'))
  assert.ok(!commands.some(({ name }) => name === 'gh'))
  assert.ok(!commands.some(({ args }) => args.includes('upload')))
})

test('prepare accepts each supported notarization input mode without requiring publish credentials', (t) => {
  for (const mode of ['apple-id', 'api-key', 'keychain', 'custom-keychain']) {
    const f = fixture(t)
    const apiKey = path.join(f.directory, 'synthetic.p8')
    writeFileSync(apiKey, 'Synthetic test key file')
    const credentials =
      mode === 'apple-id'
        ? {
            APPLE_ID: 'signer@example.test',
            APPLE_APP_SPECIFIC_PASSWORD: 'synthetic-password',
            APPLE_KEYCHAIN_PROFILE: '',
          }
        : mode === 'api-key'
          ? {
              APPLE_API_KEY: apiKey,
              APPLE_API_KEY_ID: 'SYNTHETIC_KEY',
              APPLE_API_ISSUER: 'synthetic-issuer',
              APPLE_KEYCHAIN_PROFILE: '',
            }
          : mode === 'custom-keychain'
            ? { APPLE_KEYCHAIN_PROFILE: 'synthetic-profile', APPLE_KEYCHAIN: '/synthetic/keychain' }
            : { APPLE_KEYCHAIN_PROFILE: 'synthetic-profile' }
    f.run('--prepare', { ...credentials, SENTRY_AUTH_TOKEN: '', SENTRY_ORG: '', SENTRY_PROJECT: '' })
    assert.ok(
      f.commands().some(({ args }) => args.includes('electron-builder')),
      mode
    )
  }
})

test('missing or partial notarization inputs fail before removing artifacts, building or publishing', (t) => {
  for (const credentials of [
    { APPLE_KEYCHAIN_PROFILE: '' },
    { APPLE_ID: 'signer@example.test' },
    { APPLE_APP_SPECIFIC_PASSWORD: 'synthetic-password' },
    { APPLE_API_KEY: '/synthetic/missing.p8' },
    { APPLE_API_KEY_ID: 'SYNTHETIC_KEY' },
    { APPLE_API_ISSUER: 'synthetic-issuer' },
    { APPLE_API_KEY: '/synthetic/missing.p8', APPLE_API_KEY_ID: 'SYNTHETIC_KEY', APPLE_API_ISSUER: 'synthetic-issuer' },
  ]) {
    const f = fixture(t)
    mkdirSync(path.join(f.desktop, 'release'))
    const existing = path.join(f.desktop, 'release', 'existing-artifact')
    writeFileSync(existing, 'Keep these prepared bytes')
    assert.throws(() => f.run('--prepare', credentials))
    assert.equal(readFileSync(existing, 'utf8'), 'Keep these prepared bytes')
    assert.ok(!f.commands().some(({ name }) => name === 'pnpm' || name === 'gh'))
  }
})

test('publish verifies the prepared bytes before uploading and never builds', (t) => {
  const f = fixture(t)
  for (const directory of ['out/main', 'out/preload', 'web']) {
    const maps = path.join(f.desktop, '.release-source-maps/0.2.299', directory)
    mkdirSync(maps, { recursive: true })
    writeFileSync(path.join(maps, 'entry.js.map'), '{"version":3}')
  }
  f.run('--publish', { MISSING_RELEASE: '1' })
  const commands = f.commands()
  const verified = commands.findIndex(
    ({ name, args }) => name === 'node' && args.join(' ') === 'scripts/prepare-release.cjs --verify'
  )
  const uploaded = commands.findIndex(({ name, args }) => name === 'gh' && args.includes('upload'))
  assert.ok(verified >= 0 && uploaded > verified)
  assert.ok(!commands.some(({ args }) => args.includes('build') || args.includes('electron-builder')))
  assert.ok(commands.some(({ name, args }) => name === 'gh' && args.includes('--draft=false')))
  assert.ok(commands[uploaded].args.includes('release/prepared-release.json'))
  const created = commands.find(({ name, args }) => name === 'gh' && args.includes('create'))
  assert.equal(created.args[created.args.indexOf('--repo') + 1], 'janrtvld/remember')
  assert.equal(created.args[created.args.indexOf('--target') + 1], 'a'.repeat(40))
  const published = commands.find(({ name, args }) => name === 'gh' && args.includes('--draft=false'))
  assert.ok(published.args[published.args.indexOf('--notes') + 1].includes(`Source commit: ${'a'.repeat(40)}`))
})

test('source provenance failure prevents replacing prepared artifacts and all publication calls', (t) => {
  for (const mode of ['--prepare', '--publish']) {
    const f = fixture(t)
    mkdirSync(path.join(f.desktop, 'release'))
    const existing = path.join(f.desktop, 'release', 'existing-artifact')
    writeFileSync(existing, 'Keep these prepared bytes')
    assert.throws(() => f.run(mode, { FAIL_SOURCE: '1' }))
    assert.equal(readFileSync(existing, 'utf8'), 'Keep these prepared bytes')
    assert.ok(!f.commands().some(({ name }) => name === 'pnpm' || name === 'gh'))
  }
})

test('mismatched source versions fail before replacing an existing prepared release', (t) => {
  const f = fixture(t)
  mkdirSync(path.join(f.desktop, 'release'))
  const existing = path.join(f.desktop, 'release', 'existing-artifact')
  writeFileSync(existing, 'Keep these prepared bytes')
  assert.throws(() => f.run('--prepare', { FAIL_VERSION: '1' }))
  assert.equal(readFileSync(existing, 'utf8'), 'Keep these prepared bytes')
  assert.ok(!f.commands().some(({ args }) => args.includes('build')))
})

test('ad-hoc packaging escrows source maps before builder and never publishes', (t) => {
  const command = JSON.parse(readFileSync(path.join(__dirname, '../../package.json'), 'utf8')).scripts['package:adhoc']
  const f = fixture(t)
  f.runCommand(command)
  const commands = f.commands()
  const escrow = commands.findIndex(
    ({ name, args }) => name === 'node' && args[0] === 'scripts/release-source-maps.cjs'
  )
  const packaged = commands.findIndex(({ name }) => name === 'electron-builder')
  assert.ok(escrow >= 0 && packaged > escrow)
  assert.equal(commands[packaged].args[commands[packaged].args.indexOf('--publish') + 1], 'never')
  const failed = fixture(t)
  assert.throws(() => failed.runCommand(command, { FAIL_MAPS: '1' }))
  assert.ok(!failed.commands().some(({ name }) => name === 'electron-builder'))
})
