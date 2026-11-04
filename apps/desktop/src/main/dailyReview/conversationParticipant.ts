import type { ConversationSummary, DailyReviewContextMoment } from '@remember/shared'

const BROWSER_BUNDLE_IDS = new Set([
  'com.apple.Safari',
  'com.google.Chrome',
  'com.microsoft.edgemac',
  'company.thebrowser.Browser',
  'company.thebrowser.dia',
  'org.mozilla.firefox',
])

const MEETING_BUNDLE_IDS = new Set([
  'com.apple.FaceTime',
  'com.microsoft.teams2',
  'com.tinyspeck.slackmacgap',
  'us.zoom.xos',
])

const MEETING_WINDOW_PATTERN = /\b(?:face\s?time|google meet|meet\s[-–—]|microsoft teams|zoom|huddle)\b/i
const ACTIVE_CALL_PATTERN =
  /^(?:end (?:call|meeting)|leave (?:call|meeting)|hang up|(?:un)?mute(?: microphone)?|turn (?:on|off) (?:camera|microphone)|be\u00ebindig (?:gesprek|vergadering)|(?:gesprek|vergadering) verlaten|ophangen|dempen|microfoon (?:aan|uit)|camera (?:aan|uit))(?:\s+(?:button|knop))?(?:\s*,.*)?$/i
const PARTICIPANT_COUNT_PATTERN =
  /^(?:(\d+)\s+(?:participants?|deelnemers?)|(?:participants?|deelnemers?)\s*\((\d+)\))$/i
const DIRECT_CALL_PATTERN = /^(?:call|meeting|huddle|gesprek|vergadering)\s+(?:with|met)\s+(.+)$/i
const PARTICIPANT_NAME_PATTERNS = [
  /^(.+?)\s*,\s*(?:participant|deelnemer)(?:\s*,.*)?$/i,
  /^(?:participant|deelnemer)\s*:\s*(.+)$/i,
]
const SELF_MARKER_PATTERN = /(?:\(|,\s*)(?:you|jij|me|ik)\)?(?:\s*,|$)/i
const GROUP_NAME_PATTERN = /(?:,|\s[&+]\s|\s(?:and|en)\s)/i
const NON_NAME_PATTERN =
  /^(?:you|jij|me|ik|unknown|onbekend|participant|deelnemer|guest|gast|meeting|vergadering|call|gesprek)$/i

function timestampForDayTime(dayStartedAt: number, time: string) {
  const [hours, minutes] = time.split(':').map(Number)
  const timestamp = new Date(dayStartedAt)
  timestamp.setHours(hours === 24 ? 0 : hours, minutes, 0, 0)
  if (hours === 24) timestamp.setDate(timestamp.getDate() + 1)
  return timestamp.getTime()
}

