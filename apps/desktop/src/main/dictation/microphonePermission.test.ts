import assert from 'node:assert/strict'
import test from 'node:test'
import { ensureMicrophoneAccess } from './microphonePermission'

test('existing microphone permission never invokes the slow consent request', async () => {
  assert.equal(
    await ensureMicrophoneAccess({
      getMediaAccessStatus: () => 'granted',
      askForMediaAccess: async () => assert.fail('Already granted permission must not be requested again'),
    }),
    true
  )
})

test('only undetermined microphone permission prompts and propagates the answer', async () => {
  for (const answer of [true, false]) {
    let requests = 0
    assert.equal(
      await ensureMicrophoneAccess({
        getMediaAccessStatus: () => 'not-determined',
        askForMediaAccess: async () => {
          requests++
          return answer
        },
      }),
      answer
    )
    assert.equal(requests, 1)
  }
})

test('permission is rechecked so revocation or restriction cannot reuse a previous grant', async () => {
  let status = 'granted'
  const permissions = {
    getMediaAccessStatus: () => status,
    askForMediaAccess: async () => assert.fail('Denied or restricted access must not trigger another prompt'),
  }
  assert.equal(await ensureMicrophoneAccess(permissions), true)
  for (status of ['denied', 'restricted', 'unknown']) {
    assert.equal(await ensureMicrophoneAccess(permissions), false)
  }
})
