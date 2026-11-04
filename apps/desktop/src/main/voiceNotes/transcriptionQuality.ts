const COMMON_HALLUCINATIONS = new Set([
  'thank you for watching',
  'thanks for watching',
  'please subscribe',
  'subtitles by the amara org community',
  'ondertitels ingediend door de amara org gemeenschap',
  'bedankt voor het kijken',
])

function normalizedWords(text: string) {
  return (
    text
      .toLocaleLowerCase('en-US')
      .match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'’-]*/gu)
      ?.filter(Boolean) ?? []
  )
}

/** Conservative rejection of known silence completions and degenerate repetition. */
export function isLikelyTranscriptionHallucination(text: string) {
  const words = normalizedWords(text)
  if (words.length === 0) return true
  const normalized = words.join(' ')
  if (COMMON_HALLUCINATIONS.has(normalized)) return true
  if (words.length < 6) return false

  const counts = new Map<string, number>()
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1)
  const mostFrequent = Math.max(...counts.values())
  if (mostFrequent / words.length >= 0.7) return true

  const trigrams = words.slice(0, -2).map((word, index) => `${word} ${words[index + 1]} ${words[index + 2]}`)
  return new Set(trigrams).size <= Math.max(1, Math.floor(trigrams.length / 3))
}
