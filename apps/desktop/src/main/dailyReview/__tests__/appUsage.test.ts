import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type Day, summarizeAppUsage } from '@remember/shared'

function workday(appActivity: Day['appActivity']): Day {
  return {
    id: 'day',
    startedAt: 0,
    endedAt: 60_000,
    activeDurationMs: 60_000,
    moments: [],
    appActivity,
    contextMoments: [],
    memory: null,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  }
}

describe('summarizeAppUsage', () => {
  it('caps stale overlapping segments at the next focus change', () => {
    const usage = summarizeAppUsage(
      [
        workday([
          {
            id: 'one',
            appName: 'Cursor',
            bundleId: 'cursor',
            startedAt: 0,
            endedAt: 60_000,
          },
          {
            id: 'two',
            appName: 'ChatGPT',
            bundleId: 'chatgpt',
            startedAt: 20_000,
            endedAt: 40_000,
          },
          {
            id: 'three',
            appName: 'Idle',
            bundleId: '',
            startedAt: 40_000,
            endedAt: 60_000,
          },
        ]),
      ],
      1
    )

    assert.deepEqual(usage, [
      { name: 'Cursor', bundleId: 'cursor', durationMs: 20_000 },
      { name: 'ChatGPT', bundleId: 'chatgpt', durationMs: 20_000 },
    ])
  })

  it('labels the Remember development shell as Remember', () => {
    const [usage] = summarizeAppUsage(
      [
        workday([
          {
            id: 'one',
            appName: 'Electron',
            bundleId: 'com.github.Electron',
            startedAt: 0,
            endedAt: 60_000,
          },
        ]),
      ],
      1
    )

    assert.equal(usage?.name, 'Remember')
    assert.equal(usage?.bundleId, 'computer.remember.app')
  })

  it('excludes macOS shell and authentication activity from screen time', () => {
    const usage = summarizeAppUsage(
      [
        workday([
          {
            id: 'login-window',
            appName: 'loginWindow',
            bundleId: 'com.apple.loginwindow',
            startedAt: 0,
            endedAt: 20_000,
          },
          {
            id: 'security-agent',
            appName: 'SecurityAgent',
            bundleId: 'com.apple.SecurityAgent',
            startedAt: 20_000,
            endedAt: 40_000,
          },
          {
            id: 'notification-center',
            appName: 'UserNotificationCenter',
            bundleId: 'com.apple.UserNotificationCenter',
            startedAt: 40_000,
            endedAt: 50_000,
          },
          {
            id: 'finder',
            appName: 'Finder',
            bundleId: 'com.apple.finder',
            startedAt: 50_000,
            endedAt: 60_000,
          },
        ]),
      ],
      1
    )

    assert.deepEqual(usage, [{ name: 'Finder', bundleId: 'com.apple.finder', durationMs: 10_000 }])
  })

  it('keeps a third-party app that happens to use a system process name', () => {
    const usage = summarizeAppUsage(
      [
        workday([
          {
            id: 'third-party',
            appName: 'SecurityAgent',
            bundleId: 'com.example.security-agent',
            startedAt: 0,
            endedAt: 60_000,
          },
        ]),
      ],
      1
    )

    assert.deepEqual(usage, [{ name: 'SecurityAgent', bundleId: 'com.example.security-agent', durationMs: 60_000 }])
  })
})
