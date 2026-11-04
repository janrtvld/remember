import type { DailyReviewMoment, SpeechSegment } from '@remember/shared'

export function resolvedAudioMoment(
  moment: DailyReviewMoment,
  segments: SpeechSegment[],
  interrupted = false
): DailyReviewMoment {
  const captured = segments.filter((segment) => segment.chunkId === moment.id)
  const transcript = captured
    .filter(
      (segment) => !segment.rejectionReason && segment.transcriptionOutcome !== 'asr-empty' && segment.text.trim()
    )
    .sort((first, second) => first.startedAt - second.startedAt)
    .map((segment) => segment.text.trim())
    .join(' ')
  const savedTranscript = transcript || (interrupted ? moment.transcript.trim() : '')
  const captureOutcome = savedTranscript
    ? 'transcribed'
    : captured.some((segment) => segment.transcriptionOutcome === 'asr-empty')
      ? 'asr-empty'
      : captured.some((segment) => segment.rejectionReason)
        ? 'quarantined'
        : interrupted
          ? 'failed'
          : 'vad-empty'
  return {
    ...moment,
    transcript: savedTranscript,
    status: savedTranscript ? 'ready' : captureOutcome === 'failed' ? 'failed' : 'empty',
    captureOutcome,
  }
}
