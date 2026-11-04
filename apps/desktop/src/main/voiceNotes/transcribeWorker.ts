import { speechRecognizerConfig } from './speechModel'
import type { TranscriptionLanguage } from './transcriptionLanguagePolicy'
import { type TranscriptionSampleChunk, withSpeechPreroll } from './transcriptionPreroll'
import { isLikelyTranscriptionHallucination } from './transcriptionQuality'
import { copyTranscriptionSamples } from './transcriptionSamples'
import {
  chunkAtSample,
  chunkIdsForSampleRange,
  isContinuousCapture,
  resolveCompletedChunks,
  resolveIdleChunks,
  timestampAtSample,
} from './transcriptionStream'
import { splitTranscriptionSamples } from './transcriptionWindows'

const { OfflineRecognizer, Vad } = require(
  process.env.REMEMBER_SHERPA_MODULE || 'sherpa-onnx-node'
) as typeof import('sherpa-onnx-node')

interface WorkerMessage {
  type: 'warm' | 'decode' | 'flush' | 'dictation'
  id?: string
  modelDir: string
  samples?: Float32Array
  streamId?: string
  chunkId?: string
  captureEpochId?: string
  captureSequence?: number
  startedAt?: number
  defaultLanguage?: TranscriptionLanguage
}

interface StreamState {
  detector: VoiceActivityDetector
  captureEpochId: string
  expectedSequence: number
  nextSample: number
  completedThroughSample: number
  chunks: TranscriptionSampleChunk[]
}

interface DecodedSegment {
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
  acceptedLanguage: TranscriptionLanguage | null
  rejectionReason:
    | 'unsupported-language'
    | 'cross-language-short'
    | 'cross-language-unconfirmed'
    | 'likely-hallucination'
    | null
}

const parentPort = (
  process as unknown as {
    parentPort: {
      on(event: 'message', cb: (e: { data: WorkerMessage }) => void): void
      postMessage(message: unknown): void
    }
  }
).parentPort

type Recognizer = InstanceType<typeof OfflineRecognizer>
type VoiceActivityDetector = InstanceType<typeof Vad>

const SAMPLE_RATE = 16_000
const VAD_WINDOW_SIZE = 512
const VAD_BACKSTOP_SECONDS = 15
const VAD_BUFFER_SECONDS = 120

let recognizer: Recognizer | null = null
let loadedRecognizerDir: string | null = null
let loadedVadDir: string | null = null
const streamStates = new Map<string, StreamState>()

function ensureRecognizer(dir: string) {
  if (recognizer && loadedRecognizerDir === dir) return recognizer
  recognizer = new OfflineRecognizer(speechRecognizerConfig(dir))
  loadedRecognizerDir = dir
  return recognizer
}

function createVoiceActivityDetector(dir: string, isDictation = false) {
  if (loadedVadDir && loadedVadDir !== dir) streamStates.clear()
  loadedVadDir = dir
  return new Vad(
    {
      sileroVad: {
        model: `${dir}/silero-vad.onnx`,
        threshold: 0.5,
        minSpeechDuration: isDictation ? 0.15 : 0.5,
        minSilenceDuration: isDictation ? 0.25 : 0.6,
        maxSpeechDuration: VAD_BACKSTOP_SECONDS,
        windowSize: VAD_WINDOW_SIZE,
      },
      sampleRate: SAMPLE_RATE,
      numThreads: 1,
      provider: 'cpu',
      debug: false,
    },
    VAD_BUFFER_SECONDS
  )
}

function createStreamState(dir: string, captureEpochId: string, captureSequence: number): StreamState {
  return {
    detector: createVoiceActivityDetector(dir),
    captureEpochId,
    expectedSequence: captureSequence,
    nextSample: 0,
    completedThroughSample: 0,
    chunks: [],
  }
}

function decodeSpeech(engine: Recognizer, samples: Float32Array) {
  const stream = engine.createStream()
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples })
  engine.decode(stream)
  const result = engine.getResult(stream)
  return { text: String(result.text ?? '').trim(), language: String(result.lang ?? '').trim() || null }
}

