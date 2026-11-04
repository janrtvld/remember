import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createNetworkRequestController } from '../networkRequestController'

describe('network request controller', () => {
  it('aborts every in-flight request with the offline error', async () => {
    const controller = createNetworkRequestController()
    const requests = [1, 2].map(() =>
      controller.run(
        (signal) =>
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
      )
    )

    controller.cancel(new Error('offline-mode-enabled'))

    const results = await Promise.allSettled(requests)
    assert.deepEqual(
      results.map((result) => (result.status === 'rejected' ? result.reason.message : null)),
      ['offline-mode-enabled', 'offline-mode-enabled']
    )
  })
})
