import type { StreamChunkRange } from './transcriptionStream'

export interface TranscriptionSampleChunk extends StreamChunkRange {
  samples: Float32Array
}

export function withSpeechPreroll(
  detected: { start: number; samples: Float32Array },
  chunks: TranscriptionSampleChunk[],
  completedThroughSample: number,
  sampleRate: number
) {
  const start = Math.min(
    detected.start,
    Math.max(0, chunks[0]?.startSample ?? detected.start, completedThroughSample, detected.start - sampleRate / 2)
  )
  const prefixLength = detected.start - start
  if (prefixLength === 0) return { start, samples: new Float32Array(detected.samples) }

  const samples = new Float32Array(prefixLength + detected.samples.length)
  for (const chunk of chunks) {
    const from = Math.max(start, chunk.startSample)
    const through = Math.min(detected.start, chunk.endSample)
    if (through > from) {
      samples.set(chunk.samples.subarray(from - chunk.startSample, through - chunk.startSample), from - start)
    }
  }
  samples.set(detected.samples, prefixLength)
  return { start, samples }
}
