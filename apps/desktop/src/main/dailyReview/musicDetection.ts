import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import {
  isExcludedMusicPlayback,
  type MediaPlaybackSnapshot,
  type MusicClassification,
  shouldTranscribeMusicClassification,
} from './musicDetectionPolicy'

const CLASSIFICATION_TIMEOUT_MS = 95_000
const MAX_OUTPUT_BYTES = 64 * 1024

function helperPath() {
  const packaged = path.join(process.resourcesPath, 'music-classifier')
  if (app.isPackaged && existsSync(packaged)) return packaged
  return path.join(app.getAppPath(), 'native', 'music-classifier')
}

function isClassification(value: unknown): value is MusicClassification {
  if (!value || typeof value !== 'object') return false
  const classification = value as Partial<MusicClassification>
  return (
    typeof classification.windowCount === 'number' &&
    typeof classification.speechWindowShare === 'number' &&
    typeof classification.musicDominantWindowShare === 'number' &&
    typeof classification.averageSpeechConfidence === 'number' &&
    typeof classification.averageMusicConfidence === 'number' &&
    typeof classification.averageSingingConfidence === 'number'
  )
}

export function shouldTranscribeSystemAudio(audioPath: string, playback: MediaPlaybackSnapshot) {
  if (isExcludedMusicPlayback(playback)) {
    console.info('[daily-review] skipped excluded music player audio chunk', { playback })
    return Promise.resolve(false)
  }

  const executable = helperPath()
  if (process.platform !== 'darwin' || !existsSync(executable)) return Promise.resolve(true)

  return new Promise<boolean>((resolve) => {
    const child = spawn(executable, [audioPath], { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0
    let settled = false

    const finish = (shouldTranscribe: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(shouldTranscribe)
    }

    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      console.warn('[daily-review] music classification timed out; transcribing chunk')
      finish(true)
    }, CLASSIFICATION_TIMEOUT_MS)

    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill('SIGTERM')
        finish(true)
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', (error) => {
      console.warn('[daily-review] music classifier unavailable; transcribing chunk', error)
      finish(true)
    })
    child.on('exit', (code) => {
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString('utf8').trim()
        console.warn('[daily-review] music classification failed; transcribing chunk', detail)
        finish(true)
        return
      }

      try {
        const classification = JSON.parse(Buffer.concat(stdout).toString('utf8')) as unknown
        if (!isClassification(classification)) {
          finish(true)
          return
        }
        const shouldTranscribe = shouldTranscribeMusicClassification(classification, playback)
        if (!shouldTranscribe) {
          console.info('[daily-review] skipped music-only system audio chunk', {
            classification,
            playback,
          })
        }
        finish(shouldTranscribe)
      } catch {
        finish(true)
      }
    })
  })
}