function drainDetector(engine: Recognizer, state: StreamState) {
  const segments: DecodedSegment[] = []
  const promotedLanguages = new Set<TranscriptionLanguage>()
  while (!state.detector.isEmpty()) {
    const detected = (
      state.detector.front as unknown as (enableExternalBuffer: boolean) => ReturnType<VoiceActivityDetector['front']>
    )(false)
    state.detector.pop()
    const vadStartSample = detected.start
    const vadEndSample = vadStartSample + detected.samples.length
    // Keep a quiet leading word without reusing speech from a previous segment or capture epoch.
    const speech = withSpeechPreroll(detected, state.chunks, state.completedThroughSample, SAMPLE_RATE)
    const windows = splitTranscriptionSamples(speech.samples, SAMPLE_RATE)

    for (const [windowIndex, window] of windows.entries()) {
      const startedSample = speech.start + window.startSample
      const endedSample = speech.start + window.endSample
      const startedAt = timestampAtSample(state.chunks, startedSample, state.nextSample, SAMPLE_RATE) ?? Date.now()
      const endedAt = timestampAtSample(state.chunks, endedSample, state.nextSample, SAMPLE_RATE) ?? startedAt
      const result = decodeSpeech(engine, window.samples)
      const base = {
        chunkId: chunkAtSample(state.chunks, startedSample)?.id ?? state.chunks.at(-1)?.id ?? 'unknown',
        chunkIds: chunkIdsForSampleRange(state.chunks, startedSample, endedSample),
        startedAt,
        endedAt,
        vadStartedAt: timestampAtSample(state.chunks, vadStartSample, state.nextSample, SAMPLE_RATE) ?? startedAt,
        vadEndedAt: timestampAtSample(state.chunks, vadEndSample, state.nextSample, SAMPLE_RATE) ?? endedAt,
        asrWindowIndex: windowIndex,
        asrWindowCount: windows.length,
        detectedLanguage: result.language,
      }
      if (!result.text) {
        segments.push({
          ...base,
          text: '',
          transcriptionOutcome: 'asr-empty',
          acceptedLanguage: null,
          rejectionReason: null,
        })
        continue
      }
      if (isLikelyTranscriptionHallucination(result.text)) {
        segments.push({
          ...base,
          text: result.text,
          transcriptionOutcome: 'transcribed',
          acceptedLanguage: null,
          rejectionReason: 'likely-hallucination',
        })
        continue
      }

      segments.push({
        ...base,
        text: result.text,
        transcriptionOutcome: 'transcribed',
        acceptedLanguage: null,
        rejectionReason: null,
      })
    }
    state.completedThroughSample = Math.max(state.completedThroughSample, vadEndSample)
  }
  return { segments, promotedLanguages: [...promotedLanguages] }
}

function closeStream(engine: Recognizer, state: StreamState) {
  state.detector.flush()
  const decoded = drainDetector(engine, state)
  return { ...decoded, resolvedChunkIds: state.chunks.map((chunk) => chunk.id) }
}

function summarizeResult(
  segments: DecodedSegment[],
  resolvedChunkIds: string[],
  promotedLanguages: Iterable<TranscriptionLanguage>,
  hasPendingSpeech: boolean
) {
  const acceptedSegments = segments.filter(
    (segment) => !segment.rejectionReason && segment.transcriptionOutcome === 'transcribed'
  )
  const languageCounts = new Map<TranscriptionLanguage, number>()
  for (const segment of acceptedSegments) {
    if (segment.acceptedLanguage) {
      languageCounts.set(segment.acceptedLanguage, (languageCounts.get(segment.acceptedLanguage) ?? 0) + 1)
    }
  }
  const language = [...languageCounts.entries()].sort((first, second) => second[1] - first[1])[0]?.[0] ?? null

  return {
    text: acceptedSegments
      .map((segment) => segment.text)
      .filter(Boolean)
      .join(' '),
    language,
    speechDurationMs: acceptedSegments.reduce((total, segment) => total + segment.endedAt - segment.startedAt, 0),
    segments,
    resolvedChunkIds: [...new Set(resolvedChunkIds)],
    promotedLanguages: [...promotedLanguages],
    hasPendingSpeech,
  }
}

