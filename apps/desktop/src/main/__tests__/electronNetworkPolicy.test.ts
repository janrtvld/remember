import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { GUARDED_NETWORK_PARTITIONS, installElectronNetworkPolicy } from '../electronNetworkPolicy'

function sessionFixture() {
  let listener: ((details: { url: string }, callback: (response: { cancel: boolean }) => void) => void) | null = null
  let closed = false
  return {
    session: {
      webRequest: {
        onBeforeRequest(next: NonNullable<typeof listener>) {
          listener = next
        },
      },
      async closeAllConnections() {
        closed = true
      },
    },
    request(url: string) {
      let cancelled = false
      listener?.({ url }, (response) => {
        cancelled = response.cancel
      })
      return cancelled
    },
    wasClosed: () => closed,
  }
}

describe('Electron network policy', () => {
  it('blocks every app session without interrupting local renderer connections', async () => {
    const defaultFixture = sessionFixture()
    const partitions = new Map<string, ReturnType<typeof sessionFixture>>(
      GUARDED_NETWORK_PARTITIONS.map((partition) => [partition, sessionFixture()])
    )
    const policy = installElectronNetworkPolicy({
      defaultSession: defaultFixture.session,
      fromPartition: (partition) => partitions.get(partition)?.session as typeof defaultFixture.session,
      shouldBlock: (url) => !url.startsWith('http://127.0.0.1:'),
    })

    assert.equal(defaultFixture.request('https://api.remember.test'), true)
    assert.equal(partitions.get('sentry-electron')?.request('https://sentry.test'), true)
    assert.equal(partitions.get('electron-updater')?.request('https://updates.test'), true)
    assert.equal(defaultFixture.request('http://127.0.0.1:3000'), false)

    await policy.closeAllConnections()
    assert.equal(defaultFixture.wasClosed(), false)
    assert.equal(partitions.get('sentry-electron')?.wasClosed(), true)
    assert.equal(partitions.get('electron-updater')?.wasClosed(), true)
  })
})
