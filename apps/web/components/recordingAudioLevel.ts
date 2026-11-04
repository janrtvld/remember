import type { RecordingAudioLevel } from '@remember/shared'

export function recordingAudioLevelAt(samples: readonly RecordingAudioLevel[], now: number) {
  return samples.reduce((level, sample) => {
    if (!Number.isFinite(sample.level) || !Number.isFinite(sample.at) || sample.at > now || now - sample.at >= 500)
      return level
    return Math.max(level, Math.min(1, Math.max(0, sample.level)))
  }, 0)
}