function pushChunk(engine: Recognizer, dir: string, message: WorkerMessage) {
  const streamId = message.streamId ?? 'microphone'
  const chunkId = message.chunkId ?? message.id ?? 'unknown'
  const captureEpochId = message.captureEpochId ?? streamId
  const captureSequence = message.captureSequence ?? 0
  const samples = copyTranscriptionSamples(message.samples)
  let state = streamStates.get(streamId)
  let segments: DecodedSegment[] = []
  let resolvedChunkIds: string[] = []
  const promotedLanguages = new Set<TranscriptionLanguage>()

  if (state && !isContinuousCapture(state, { captureEpochId, sequence: captureSequence })) {
    const closed = closeStream(engine, state)
    segments = closed.segments
    resolvedChunkIds = closed.resolvedChunkIds
    for (const language of closed.promotedLanguages) promotedLanguages.add(language)
    streamStates.delete(streamId)
    state = undefined
  }

  if (!state) {
    state = createStreamState(dir, captureEpochId, captureSequence)
    streamStates.set(streamId, state)
  }

  const chunkStartSample = state.nextSample
  state.chunks.push({
    id: chunkId,
    startSample: chunkStartSample,
    endSample: chunkStartSample + samples.length,
    startedAt: message.startedAt ?? Date.now(),
    samples,
  })
  state.nextSample += samples.length
  state.expectedSequence = captureSequence + 1

  for (let offset = 0; offset < samples.length; offset += VAD_WINDOW_SIZE) {
    state.detector.acceptWaveform(samples.subarray(offset, Math.min(offset + VAD_WINDOW_SIZE, samples.length)))
  }
  const decoded = drainDetector(engine, state)
  segments.push(...decoded.segments)
  for (const language of decoded.promotedLanguages) promotedLanguages.add(language)

  const hasPendingSpeech = state.detector.isDetected()
  // A newer unfinished utterance must not keep already drained chunks pending.
  // The detector releases samples through each drained segment's end, so later
  // speech cannot reach back into chunks before this completed watermark.
  const resolved = hasPendingSpeech
    ? resolveCompletedChunks(state.chunks, state.completedThroughSample)
    : resolveIdleChunks(state.chunks)
  resolvedChunkIds.push(...resolved.resolvedChunkIds)
  state.chunks = resolved.retainedChunks

  return summarizeResult(segments, resolvedChunkIds, promotedLanguages, hasPendingSpeech)
}

function flushStream(engine: Recognizer, streamId: string) {
  const state = streamStates.get(streamId)
  if (!state) return summarizeResult([], [], [], false)
  const closed = closeStream(engine, state)
  streamStates.delete(streamId)
  return summarizeResult(closed.segments, closed.resolvedChunkIds, closed.promotedLanguages, false)
}

function decodeDictation(message: WorkerMessage) {
  const samples = copyTranscriptionSamples(message.samples)
  if (samples.length < 1600) return summarizeResult([], [], [], false)
  const detector = createVoiceActivityDetector(message.modelDir, true)
  let hasSpeech = false
  for (let offset = 0; offset < samples.length; offset += VAD_WINDOW_SIZE) {
    detector.acceptWaveform(samples.subarray(offset, Math.min(offset + VAD_WINDOW_SIZE, samples.length)))
    if (detector.isDetected() || !detector.isEmpty()) {
      hasSpeech = true
      break
    }
  }
  detector.flush()
  hasSpeech ||= !detector.isEmpty()
  detector.reset()
  if (!hasSpeech) return summarizeResult([], [], [], false)
  // Dictation has explicit user boundaries. Keep the complete clip so VAD does
  // not cut a quiet first word; it only gates recordings with no speech.
  const engine = ensureRecognizer(message.modelDir)
  const windows = splitTranscriptionSamples(samples, SAMPLE_RATE)
  const start = message.startedAt ?? Date.now()
  const segments: DecodedSegment[] = windows.map((window, index) => {
    const result = decodeSpeech(engine, window.samples)
    return {
      chunkId: message.id ?? 'dictation',
      chunkIds: [],
      startedAt: start + (window.startSample / SAMPLE_RATE) * 1000,
      endedAt: start + (window.endSample / SAMPLE_RATE) * 1000,
      vadStartedAt: start,
      vadEndedAt: start + (samples.length / SAMPLE_RATE) * 1000,
      asrWindowIndex: index,
      asrWindowCount: windows.length,
      transcriptionOutcome: result.text ? 'transcribed' : 'asr-empty',
      text: result.text,
      detectedLanguage: result.language,
      acceptedLanguage: null,
      rejectionReason: null,
    }
  })
  return summarizeResult(segments, [], [], false)
}

parentPort.on('message', (event) => {
  const message = event.data
  try {
    if (message.type === 'warm') {
      ensureRecognizer(message.modelDir)
      const detector = createVoiceActivityDetector(message.modelDir)
      detector.reset()
      parentPort.postMessage({ type: 'warm-done' })
      return
    }
    if (message.type === 'dictation') {
      parentPort.postMessage({ type: 'result', id: message.id, ...decodeDictation(message) })
      return
    }
    if (message.type === 'decode') {
      const result = pushChunk(ensureRecognizer(message.modelDir), message.modelDir, message)
      parentPort.postMessage({ type: 'result', id: message.id, ...result })
      return
    }
    if (message.type === 'flush') {
      const result = flushStream(ensureRecognizer(message.modelDir), message.streamId ?? 'microphone')
      parentPort.postMessage({ type: 'result', id: message.id, ...result })
    }
  } catch (error) {
    parentPort.postMessage({ type: 'error', id: message.id, message: String((error as Error)?.message ?? error) })
  }
})
