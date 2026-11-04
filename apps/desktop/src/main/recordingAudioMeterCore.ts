import type { RecordingAudioLevel } from '@remember/shared'

export function pcmRms(samples: Float32Array) {
  if (!samples.length) return 0
  let squares = 0
  for (const sample of samples) {
    if (!Number.isFinite(sample)) return 0
    const bounded = Math.max(-1, Math.min(1, sample))
    squares += bounded * bounded
  }
  return Math.sqrt(squares / samples.length)
}

export function createRecordingAudioMeter(publish: (sample: RecordingAudioLevel) => void, now = Date.now) {
  const last = new Map<RecordingAudioLevel['source'], number>()
  return (source: RecordingAudioLevel['source'], rms: number) => {
    if (!Number.isFinite(rms) || rms < 0) return
    const at = now()
    const previous = last.get(source)
    if (previous !== undefined && at >= previous && at - previous < 200) return
    last.set(source, at)
    publish({ source, level: Math.min(1, Math.sqrt(rms) * 2.5), at })
  }
}
