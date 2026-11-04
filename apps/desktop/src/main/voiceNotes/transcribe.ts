import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app, type UtilityProcess, utilityProcess } from 'electron'
import { modelDir, transcribeWorkerPath } from './paths'
import type { TranscriptionLanguageRejectionReason } from './transcriptionLanguagePolicy'
import { createTranscriptionLifecycle } from './transcriptionLifecycle'
import { queueTranscription } from './transcriptionQueue'

// In the packaged app the native sherpa runtime ships as extraResources (see
// electron-builder.yml); tell the worker where to require it from. In dev it
// resolves 'sherpa-onnx-node' from node_modules as usual.
function sherpaModulePath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'sherpa', 'node_modules', 'sherpa-onnx-node') : 'sherpa-onnx-node'
}

export interface TranscriptionResult {
  text: string
  language: string | null
  speechDurationMs: number
  segments: TranscriptionSegmentResult[]
  resolvedChunkIds: string[]
  promotedLanguages: Array<'nl' | 'en'>
  hasPendingSpeech: boolean
}

export interface TranscriptionSegmentResult {
  chunkId: string
  chunkIds: string[]
  startedAt: number
  endedAt: number
  vadStartedAt: number
  vadEndedAt: number
  asrWindowIndex: number
  asrWindowCount: number
  transcriptionOutcome: 'transcribed' | 'asr-empty'
  text: string
  detectedLanguage: string | null
  acceptedLanguage: 'nl' | 'en' | null
  rejectionReason: TranscriptionLanguageRejectionReason | 'likely-hallucination' | null
}

export interface TranscriptionContext {
  streamId: string
  chunkId: string
  captureEpochId: string
  captureSequence: number
  startedAt: number
  defaultLanguage: 'nl' | 'en'
}

interface Pending {
  child: UtilityProcess
  resolve: (result: TranscriptionResult) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type WorkerRequest =
  | ({ type: 'decode'; samples: Float32Array } & TranscriptionContext)
  | { type: 'flush'; streamId: string }
  | { type: 'dictation'; samples: Float32Array }

// A persistent utility process holds the warm recognizer so decoding never
// blocks the main process. The idle timer releases its larger model allocation.
let worker: UtilityProcess | null = null
const pending = new Map<string, Pending>()
const lifecycle = createTranscriptionLifecycle<UtilityProcess>()
let idleTimer: ReturnType<typeof setTimeout> | null = null
const IDLE_UNLOAD_MS = 15 * 60_000

function scheduleIdleUnload(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    // Never tear down under an in-flight decode.
    if (pending.size === 0) disposeTranscriber()
  }, IDLE_UNLOAD_MS)
}

function settle(id: string, fn: (p: Pending) => void): void {
  const p = pending.get(id)
  if (!p) return
  clearTimeout(p.timer)
  pending.delete(id)
  fn(p)
}

function retireWorker(child: UtilityProcess) {
  if (worker === child) worker = null
  lifecycle.interrupt(child)
  for (const [id, request] of pending) {
    if (request.child === child) settle(id, (p) => p.reject(new Error('transcriber exited')))
  }
  try {
    child.kill()
  } catch {
    // The utility process already exited.
  }
}

export function subscribeTranscriptionInterruptions(listener: (chunkIds: string[]) => void) {
  return lifecycle.subscribe(listener)
}

