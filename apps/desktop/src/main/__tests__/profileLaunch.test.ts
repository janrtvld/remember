import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { profileLaunchDirectory } from '../profileLaunch'
import { developmentUserDataDirectory } from '../userDataDirectory'

function fixture(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync('/private/tmp/remember-public-profile-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const profile = path.join(root, 'profile')
  mkdirSync(profile, { mode: 0o700 })
  const environment = { isPackaged: true, uid: process.getuid?.() ?? -1 }
  const select = (argv = [`--remember-profile=${profile}`]) => profileLaunchDirectory(argv, environment)
  return { root, profile, environment, select }
}

test('a fresh public profile needs no edition, capability, installation or remote configuration files', (t) => {
  const f = fixture(t)
  assert.deepEqual(readdirSync(f.profile), [])
  assert.equal(f.select(), f.profile)
  assert.deepEqual(readdirSync(f.profile), [])
  const privateDirectory = path.join(f.profile, 'private-agent')
  mkdirSync(privateDirectory)
  writeFileSync(path.join(privateDirectory, 'runtime.json'), '{old-invalid-private-data')
  assert.equal(f.select(), f.profile)
})

test('ordinary launch keeps the default profile and does not create a requested absent profile', (t) => {
  const f = fixture(t)
  assert.equal(f.select(['Remember', '--other-argument']), null)
  const missing = path.join(f.root, 'absent')
  assert.throws(() => f.select([`--remember-profile=${missing}`]), /ENOENT/)
  assert.equal(existsSync(missing), false)
})

test('ambiguous and noncanonical profile selectors fail without touching any files', (t) => {
  const f = fixture(t)
  for (const argv of [
    ['--remember-profile'],
    [`--remember-profile=${f.profile}`, `--remember-profile=${f.profile}`],
    ['--remember-profile='],
    ['--remember-profile=relative'],
    ['--remember-profile=/'],
    [`--remember-profile=${f.profile}/`],
    [`--remember-profile=${f.root}/other/../profile`],
    [`--remember-profile=${f.root}//profile`],
    [`--remember-profile=${f.profile}\n`],
  ])
    assert.throws(() => f.select(argv), /profile-(argument|path)-invalid/)
  assert.deepEqual(readdirSync(f.profile), [])
})

test('an explicit packaged selector still requires a private directory owned by the current OS user', (t) => {
  const f = fixture(t)
  f.environment.uid += 1
  assert.throws(() => f.select(), /profile-owner/)
  f.environment.uid -= 1
  for (const mode of [0o755, 0o1700]) {
    chmodSync(f.profile, mode)
    assert.throws(() => f.select(), /profile-permissions/)
  }
})

test('symlinks, ancestor aliases and ordinary files cannot redirect the profile', (t) => {
  const f = fixture(t)
  const alias = path.join(f.root, 'alias')
  const ancestor = path.join(f.root, 'alias-parent')
  const file = path.join(f.root, 'file')
  symlinkSync(f.profile, alias)
  symlinkSync(f.root, ancestor)
  writeFileSync(file, 'data')
  for (const profile of [alias, `${ancestor}/profile`, file])
    assert.throws(() => f.select([`--remember-profile=${profile}`]), /profile-path-unsafe/)
})

test('packaged environment variables cannot select a profile; development keeps its existing explicit contract', (t) => {
  const f = fixture(t)
  assert.equal(developmentUserDataDirectory(f.profile, true), null)
  assert.equal(developmentUserDataDirectory(f.profile, false), f.profile)
  f.environment.isPackaged = false
  assert.equal(f.select([]), null)
  assert.throws(() => f.select(), /profile-packaged-required/)
})