function normalizedLines(moment: DailyReviewContextMoment) {
  return [moment.windowTitle, ...moment.text.split('\n')]
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

function isKnownMeetingContext(moment: DailyReviewContextMoment) {
  const bundleId = moment.bundleId?.trim() ?? ''
  if (MEETING_BUNDLE_IDS.has(bundleId)) return true
  if (BROWSER_BUNDLE_IDS.has(bundleId)) return MEETING_WINDOW_PATTERN.test(moment.windowTitle)

  // Older stored snapshots did not expose bundle IDs. Retain a narrow app-name
  // fallback so they can qualify only when the visible window is also explicit.
  return (
    /^(?:FaceTime|Microsoft Teams|Slack|zoom\.us|Zoom)$/i.test(moment.appName.trim()) &&
    MEETING_WINDOW_PATTERN.test(`${moment.appName} ${moment.windowTitle}`)
  )
}

function cleanParticipantName(value: string) {
  const name = value
    .replace(/\s*\((?:you|jij|me|ik)\)\s*$/i, '')
    .replace(/[.!?]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (name.length < 2 || name.length > 80 || NON_NAME_PATTERN.test(name)) return null
  if (GROUP_NAME_PATTERN.test(name) || /(?:https?:|@|\d)/i.test(name)) return null
  if (!/^\p{L}[\p{L}\p{M}'’.-]*(?:\s+\p{L}[\p{L}\p{M}'’.-]*){0,5}$/u.test(name)) return null
  return name
}

type SnapshotResolution = { kind: 'none' } | { kind: 'reject' } | { kind: 'candidate'; name: string }

function candidateFromSnapshot(moment: DailyReviewContextMoment): SnapshotResolution {
  if (!isKnownMeetingContext(moment)) return { kind: 'none' }
  const lines = normalizedLines(moment)
  if (!lines.some((line) => ACTIVE_CALL_PATTERN.test(line))) return { kind: 'none' }

  const counts = lines.flatMap((line) => {
    const match = PARTICIPANT_COUNT_PATTERN.exec(line)
    const count = match?.[1] ?? match?.[2]
    return count ? [Number(count)] : []
  })
  if (counts.some((count) => count !== 2)) return { kind: 'reject' }

  const participantLines = lines.filter((line) => PARTICIPANT_NAME_PATTERNS.some((pattern) => pattern.test(line)))
  const participantCandidates = lines.flatMap((line) => {
    if (SELF_MARKER_PATTERN.test(line)) return []
    for (const pattern of PARTICIPANT_NAME_PATTERNS) {
      const match = pattern.exec(line)
      const name = match?.[1] ? cleanParticipantName(match[1]) : null
      if (name) return [name]
    }
    return []
  })
  const uniqueParticipants = new Map(participantCandidates.map((name) => [name.toLocaleLowerCase(), name]))
  if (counts.length > 0) {
    if (uniqueParticipants.size !== 1 || participantLines.length < 2) return { kind: 'reject' }
    return { kind: 'candidate', name: uniqueParticipants.values().next().value as string }
  }

  const directLines = lines.flatMap((line) => {
    const match = DIRECT_CALL_PATTERN.exec(line)
    return match?.[1] ? [match[1]] : []
  })
  const directCandidates = lines.flatMap((line) => {
    const match = DIRECT_CALL_PATTERN.exec(line)
    const name = match?.[1] ? cleanParticipantName(match[1]) : null
    return name ? [name] : []
  })
  if (new Set(directCandidates.map((name) => name.toLocaleLowerCase())).size === 1) {
    return { kind: 'candidate', name: directCandidates[0] as string }
  }
  if (directLines.length > 0) return { kind: 'reject' }
  return { kind: 'none' }
}

/**
 * Resolves exactly one other participant from explicit meeting UI captured
 * inside this conversation's own time window. Audio and conversation prose are
 * deliberately not accepted as inputs.
 */
export function resolveOtherParticipantName(
  dayStartedAt: number,
  conversation: Pick<ConversationSummary, 'startTime' | 'endTime'>,
  contextMoments: DailyReviewContextMoment[]
) {
  const startedAt = timestampForDayTime(dayStartedAt, conversation.startTime)
  const endedAt = timestampForDayTime(dayStartedAt, conversation.endTime)
  const resolutions = contextMoments
    .filter((moment) => moment.timestamp >= startedAt && moment.timestamp < endedAt)
    .map(candidateFromSnapshot)
  if (resolutions.some((resolution) => resolution.kind === 'reject')) return null
  const candidates = resolutions.flatMap((resolution) => (resolution.kind === 'candidate' ? [resolution.name] : []))
  const unique = new Map(candidates.map((name) => [name.toLocaleLowerCase(), name]))
  return unique.size === 1 ? (unique.values().next().value ?? null) : null
}

export function attachConfirmedConversationParticipants(
  dayStartedAt: number,
  conversations: ConversationSummary[],
  contextMoments: DailyReviewContextMoment[]
) {
  return conversations.map((conversation) => {
    const otherParticipantName = resolveOtherParticipantName(dayStartedAt, conversation, contextMoments)
    return otherParticipantName ? { ...conversation, otherParticipantName } : conversation
  })
}
