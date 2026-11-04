import type { CallSignal, DailyReviewContextMoment } from '@remember/shared'

type DetectedCallSurface = Pick<CallSignal, 'provider' | 'surfaceKey' | 'state'>

const ACTIVE_CONTROL_PATTERN =
  /^(?:(?:end|leave|hang up|disconnect) (?:call|meeting)|(?:un)?mute(?: microphone)?|turn (?:on|off) (?:camera|microphone)|be[eë]indig (?:gesprek|vergadering)|(?:gesprek|vergadering) verlaten|ophangen|microfoon (?:aan|uit|dempen)|camera (?:aan|uit)|spraak gekoppeld|verbinding verbreken)(?:\s+(?:button|knop))?(?:\s*,.*)?$/i
const ENDED_CONTROL_PATTERN =
  /^(?:(?:join|start) (?:call|meeting)|(?:call|meeting) ended|(?:gesprek|vergadering) (?:starten|be[eë]indigd)|deelnemen aan (?:gesprek|vergadering)|spraak verbinden)(?:\s+(?:button|knop))?(?:\s*,.*)?$/i

function normalizedKey(value: string) {
  return value
    .toLocaleLowerCase('en-US')
    .replace(/https?:\/\//g, '')
    .replace(/[^\p{L}\p{N}._/-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160)
}

function contextText(moment: DailyReviewContextMoment) {
  const focused = moment.focusedElement
  return [
    moment.windowTitle,
    moment.url ?? '',
    moment.text,
    focused?.title ?? '',
    focused?.description ?? '',
    focused?.value ?? '',
  ]
    .filter(Boolean)
    .join('\n')
}

function contextLines(moment: DailyReviewContextMoment) {
  return contextText(moment)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

function providerForMoment(moment: DailyReviewContextMoment) {
  const haystack = `${moment.appName} ${moment.bundleId ?? ''} ${moment.windowTitle} ${moment.url ?? ''}`
  if (/discord|com\.hnc\.discord/i.test(haystack)) return 'discord'
  if (/\bwoub\b|app\.woub\.chat/i.test(haystack)) return 'woub'
  if (/meet\.google\.com|google meet/i.test(haystack)) return 'google-meet'
  if (/microsoft teams|com\.microsoft\.teams/i.test(haystack)) return 'microsoft-teams'
  if (/\bzoom\b|us\.zoom\.xos/i.test(haystack)) return 'zoom'
  if (/facetime|com\.apple\.facetime/i.test(haystack)) return 'facetime'
  if (/slack|huddle|com\.tinyspeck\.slackmacgap/i.test(haystack)) return 'slack-huddle'
  return null
}

function surfaceKey(moment: DailyReviewContextMoment, provider: string) {
  // Discord keeps the call controls visible while people browse channels. The
  // window title therefore describes navigation, not the active voice call.
  if (provider === 'discord') return 'discord:call'
  if (provider === 'google-meet') {
    const meetingId = moment.url?.match(/meet\.google\.com\/([a-z-]+)/i)?.[1]
    if (meetingId) return `${provider}:${meetingId.toLocaleLowerCase()}`
  }
  if (provider === 'woub') {
    const callPath = moment.url?.match(/app\.woub\.chat\/(?:calls?|meetings?)\/([^/?#]+)/i)
    if (callPath?.[1]) return `${provider}:${normalizedKey(callPath[1])}`
  }
  const title = moment.windowTitle
    .replace(/\s*[-–—|]\s*(?:discord|woub|google meet|microsoft teams|zoom|slack).*$/i, '')
    .trim()
  return `${provider}:${normalizedKey(title) || 'call'}`
}

/**
 * Converts only explicit call controls into state. Merely seeing a meeting app,
 * participant roster, or another person's “in call” status is deliberately ignored.
 */
export function detectCallSurface(moment: DailyReviewContextMoment): DetectedCallSurface | null {
  const provider = providerForMoment(moment)
  if (!provider) return null
  const lines = contextLines(moment)
  const key = surfaceKey(moment, provider)

  if (lines.some((line) => ACTIVE_CONTROL_PATTERN.test(line))) {
    return { provider, surfaceKey: key, state: 'active' }
  }
  if (lines.some((line) => ENDED_CONTROL_PATTERN.test(line))) {
    return { provider, surfaceKey: key, state: 'ended' }
  }

  return null
}
