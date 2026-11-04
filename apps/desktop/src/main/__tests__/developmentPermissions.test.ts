import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resetDevelopmentPermissions } from '../developmentPermissions'

describe('resetDevelopmentPermissions', () => {
  it('resets each permission from the process that consumes it', async () => {
    const calls: Array<[service: string, bundleId: string]> = []

    await resetDevelopmentPermissions(async (service, bundleId) => {
      calls.push([service, bundleId])
    })

    assert.deepEqual(calls, [
      ['Accessibility', 'com.github.Electron'],
      ['Accessibility', 'computer.remember.app.context-capture'],
      ['Microphone', 'com.github.Electron'],
      ['Microphone', 'computer.remember.app.microphone-audio-capture'],
      ['AudioCapture', 'computer.remember.app.system-audio-capture'],
      ['ScreenCapture', 'computer.remember.app.system-audio-capture'],
    ])
  })

  it('attempts every reset when an earlier target fails', async () => {
    const calls: string[] = []

    await assert.rejects(
      resetDevelopmentPermissions(async (service, bundleId) => {
        calls.push(`${service}:${bundleId}`)
        if (service === 'Accessibility') throw new Error('reset failed')
      }),
      AggregateError
    )

    assert.equal(calls.length, 6)
  })
})
