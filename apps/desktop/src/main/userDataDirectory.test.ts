import assert from 'node:assert/strict'
import test from 'node:test'
import { developmentUserDataDirectory } from './userDataDirectory'

test('uses an absolute development user-data override', () => {
  assert.equal(
    developmentUserDataDirectory('/private/tmp/remember-electron-qa/user-data', false),
    '/private/tmp/remember-electron-qa/user-data'
  )
})

test('ignores the override in packaged builds', () => {
  assert.equal(developmentUserDataDirectory('/private/tmp/remember-electron-qa/user-data', true), null)
})

test('rejects a relative development user-data override', () => {
  assert.throws(() => developmentUserDataDirectory('.remember-electron-qa/user-data', false), {
    message: 'REMEMBER_USER_DATA_DIR must be an absolute path',
  })
})
