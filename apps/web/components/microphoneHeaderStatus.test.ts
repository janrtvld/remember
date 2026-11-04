import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { microphoneHeaderStatus } from './microphoneHeaderStatus'

describe('microphone header status', () => {
  const base = {
    microphoneLastChunkAt: null,
    microphonePermission: 'granted' as const,
  }

  it('shows connecting until the native microphone reports ready', () => {
    assert.equal(
      microphoneHeaderStatus({ ...base, status: 'recording', microphoneName: null, pausedSources: [] }),
      'connecting'
    )
  })

  it('shows active only while recent chunks prove the microphone is producing audio', () => {
    assert.equal(
      microphoneHeaderStatus(
        {
          ...base,
          status: 'recording',
          microphoneName: 'MacBook Microphone',
          microphoneLastChunkAt: 900_000,
          pausedSources: [],
        },
        1_000_000
      ),
      'active'
    )
    assert.equal(
      microphoneHeaderStatus(
        {
          ...base,
          status: 'recording',
          microphoneName: 'MacBook Microphone',
          microphoneLastChunkAt: 800_000,
          pausedSources: [],
        },
        1_000_000
      ),
      'stale'
    )
  })

  it('shows permission denial instead of a stale active device name', () => {
    assert.equal(
      microphoneHeaderStatus({
        ...base,
        status: 'recording',
        microphoneName: 'MacBook Microphone',
        microphonePermission: 'denied',
        pausedSources: [],
      }),
      'permission-denied'
    )
  })

  it('keeps paused and inactive states explicit', () => {
    assert.equal(
      microphoneHeaderStatus({
        status: 'recording',
        microphoneName: 'MacBook Microphone',
        ...base,
        pausedSources: ['audio'],
      }),
      'paused'
    )
    assert.equal(
      microphoneHeaderStatus({
        ...base,
        status: 'paused',
        microphoneName: 'MacBook Microphone',
        pausedSources: ['capture'],
      }),
      'paused'
    )
    assert.equal(
      microphoneHeaderStatus({ ...base, status: 'idle', microphoneName: null, pausedSources: [] }),
      'inactive'
    )
    assert.equal(
      microphoneHeaderStatus({ ...base, status: 'error', microphoneName: null, pausedSources: [] }),
      'inactive'
    )
  })
})
