export function dayContextSupportsQuote(sourceText: string, quote: string) {
  try {
    const state = JSON.parse(sourceText)
    const day = state?.day
    if (!day || typeof day !== 'object' || state.daySummaryOmitted === true) return false
    const passages = [
      day.summary,
      day.currentFocus,
      ...(day.outcomes ?? []),
      ...(day.decisions ?? []),
      ...(day.openLoops ?? []),
    ]
    if (!passages.some((passage) => typeof passage === 'string' && JSON.stringify(passage).includes(quote)))
      return false
    return !(state.tasks ?? []).some(
      (task: { lifecycle?: string; proactiveEligible?: boolean }) =>
        (task.lifecycle !== 'open' || task.proactiveEligible === false) && JSON.stringify(task).includes(quote)
    )
  } catch {
    return false
  }
}

export function contextualTopicKey(value: string) {
  return `context:${value
    .trim()
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^context:/, '')}`
}
