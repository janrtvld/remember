export type IntentQuoteLayoutIssue = {
  code: 'invalid-text' | 'invalid-quotes' | 'quote-not-found' | 'quote-ambiguous' | 'quote-overlap' | 'quote-order'
  field: string
}

export type IntentQuoteLayoutSpan = { field: string; start: number; end: number }

export type IntentQuoteLayoutValidation = {
  status: 'valid' | 'invalid'
  issues: IntentQuoteLayoutIssue[]
  spans: IntentQuoteLayoutSpan[]
  unquotedRanges: Array<{ start: number; end: number }>
  semanticAssessment: 'not_assessed'
  automaticAssignment: 'not_authorized'
}

type Quotes = {
  addresseeQuote: string | null
  actionQuote: string | null
  payloadQuote: string | null
  reversalQuotes: string[]
}

const quoteKeys = Object.freeze(['addresseeQuote', 'actionQuote', 'payloadQuote', 'reversalQuotes'])

function boundedQuote(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 600
}

function quoteFields(value: unknown): value is Quotes {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== quoteKeys.length ||
    keys.some((key) => typeof key !== 'string' || !quoteKeys.includes(key)) ||
    quoteKeys.some((key) => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'))
  )
    return false

  const record = value as Record<string, unknown>
  if (
    ![record.addresseeQuote, record.actionQuote, record.payloadQuote].every(
      (quote) => quote === null || boundedQuote(quote)
    )
  )
    return false
  const reversals = record.reversalQuotes
  if (!Array.isArray(reversals) || reversals.length > 8 || Reflect.ownKeys(reversals).length !== reversals.length + 1)
    return false
  for (let index = 0; index < reversals.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(reversals, String(index))
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !boundedQuote(descriptor.value)) return false
  }
  return true
}

export function validateIntentQuoteLayout(text: string, quotes: unknown): IntentQuoteLayoutValidation {
  const issues: IntentQuoteLayoutIssue[] = []
  const spans: IntentQuoteLayoutSpan[] = []
  const unquotedRanges: Array<{ start: number; end: number }> = []
  if (typeof text !== 'string') issues.push({ code: 'invalid-text', field: 'text' })
  if (!quoteFields(quotes)) issues.push({ code: 'invalid-quotes', field: 'quotes' })
  else if (typeof text === 'string') {
    const entries: Array<[string, string | null]> = [
      ['addresseeQuote', quotes.addresseeQuote],
      ['actionQuote', quotes.actionQuote],
      ['payloadQuote', quotes.payloadQuote],
      ...quotes.reversalQuotes.map((quote, index): [string, string] => [`reversalQuotes[${index}]`, quote]),
    ]
    for (const [field, quote] of entries) {
      if (quote === null) continue
      const start = text.indexOf(quote)
      if (start === -1) issues.push({ code: 'quote-not-found', field })
      else if (text.indexOf(quote, start + 1) !== -1) issues.push({ code: 'quote-ambiguous', field })
      else spans.push({ field, start, end: start + quote.length })
    }

    for (const [index, span] of spans.entries()) {
      for (const previous of spans.slice(0, index)) {
        if (span.start < previous.end && previous.start < span.end)
          issues.push({ code: 'quote-overlap', field: span.field })
        else if (span.field !== 'addresseeQuote' && previous.field !== 'addresseeQuote' && span.start < previous.start)
          issues.push({ code: 'quote-order', field: span.field })
      }
    }
  }

  if (typeof text === 'string') {
    let cursor = 0
    for (const span of [...spans].sort((left, right) => left.start - right.start)) {
      if (cursor < span.start) unquotedRanges.push({ start: cursor, end: span.start })
      cursor = Math.max(cursor, span.end)
    }
    if (cursor < text.length) unquotedRanges.push({ start: cursor, end: text.length })
  }

  return {
    status: issues.length ? 'invalid' : 'valid',
    issues,
    spans,
    unquotedRanges,
    semanticAssessment: 'not_assessed',
    automaticAssignment: 'not_authorized',
  }
}
