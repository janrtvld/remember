import { createHash } from 'node:crypto'

export function validateBriefingOutput(raw, input) {
  const issues = []
  const references = new Set()
  const sources = new Map(input.sources.map((source) => [source.sourceId, source]))
  if (sources.size !== input.sources.length) issues.push('input:duplicate-source')
  for (const source of sources.values()) {
    if (createHash('sha256').update(source.text).digest('hex') !== source.revision)
      issues.push('input:revision-mismatch')
  }

  const object = (value, keys, location) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      issues.push(`${location}:object`)
      return false
    }
    if (Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) issues.push(`${location}:keys`)
    return true
  }
  const string = (value, max, location) => {
    if (typeof value !== 'string' || !value.trim() || [...value].length > max) {
      issues.push(`${location}:string-bound`)
      return false
    }
    return true
  }
  const line = (value, max, location) => {
    if (!object(value, ['text', 'quotes'], location)) return
    string(value.text, max, `${location}.text`)
    if (!Array.isArray(value.quotes) || value.quotes.length < 1 || value.quotes.length > 3) {
      issues.push(`${location}.quotes:count`)
      return
    }
    const seen = new Set()
    for (const [index, quote] of value.quotes.entries()) {
      const at = `${location}.quotes[${index}]`
      if (!object(quote, ['sourceId', 'quote'], at)) continue
      const idValid = string(quote.sourceId, 100, `${at}.sourceId`)
      const quoteValid = string(quote.quote, 600, `${at}.quote`)
      if (!idValid || !quoteValid) continue
      const id = quote.sourceId
      const text = quote.quote
      const source = sources.get(id)
      if (!source || !source.text.includes(text)) issues.push(`${at}:unbound-quote`)
      else references.add(id)
      const key = JSON.stringify([id, text])
      if (seen.has(key)) issues.push(`${at}:duplicate-quote`)
      seen.add(key)
    }
  }
  let output = null
  if (Buffer.byteLength(raw, 'utf8') > 16_384) issues.push('output:byte-bound')
  else {
    try {
      output = JSON.parse(raw)
    } catch {
      issues.push('output:json')
    }
  }
  if (issues.includes('output:json') || issues.includes('output:byte-bound'))
    return { valid: false, issues, output: null, sourceRefs: [] }

  if (object(output, ['version', 'kind', 'reason', 'briefing'], 'output')) {
    if (output.version !== 1) issues.push('output.version:enum')
    if (output.kind !== 'silent' && output.kind !== 'private-briefing') issues.push('output.kind:enum')
    line(output.reason, 280, 'output.reason')
    if (output.kind === 'silent') {
      if (output.briefing !== null) issues.push('output.briefing:silent-body')
    } else if (object(output.briefing, ['title', 'decision', 'facts', 'openPoints', 'questions'], 'output.briefing')) {
      string(output.briefing.title, 80, 'output.briefing.title')
      line(output.briefing.decision, 400, 'output.briefing.decision')
      for (const [key, min, max] of [
        ['facts', 2, 4],
        ['openPoints', 1, 2],
        ['questions', 3, 3],
      ]) {
        const values = output.briefing[key]
        if (!Array.isArray(values) || values.length < min || values.length > max) {
          issues.push(`output.briefing.${key}:count`)
          continue
        }
        values.forEach((value, index) => {
          line(value, 280, `output.briefing.${key}[${index}]`)
        })
      }
    }
  }
  return {
    valid: issues.length === 0,
    issues,
    output,
    sourceRefs: issues.length
      ? []
      : [...references].sort().map((sourceId) => ({ sourceId, revision: sources.get(sourceId).revision })),
  }
}
