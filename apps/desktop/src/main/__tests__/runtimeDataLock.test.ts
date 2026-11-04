import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { acquireRememberDataLock } from '../runtimeDataLock'

const directories: string[] = []

function userDataDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'remember-runtime-lock-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Remember data lock', () => {
  it('recovers a legacy lock whose PID was reused after a reboot', () => {
    const directory = userDataDirectory()
    mkdirSync(join(directory, '.runtime-lock'))
    writeFileSync(
      join(directory, '.runtime-lock/owner.json'),
      JSON.stringify({
        token: 'before-reboot',
        pid: 874,
        createdAt: 1_000,
      })
    )
    const recovered = acquireRememberDataLock(directory, {
      pid: 202,
      isProcessAlive: () => true,
      getProcessStartedAt: () => 5_000,
    })
    assert.ok(recovered)
    recovered.release()
  })

  it('distinguishes reused PIDs even if the wall clock moves backwards', () => {
    const directory = userDataDirectory()
    const first = acquireRememberDataLock(directory, {
      pid: 101,
      now: 10_000,
      getProcessStartedAt: () => 5_000,
    })
    const recovered = acquireRememberDataLock(directory, {
      pid: 202,
      now: 3_000,
      isProcessAlive: () => true,
      getProcessStartedAt: () => 2_000,
    })
    assert.ok(first)
    assert.ok(recovered)
    first.release()
    assert.equal(
      acquireRememberDataLock(directory, {
        pid: 303,
        isProcessAlive: () => true,
        getProcessStartedAt: () => 2_000,
      }),
      null
    )
    recovered.release()
  })

  it('preserves a live legacy lock when process inspection is unavailable or predates the lock', () => {
    const directory = userDataDirectory()
    mkdirSync(join(directory, '.runtime-lock'))
    writeFileSync(
      join(directory, '.runtime-lock/owner.json'),
      JSON.stringify({
        token: 'live-owner',
        pid: 101,
        createdAt: 5_000,
      })
    )
    for (const startedAt of [undefined, 4_000]) {
      assert.equal(
        acquireRememberDataLock(directory, {
          pid: 202,
          isProcessAlive: () => true,
          getProcessStartedAt: () => startedAt,
        }),
        null
      )
    }
  })

  it('recognizes its real process identity and releases only its own lock', () => {
    const directory = userDataDirectory()
    const first = acquireRememberDataLock(directory)
    assert.ok(first)
    assert.equal(acquireRememberDataLock(directory), null)
    first.release()
    const next = acquireRememberDataLock(directory)
    assert.ok(next)
    next.release()
  })

  it('allows only one process to own shared user data', () => {
    const directory = userDataDirectory()
    const first = acquireRememberDataLock(directory, { pid: 101, isProcessAlive: (pid) => pid === 101 })
    const second = acquireRememberDataLock(directory, { pid: 202, isProcessAlive: (pid) => pid === 101 })

    assert.ok(first)
    assert.equal(second, null)
    first.release()
    assert.ok(acquireRememberDataLock(directory, { pid: 202, isProcessAlive: () => false }))
  })

  it('recovers a lock left by a process that is no longer alive', () => {
    const directory = userDataDirectory()
    const stale = acquireRememberDataLock(directory, { pid: 101, isProcessAlive: () => false })
    const recovered = acquireRememberDataLock(directory, { pid: 202, isProcessAlive: () => false })

    assert.ok(stale)
    assert.ok(recovered)
    stale.release()
    assert.equal(acquireRememberDataLock(directory, { pid: 303, isProcessAlive: (pid) => pid === 202 }), null)
  })
})
