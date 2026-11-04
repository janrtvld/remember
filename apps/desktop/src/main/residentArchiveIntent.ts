// These bounded language hints choose retrieval routes; they are not a semantic authorization boundary.
export function usesOnlyPriorReply(text: string) {
  return (
    /\b(?:vorige (?:antwoord|weekoverzicht|dagoverzicht)|previous (?:answer|reply|summary))\b/i.test(text) &&
    /\b(?:geen nieuwe bronnen|zonder nieuwe bronnen|no new sources|without new sources)\b/i.test(text)
  )
}

function requestsStoredRead(text: string) {
  const request = text
    .trim()
    .replace(/^(?:(?:kun|kan|wil|zou) je|(?:can|could|would) you|please|graag)\s+(?:please\s+)?/i, '')
  return (
    /^(?:zoek|doorzoek|vind|lees|bekijk|toon|show|find|read|search|retrieve|list|summari[sz]e)\b/i.test(request) ||
    /^laat\b.{0,160}\bzien\b/i.test(request) ||
    /^vat\b.{0,160}\bsamen\b/i.test(request) ||
    /^geef\b.{0,160}\boverzicht\b/i.test(request) ||
    /^(?:kun|kan|wil|zou) je\b.{0,160}\b(?:zoeken|terugvinden|lezen|bekijken|tonen|opzoeken|samenvatten)\b/i.test(
      text.trim()
    )
  )
}

function asksAboutStoredState(text: string) {
  const question = text.trim().replace(/^(?:vertel me|tell me|ik ben benieuwd|i wonder)\s+/i, '')
  if (
    /^(?:wat als|what if)\b/i.test(question) ||
    /\b(?:zou(?:den)?|zullen|zal|would|could|might|should)\b/i.test(question)
  )
    return false
  if (
    /^(?:welk(?:e)?|which|what)\b.{0,120}\b(?:gisteren|vandaag|eergisteren|yesterday|today|\d{4}-\d{2}-\d{2})\b/i.test(
      question
    )
  )
    return true
  return (
    /^(?:wat|welk(?:e)?|hoe(?:veel)?|wanneer|waar(?:over)?|met wie|wie|heb(?:ben)?|ben|is|zijn|staan|was|waren|what|which|how|when|where|who|have|has|did|do|does|are|were)\b/i.test(
      question
    ) &&
    /\b(?:heb|heeft|hebben|ben|bent|geweest|had|hadden|was|waren|is|zijn|staat|staan|stond|stonden|ziet|zag|zagen|deed|deden|gedaan|gewerkt|besproken|gezegd|zei|zeiden|sprak|spraken|gesproken|gepraat|praatte|have|has|had|was|were|is|are|did|done|worked|said|spoke|spoken|talked|discussed)\b/i.test(
      question
    )
  )
}

export function conversationQuestion(text: string) {
  if (usesOnlyPriorReply(text)) return false
  const factualQuestion = asksAboutStoredState(text)
  return (
    ((requestsStoredRead(text) || factualQuestion) &&
      /\b(?:gesprek(?:ken|je|jes)?|conversati\w*|conversation\w*|meetings?|vergadering\w*|transcript\w*|opnames?|opnamen|recordings?)\b/i.test(
        text
      )) ||
    (factualQuestion &&
      (/\bmet wie\b.{0,160}\b(?:sprak|spraken|gesproken|gepraat|praatte)\b/i.test(text) ||
        /\bwaarover\b.{0,160}\b(?:hadden|had|ging|gingen|gesproken|gepraat|besproken)\b/i.test(text) ||
        /\bwat\b.{0,160}\b(?:besproken|gezegd)\b/i.test(text) ||
        /\bwat\s+(?:zei|zeiden)\b/i.test(text) ||
        /\bwho\b.{0,160}\b(?:talk|talked|speak|spoke|spoken)\b/i.test(text) ||
        /\bwhat\b.{0,160}\b(?:discuss|discussed|say|said|talk about)\b/i.test(text)))
  )
}

export function needsRememberEvidence(text: string) {
  if (usesOnlyPriorReply(text)) return false
  if (conversationQuestion(text)) return true
  if (!requestsStoredRead(text) && !asksAboutStoredState(text)) return false
  if (/\bremember\b/i.test(text) && requestsStoredRead(text)) return true
  if (/\b(?:activiteit(?:en)?|activity|activities|taken|tasks?|notities?|aantekeningen?|notes?)\b/i.test(text))
    return true
  const personal = /\b(?:ik|mijn|mij|we|wij|ons|onze|i|my|me|we|our)\b/i.test(text)
  return (
    personal &&
    /\b(?:vandaag|gisteren|eergisteren|dag|week|gedaan|bezig|gewerkt|afgerond|afspraak|afspraken|planning|today|yesterday|day|week|did|done|working|worked|finished|appointment|appointments|schedule)\b/i.test(
      text
    )
  )
}

const months: Record<string, number> = {
  januari: 1,
  january: 1,
  jan: 1,
  februari: 2,
  february: 2,
  feb: 2,
  maart: 3,
  march: 3,
  mrt: 3,
  mar: 3,
  april: 4,
  apr: 4,
  mei: 5,
  may: 5,
  juni: 6,
  june: 6,
  jun: 6,
  juli: 7,
  july: 7,
  jul: 7,
  augustus: 8,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  oktober: 10,
  october: 10,
  okt: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
}

function exactDate(year: number, month: number, day: number) {
  const value = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  const parsed = new Date(`${value}T12:00:00Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value)
    throw new Error('remember-archive-invalid-request-date')
  return value
}

function localDate(date: Date) {
  return exactDate(date.getFullYear(), date.getMonth() + 1, date.getDate())
}

// Explicit dates use the primary Mac's current calendar year when omitted. Weekdays, ranges and travel zones are not inferred.
export function requestedArchiveDates(text: string, now: number | Date = Date.now()): string[] {
  const current = new Date(now)
  if (!Number.isFinite(current.getTime())) throw new Error('remember-archive-invalid-clock')
  const dates = new Set<string>()
  for (const match of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g))
    dates.add(exactDate(Number(match[1]), Number(match[2]), Number(match[3])))
  const names = Object.keys(months)
    .sort((a, b) => b.length - a.length)
    .join('|')
  const dayFirst = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th|e)?\\s+(${names})\\.?(?:\\s+(\\d{4}))?\\b`, 'gi')
  const monthFirst = new RegExp(`\\b(${names})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'gi')
  for (const match of text.matchAll(dayFirst))
    dates.add(
      exactDate(match[3] ? Number(match[3]) : current.getFullYear(), months[match[2].toLowerCase()], Number(match[1]))
    )
  for (const match of text.matchAll(monthFirst))
    dates.add(
      exactDate(match[3] ? Number(match[3]) : current.getFullYear(), months[match[1].toLowerCase()], Number(match[2]))
    )
  if (conversationQuestion(text)) {
    if (/\b(?:vandaag|today)\b/i.test(text)) dates.add(localDate(current))
    if (/\b(?:gisteren|yesterday)\b/i.test(text)) {
      const yesterday = new Date(current)
      yesterday.setDate(yesterday.getDate() - 1)
      dates.add(localDate(yesterday))
    }
  }
  return [...dates]
}
