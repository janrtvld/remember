export interface StreamChunkRange {
  id: string
  startSample: number
  endSample: number
  startedAt: number
}

export function isContinuousCapture(
  current: { captureEpochId: string; expectedSequence: number },
  next: { captureEpochId: string; sequence: number }
) {
  return current.captureEpochId === next.captureEpochId && current.expectedSequence === next.sequence
}

export function chunkAtSample(chunks: StreamChunkRange[], sample: number) {
  return chunks.find((chunk) => sample >= chunk.startSample && sample < chunk.endSample) ?? chunks.at(-1) ?? null
}

export function timestampAtSample(chunks: StreamChunkRange[], sample: number, nextSample: number, sampleRate: number) {
  const lookupSample = Math.max(0, sample - (sample === nextSample ? 1 : 0))
  const chunk = chunkAtSample(chunks, lookupSample)
  if (!chunk) return null
  const offset = Math.max(0, Math.min(chunk.endSample, sample) - chunk.startSample)
  return Math.round(chunk.startedAt + (offset / sampleRate) * 1_000)
}

export function chunkIdsForSampleRange(chunks: StreamChunkRange[], startSample: number, endSample: number) {
  return chunks
    .filter((chunk) => chunk.startSample < endSample && chunk.endSample > startSample)
    .map((chunk) => chunk.id)
}

export function resolveIdleChunks<T extends StreamChunkRange>(chunks: T[]) {
  return {
    resolvedChunkIds: chunks.slice(0, -1).map((chunk) => chunk.id),
    retainedChunks: chunks.slice(-1),
  }
}

export function resolveCompletedChunks<T extends StreamChunkRange>(chunks: T[], completedThroughSample: number) {
  const newestChunk = chunks.at(-1)
  const isCompleted = (chunk: StreamChunkRange) => chunk !== newestChunk && chunk.endSample <= completedThroughSample
  return {
    resolvedChunkIds: chunks.filter(isCompleted).map((chunk) => chunk.id),
    retainedChunks: chunks.filter((chunk) => !isCompleted(chunk)),
  }
}
