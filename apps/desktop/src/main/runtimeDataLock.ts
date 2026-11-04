import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const INCOMPLETE_LOCK_GRACE_MS = 10_000

type LockOwner = {
  token: string
  pid: number
  createdAt: number
  processStartedAt?: number
}

type LockOptions = {
  pid?: number
  now?: number
  isProcessAlive?: (pid: number) => boolean
  getProcessStartedAt?: (pid: number) => number | undefined
}

export type RememberDataLock = {
  release: () => void
}

function processIsAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function processStartedAt(pid: number) {
  if (process.platform !== 'darwin') return undefined
  try {
    const started = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      timeout: 1_000,
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const timestamp = Date.parse(`${started} GMT`)
    return Number.isFinite(timestamp) ? timestamp : undefined
  } catch {
    return undefined
  }
}

function readOwner(path: string): LockOwner | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockOwner>
    return typeof value.token === 'string' && Number.isInteger(value.pid) && typeof value.createdAt === 'number'
      ? (value as LockOwner)
      : null
  } catch {
    return null
  }
}

/**
 * Guards the shared Remember user-data directory across installed and
 * development app identities. mkdir is the atomic lock operation; the owner
 * record lets a later launch safely recover after a crash.
 */
export function acquireRememberDataLock(userDataDirectory: string, options: LockOptions = {}): RememberDataLock | null {
  const lockDirectory = join(userDataDirectory, '.runtime-lock')
  const ownerPath = join(lockDirectory, 'owner.json')
  const getProcessStartedAt = options.getProcessStartedAt ?? processStartedAt
  const pid = options.pid ?? process.pid
  const owner: LockOwner = {
    token: randomUUID(),
    pid,
    createdAt: options.now ?? Date.now(),
    processStartedAt: getProcessStartedAt(pid),
  }
  const isAlive = options.isProcessAlive ?? processIsAlive

  mkdirSync(userDataDirectory, { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lockDirectory, { mode: 0o700 })
      try {
        writeFileSync(ownerPath, JSON.stringify(owner), { encoding: 'utf8', mode: 0o600 })
      } catch (error) {
        rmSync(lockDirectory, { recursive: true, force: true })
        throw error
      }
      return {
        release: () => {
          if (readOwner(ownerPath)?.token === owner.token) {
            rmSync(lockDirectory, { recursive: true, force: true })
          }
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const currentOwner = readOwner(ownerPath)
      if (currentOwner && isAlive(currentOwner.pid)) {
        const startedAt = getProcessStartedAt(currentOwner.pid)
        // Older locks have no process identity. A process born after the lock cannot own it.
        const reusedPid =
          startedAt !== undefined &&
          (typeof currentOwner.processStartedAt === 'number'
            ? startedAt !== currentOwner.processStartedAt
            : startedAt > currentOwner.createdAt)
        if (!reusedPid) return null
      }
      if (!currentOwner) {
        const ageMs = owner.createdAt - statSync(lockDirectory).mtimeMs
        if (ageMs < INCOMPLETE_LOCK_GRACE_MS) return null
      }
      rmSync(lockDirectory, { recursive: true, force: true })
    }
  }
  return null
}
