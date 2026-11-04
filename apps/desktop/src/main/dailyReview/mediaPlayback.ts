import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { MediaPlaybackSnapshot } from './musicDetectionPolicy'

const TIMEOUT_MS = 3_000
const INACTIVE_PLAYBACK: MediaPlaybackSnapshot = {
  isPlaying: false,
  bundleIdentifier: '',
  applicationName: '',
}

function helperPath() {
  const packaged = path.join(process.resourcesPath, 'media-playback')
  if (app.isPackaged && existsSync(packaged)) return packaged
  return path.join(app.getAppPath(), 'native', 'media-playback')
}

function isPlaybackSnapshot(value: unknown): value is MediaPlaybackSnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as Partial<MediaPlaybackSnapshot>
  return (
    typeof snapshot.isPlaying === 'boolean' &&
    typeof snapshot.bundleIdentifier === 'string' &&
    typeof snapshot.applicationName === 'string'
  )
}

export function readMediaPlayback() {
  const executable = helperPath()
  if (process.platform !== 'darwin' || !existsSync(executable)) return Promise.resolve(INACTIVE_PLAYBACK)

  return new Promise<MediaPlaybackSnapshot>((resolve) => {
    const child = spawn(executable, [], { stdio: ['ignore', 'pipe', 'ignore'] })
    const output: Buffer[] = []
    let settled = false

    const finish = (snapshot = INACTIVE_PLAYBACK) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(snapshot)
    }
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      finish()
    }, TIMEOUT_MS)

    child.stdout.on('data', (chunk: Buffer) => output.push(chunk))
    child.on('error', () => finish())
    child.on('exit', (code) => {
      if (code !== 0) {
        finish()
        return
      }
      try {
        const snapshot = JSON.parse(Buffer.concat(output).toString('utf8')) as unknown
        finish(isPlaybackSnapshot(snapshot) ? snapshot : INACTIVE_PLAYBACK)
      } catch {
        finish()
      }
    })
  })
}
