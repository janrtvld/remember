export type TranscriptionLanguage = 'nl' | 'en'

export interface TranscriptionLanguageState {
  defaultLanguage: TranscriptionLanguage
  language: TranscriptionLanguage
  lastAcceptedSpeechAt: number | null
  candidateLanguage: TranscriptionLanguage | null
  candidateSegments: number
  candidateSpeechMs: number
}

interface TranscriptionSegment {
  detectedLanguage: string | null
  speechStartedAt: number
  speechDurationMs: number
}

export type TranscriptionLanguageRejectionReason =
  | 'unsupported-language'
  | 'cross-language-short'
  | 'cross-language-unconfirmed'

const DEFAULT_LANGUAGE: TranscriptionLanguage = 'nl'
const CONVERSATION_RESET_MS = 2 * 60_000
const MIN_CROSS_LANGUAGE_SPEECH_MS = 1_500
const IMMEDIATE_SWITCH_SPEECH_MS = 6_000
const CANDIDATE_SWITCH_SPEECH_MS = 3_500
const CANDIDATE_SWITCH_SEGMENTS = 2

export function initialTranscriptionLanguageState(
  defaultLanguage: TranscriptionLanguage = DEFAULT_LANGUAGE
): TranscriptionLanguageState {
  return {
    defaultLanguage,
    language: defaultLanguage,
    lastAcceptedSpeechAt: null,
    candidateLanguage: null,
    candidateSegments: 0,
    candidateSpeechMs: 0,
  }
}

export function supportedTranscriptionLanguage(language: string | null): TranscriptionLanguage | null {
  const normalized = language?.trim().toLocaleLowerCase().split(/[-_]/)[0]
  return normalized === 'nl' || normalized === 'en' ? normalized : null
}

export function evaluateTranscriptionSegment(state: TranscriptionLanguageState, segment: TranscriptionSegment) {
  const stateAtSpeechStart = resetAfterConversationGap(state, segment.speechStartedAt)
  const detectedLanguage = supportedTranscriptionLanguage(segment.detectedLanguage)
  if (segment.detectedLanguage && !detectedLanguage) {
    return {
      accept: false,
      language: null,
      rejectionReason: 'unsupported-language' as const,
      state: stateAtSpeechStart,
    }
  }

  const language = detectedLanguage ?? stateAtSpeechStart.language
  const speechEndedAt = segment.speechStartedAt + segment.speechDurationMs
  if (language === stateAtSpeechStart.language) {
    return {
      accept: true,
      language,
      rejectionReason: null,
      state: {
        ...stateAtSpeechStart,
        lastAcceptedSpeechAt: speechEndedAt,
        candidateLanguage: null,
        candidateSegments: 0,
        candidateSpeechMs: 0,
      },
    }
  }

  if (segment.speechDurationMs < MIN_CROSS_LANGUAGE_SPEECH_MS) {
    return {
      accept: false,
      language: null,
      rejectionReason: 'cross-language-short' as const,
      state: stateAtSpeechStart,
    }
  }

  const isSameCandidate = stateAtSpeechStart.candidateLanguage === language
  const candidateSegments = isSameCandidate ? stateAtSpeechStart.candidateSegments + 1 : 1
  const candidateSpeechMs = isSameCandidate
    ? stateAtSpeechStart.candidateSpeechMs + segment.speechDurationMs
    : segment.speechDurationMs
  const shouldSwitch =
    segment.speechDurationMs >= IMMEDIATE_SWITCH_SPEECH_MS ||
    (candidateSegments >= CANDIDATE_SWITCH_SEGMENTS && candidateSpeechMs >= CANDIDATE_SWITCH_SPEECH_MS)

  const nextState = {
    ...stateAtSpeechStart,
    language: shouldSwitch ? language : stateAtSpeechStart.language,
    lastAcceptedSpeechAt: shouldSwitch ? speechEndedAt : stateAtSpeechStart.lastAcceptedSpeechAt,
    candidateLanguage: shouldSwitch ? null : language,
    candidateSegments: shouldSwitch ? 0 : candidateSegments,
    candidateSpeechMs: shouldSwitch ? 0 : candidateSpeechMs,
  }

  return {
    accept: shouldSwitch,
    language: shouldSwitch ? language : null,
    rejectionReason: shouldSwitch ? null : ('cross-language-unconfirmed' as const),
    state: {
      ...nextState,
    },
  }
}

function resetAfterConversationGap(state: TranscriptionLanguageState, speechStartedAt: number) {
  if (state.lastAcceptedSpeechAt === null || speechStartedAt - state.lastAcceptedSpeechAt < CONVERSATION_RESET_MS) {
    return state
  }
  return initialTranscriptionLanguageState(state.defaultLanguage)
}