function ensureWorker(): UtilityProcess {
  if (worker) return worker
  const child = utilityProcess.fork(transcribeWorkerPath(), [], {
    env: { ...process.env, REMEMBER_SHERPA_MODULE: sherpaModulePath() },
  })
  child.on(
    'message',
    (message: {
      type?: string
      id?: string
      text?: string
      language?: string | null
      speechDurationMs?: number
      segments?: TranscriptionSegmentResult[]
      resolvedChunkIds?: string[]
      promotedLanguages?: Array<'nl' | 'en'>
      hasPendingSpeech?: boolean
      message?: string
    }) => {
      if (message?.type === 'result' && message.id && pending.get(message.id)?.child === child) {
        lifecycle.resolve(child, message.resolvedChunkIds ?? [])
        settle(message.id, (p) =>
          p.resolve({
            text: message.text ?? '',
            language: message.language ?? null,
            speechDurationMs: message.speechDurationMs ?? 0,
            segments: message.segments ?? [],
            resolvedChunkIds: message.resolvedChunkIds ?? [],
            promotedLanguages: message.promotedLanguages ?? [],
            hasPendingSpeech: message.hasPendingSpeech ?? false,
          })
        )
      } else if (message?.type === 'error') {
        if (message.id && pending.get(message.id)?.child === child) {
          settle(message.id, (p) => p.reject(new Error(message.message)))
        }
        retireWorker(child)
      }
    }
  )
  child.on('exit', () => {
    if (worker === child) worker = null
    lifecycle.interrupt(child)
    for (const [id, request] of pending) {
      if (request.child === child) settle(id, (p) => p.reject(new Error('transcriber exited')))
    }
  })
  worker = child
  return child
}

// Read 16-bit mono PCM samples as Float32 [-1, 1]. Scans for the 'data' chunk
// rather than assuming a fixed 44-byte header, so any WAV layout works.
function wavToFloat32(wav: Buffer): Float32Array {
  let offset = 12
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    if (id === 'data') {
      const count = Math.min(Math.floor(size / 2), Math.floor((wav.length - offset - 8) / 2))
      const out = new Float32Array(Math.max(0, count))
      let pos = offset + 8
      for (let i = 0; i < out.length; i++) {
        out[i] = wav.readInt16LE(pos) / 32768
        pos += 2
      }
      return out
    }
    offset += 8 + size + (size & 1)
  }
  return new Float32Array(0)
}

function requestTranscription(request: WorkerRequest) {
  const child = ensureWorker()
  const id = randomUUID()
  scheduleIdleUnload()
  return new Promise<TranscriptionResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      settle(id, (pendingRequest) => pendingRequest.reject(new Error('transcription timed out')))
      retireWorker(child)
    }, 120_000)
    pending.set(id, { child, resolve, reject, timer })
    if (request.type === 'decode') lifecycle.track(child, request.chunkId)
    try {
      child.postMessage({ ...request, id, modelDir: modelDir() })
    } catch (error) {
      settle(id, (pendingRequest) => pendingRequest.reject(error instanceof Error ? error : new Error(String(error))))
      retireWorker(child)
    }
  })
}

/** Transcribe a recorder WAV via the shared Parakeet worker. */
export async function transcribeWav(wav: Buffer, context: TranscriptionContext): Promise<TranscriptionResult> {
  return queueTranscription(async () => {
    const samples = wavToFloat32(wav)
    // Too few frames (an instant double-tap or pure silence) crash the native
    // decoder with a 0-frame input shape — treat < 0.1 s as an empty transcript.
    if (samples.length < 1600) {
      return {
        text: '',
        language: null,
        speechDurationMs: 0,
        segments: [],
        resolvedChunkIds: [context.chunkId],
        promotedLanguages: [],
        hasPendingSpeech: false,
      }
    }
    return requestTranscription({ type: 'decode', samples, ...context })
  })
}

export function transcribeDictation(wav: Buffer) {
  return queueTranscription(() => requestTranscription({ type: 'dictation', samples: wavToFloat32(wav) }), 'dictation')
}

export function flushTranscriptionStream(streamId: string) {
  return queueTranscription(() => requestTranscription({ type: 'flush', streamId }))
}

/** Load the model into the worker ahead of time so the first note is instant. */
export function warmTranscriber(): void {
  let child: UtilityProcess | null = null
  try {
    child = ensureWorker()
    child.postMessage({ type: 'warm', modelDir: modelDir() })
    scheduleIdleUnload()
  } catch {
    if (child) retireWorker(child)
  }
}

export function disposeTranscriber(): void {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  const children = new Set([...pending.values()].map((request) => request.child))
  if (worker) children.add(worker)
  worker = null
  for (const id of [...pending.keys()]) settle(id, (p) => p.reject(new Error('disposed')))
  for (const child of children) retireWorker(child)
}
