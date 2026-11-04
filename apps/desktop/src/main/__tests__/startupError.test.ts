import assert from 'node:assert/strict'
import test from 'node:test'
import { startupErrorPath, startupErrorReason } from '../startupError'

test('classifies unsupported evidence database versions without exposing the version in the renderer URL', () => {
  const reason = startupErrorReason(new Error('unsupported-evidence-schema:9'))

  assert.equal(reason, 'data-version-unsupported')
  assert.equal(startupErrorPath(reason), '/startup-error/data-version/')
})

test('uses the generic startup state for unrelated failures', () => {
  const reason = startupErrorReason(new Error('local-web-server-address-missing'))

  assert.equal(reason, 'startup-failed')
  assert.equal(startupErrorPath(reason), '/startup-error/')
})

test('routes a zero-byte archive to non-destructive archive recovery', () => {
  const reason = startupErrorReason(new Error('evidence-archive-zero-byte'))

  assert.equal(reason, 'archive-damaged')
  assert.equal(startupErrorPath(reason), '/startup-error/archive/')
})
