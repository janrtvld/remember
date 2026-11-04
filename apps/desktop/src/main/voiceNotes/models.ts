import { execFile } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { net } from 'electron'
import { requireNetworkAccess } from '../networkAccess'
import { modelDir, voiceNotesDir } from './paths'
import { SPEECH_MODEL_FILES } from './speechModel'

// Parakeet V3 INT8 is shared by dictation and conversation recognition.

const MODEL_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2'
const VAD_MODEL_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx'
// Approximate compressed size, used only for the progress bar before headers arrive.
const MODEL_SIZE_BYTES = 487_000_000
const VAD_MODEL_SIZE_BYTES = 643_854
const VAD_MODEL_FILENAME = 'silero-vad.onnx'
const LEGACY_MODEL_DIRECTORY = 'whisper-large-v3-turbo-int8'

function isSpeechModelDownloaded() {
  return SPEECH_MODEL_FILES.every((file) => existsSync(join(modelDir(), file)))
}

function isVadModelDownloaded() {
  return existsSync(join(modelDir(), VAD_MODEL_FILENAME))
}

export function isModelDownloaded(): boolean {
  return active === null && isSpeechModelDownloaded() && isVadModelDownloaded()
}

// --- in-flight download/install tracking (single model → single slot) ---

export type ModelPreparationPhase = 'downloading' | 'installing'
type ActiveModelPreparation = {
  phase: ModelPreparationPhase
  progress: number | null
  abort: () => void
  cancelled: boolean
}

let active: ActiveModelPreparation | null = null
let preparation: Promise<void> | null = null
const listeners = new Set<() => void>()

export function subscribeModelPreparation(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Current 0..1 network download progress, or null outside the download phase. */
export function downloadProgress(): number | null {
  return active ? active.progress : null
}

export function modelPreparationPhase(): ModelPreparationPhase | null {
  return active?.phase ?? null
}

export function cancelDownload(): void {
  if (active) active.cancelled = true
  active?.abort()
}

function downloadFile(
  url: string,
  destination: string,
  expectedSize: number,
  completedSize: number,
  totalSize: number,
  entry: ActiveModelPreparation,
  onProgress: (progress: number | null) => void
) {
  return new Promise<void>((resolve, reject) => {
    if (entry.cancelled) {
      reject(new Error('cancelled'))
      return
    }
    requireNetworkAccess()
    const request = net.request(url)
    const file = createWriteStream(destination)
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }
    const fail = (error: Error) => {
      file.destroy()
      finish(() => reject(error))
    }
    entry.abort = () => {
      fail(new Error('cancelled'))
      try {
        request.abort()
      } catch {
        // already finished
      }
    }
    file.on('error', fail)
    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        fail(new Error(`Download failed (HTTP ${response.statusCode})`))
        return
      }
      const header = response.headers['content-length']
      const responseSize = Number(Array.isArray(header) ? header[0] : header) || expectedSize
      let received = 0
      const stream = response as unknown as NodeJS.ReadableStream
      stream.on('data', (chunk: Buffer) => {
        received += chunk.length
        const currentSize = Math.min(expectedSize, (received / responseSize) * expectedSize)
        entry.progress = Math.min(1, (completedSize + currentSize) / totalSize)
        onProgress(entry.progress)
      })
      stream.on('error', fail)
      stream.pipe(file)
      file.on('finish', () => finish(resolve))
    })
    request.on('error', (error) => fail(error))
    request.end()
  })
}

export function downloadModel(onProgress: (progress: number | null) => void): Promise<void> {
  if (isModelDownloaded()) return Promise.resolve()
  const unsubscribe = subscribeModelPreparation(() => onProgress(downloadProgress()))
  preparation ??= Promise.resolve()
    .then(installModel)
    .finally(() => {
      preparation = null
    })
  return preparation.finally(unsubscribe)
}

async function installModel(): Promise<void> {
  requireNetworkAccess()
  const needsSpeechModel = !isSpeechModelDownloaded()
  const needsVadModel = needsSpeechModel || !isVadModelDownloaded()
  const modelTmp = join(tmpdir(), `remember-parakeet-${process.pid}.tar.bz2`)
  const vadTmp = join(tmpdir(), `remember-vad-${process.pid}.onnx`)
  const entry: ActiveModelPreparation = { phase: 'downloading', progress: 0, abort: () => {}, cancelled: false }
  active = entry
  const progress = (_value: number | null) => {
    listeners.forEach((listener) => {
      listener()
    })
  }
  progress(0)

  try {
    await mkdir(voiceNotesDir(), { recursive: true })
    const totalSize = (needsSpeechModel ? MODEL_SIZE_BYTES : 0) + (needsVadModel ? VAD_MODEL_SIZE_BYTES : 0)
    let completedSize = 0
    if (needsSpeechModel) {
      await downloadFile(MODEL_URL, modelTmp, MODEL_SIZE_BYTES, completedSize, totalSize, entry, progress)
      completedSize += MODEL_SIZE_BYTES
    }
    if (needsVadModel) {
      await downloadFile(VAD_MODEL_URL, vadTmp, VAD_MODEL_SIZE_BYTES, completedSize, totalSize, entry, progress)
    }

    entry.phase = 'installing'
    entry.progress = null
    progress(null)
    if (entry.cancelled) throw new Error('cancelled')
    if (needsSpeechModel) await rm(modelDir(), { recursive: true, force: true }).catch(() => {})
    await mkdir(modelDir(), { recursive: true })
    if (needsSpeechModel) {
      await new Promise<void>((resolve, reject) => {
        execFile('tar', ['xjf', modelTmp, '-C', modelDir(), '--strip-components=1'], (error) =>
          error ? reject(error) : resolve()
        )
      })
    }
    if (needsVadModel) await rename(vadTmp, join(modelDir(), VAD_MODEL_FILENAME))
    if (entry.cancelled) throw new Error('cancelled')
    if (!isSpeechModelDownloaded() || !isVadModelDownloaded())
      throw new Error('extraction did not produce the model files')
    await rm(join(voiceNotesDir(), LEGACY_MODEL_DIRECTORY), { recursive: true, force: true }).catch(() => {})
  } catch (error) {
    if (needsSpeechModel) await rm(modelDir(), { recursive: true, force: true }).catch(() => {})
    else if (needsVadModel) await rm(join(modelDir(), VAD_MODEL_FILENAME), { force: true }).catch(() => {})
    throw error
  } finally {
    await Promise.all([rm(modelTmp, { force: true }).catch(() => {}), rm(vadTmp, { force: true }).catch(() => {})])
    active = null
    progress(null)
  }
}

export async function deleteModel(): Promise<void> {
  cancelDownload()
  await preparation?.catch(() => undefined)
  await rm(modelDir(), { recursive: true, force: true }).catch(() => {})
}
