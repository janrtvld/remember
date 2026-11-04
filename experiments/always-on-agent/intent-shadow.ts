export type IntentShadowReference = {
  evidenceId: string
  sourceId: string
  revision: string
}

export type IntentShadowSource = IntentShadowReference & {
  kind: 'speech' | 'context'
  text: string
}

export type IntentShadowRecord = IntentShadowReference & {
  speechAct: 'direct_request' | 'speaker_commitment' | 'reported' | 'unclear'
  claimedOwner: 'user' | 'other' | 'unknown'
  actionStatus: 'active' | 'withdrawn' | 'unclear'
  actionSummary: string
  addresseeQuote: string | null
  actionQuote: string | null
  payloadQuote: string | null
  reversalQuotes: string[]
}

// Supplied independently by the caller, never extracted from the model record.
// Neither absence of media nor an observed call establishes the speaker's identity.
export type IntentShadowProvenance = {
  state: 'unknown' | 'explicit-media' | 'mixed-media-call'
  refs: IntentShadowReference[]
}

const referenceProperties = {
  evidenceId: { type: 'string', minLength: 1, maxLength: 256 },
  sourceId: { type: 'string', minLength: 1, maxLength: 256 },
  revision: { type: 'string', minLength: 1, maxLength: 128 },
}
const quoteSchema = { type: ['string', 'null'], minLength: 1, maxLength: 600 }
const recordProperties = {
  ...referenceProperties,
  speechAct: { type: 'string', enum: ['direct_request', 'speaker_commitment', 'reported', 'unclear'] },
  claimedOwner: { type: 'string', enum: ['user', 'other', 'unknown'] },
  actionStatus: { type: 'string', enum: ['active', 'withdrawn', 'unclear'] },
  actionSummary: { type: 'string', maxLength: 600 },
  addresseeQuote: quoteSchema,
  actionQuote: quoteSchema,
  payloadQuote: quoteSchema,
  reversalQuotes: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 600 } },
}

export const INTENT_SHADOW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['records'],
  properties: {
    records: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: Object.keys(recordProperties),
        properties: recordProperties,
      },
    },
  },
}

export type IntentShadowIssue = {
  code:
    | 'invalid-record'
    | 'source-not-found'
    | 'source-ambiguous'
    | 'source-identity-mismatch'
    | 'source-revision-mismatch'
    | 'unsupported-source-kind'
    | 'missing-required-quote'
    | 'quote-not-found'
    | 'quote-ambiguous'
    | 'quote-overlap'
    | 'quote-order'
    | 'invalid-provenance'
  field: string
}

export type IntentShadowSpan = { field: string; start: number; end: number }
export type IntentShadowValidation = {
  claim: IntentShadowRecord | null
  source: IntentShadowSource | null
  structural: {
    status: 'valid' | 'invalid'
    issues: IntentShadowIssue[]
    // Offsets are JavaScript UTF-16 indices; no normalization or trimming is applied.
    spans: IntentShadowSpan[]
    unquotedRanges: Array<{ start: number; end: number }>
  }
  semanticAssessment: 'not_assessed'
  provenance: IntentShadowProvenance
  sourceSuitability: 'unknown' | 'ineligible'
  automaticAssignment: 'not_authorized'
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function boundedText(value: unknown, max: number, empty = false): value is string {
  return typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0)
}

function reference(value: unknown): value is IntentShadowReference & Record<string, unknown> {
  return (
    object(value) &&
    boundedText(value.evidenceId, 256) &&
    boundedText(value.sourceId, 256) &&
    boundedText(value.revision, 128)
  )
}

function record(value: unknown): value is IntentShadowRecord {
  if (!object(value) || !reference(value)) return false
  if (
    Object.keys(value).length !== Object.keys(recordProperties).length ||
    Object.keys(value).some((key) => !Object.hasOwn(recordProperties, key))
  )
    return false
  return (
    typeof value.speechAct === 'string' &&
    recordProperties.speechAct.enum.includes(value.speechAct) &&
    typeof value.claimedOwner === 'string' &&
    recordProperties.claimedOwner.enum.includes(value.claimedOwner) &&
    typeof value.actionStatus === 'string' &&
    recordProperties.actionStatus.enum.includes(value.actionStatus) &&
    boundedText(value.actionSummary, 600, true) &&
    [value.addresseeQuote, value.actionQuote, value.payloadQuote].every(
      (quote) => quote === null || boundedText(quote, 600)
    ) &&
    Array.isArray(value.reversalQuotes) &&
    value.reversalQuotes.length <= 8 &&
    value.reversalQuotes.every((quote) => boundedText(quote, 600))
  )
}

function sameReference(left: IntentShadowReference, right: IntentShadowReference) {
  return left.evidenceId === right.evidenceId && left.sourceId === right.sourceId && left.revision === right.revision
}

export function validateIntentShadow(
  input: unknown,
  sources: readonly IntentShadowSource[],
  provenance: IntentShadowProvenance
): IntentShadowValidation {
  const issues: IntentShadowIssue[] = []
  const spans: IntentShadowSpan[] = []
  const unquotedRanges: Array<{ start: number; end: number }> = []
  let checkedProvenance: IntentShadowProvenance = { state: 'unknown', refs: [] }
  if (
    !object(provenance) ||
    Object.keys(provenance).length !== 2 ||
    !['unknown', 'explicit-media', 'mixed-media-call'].includes(provenance.state) ||
    !Array.isArray(provenance.refs) ||
    provenance.refs.length > 12 ||
    (provenance.state !== 'unknown' && provenance.refs.length === 0) ||
    provenance.refs.some(
      (ref) => !reference(ref) || sources.filter((source) => sameReference(ref, source)).length !== 1
    )
  ) {
    issues.push({ code: 'invalid-provenance', field: 'provenance' })
  } else {
    checkedProvenance = {
      state: provenance.state,
      refs: provenance.refs.map(({ evidenceId, sourceId, revision }) => ({ evidenceId, sourceId, revision })),
    }
  }

  const claim = record(input) ? { ...input, reversalQuotes: [...input.reversalQuotes] } : null
  let source: IntentShadowSource | null = null
  if (!claim) issues.push({ code: 'invalid-record', field: 'record' })
  else {
    const matching = sources.filter((candidate) => candidate.evidenceId === claim.evidenceId)
    const candidate = matching[0]
    if (!candidate) issues.push({ code: 'source-not-found', field: 'evidenceId' })
    else if (matching.length !== 1) issues.push({ code: 'source-ambiguous', field: 'evidenceId' })
    else {
      if (candidate.sourceId !== claim.sourceId) issues.push({ code: 'source-identity-mismatch', field: 'sourceId' })
      else if (candidate.revision !== claim.revision)
        issues.push({ code: 'source-revision-mismatch', field: 'revision' })
      else if (candidate.kind !== 'speech') issues.push({ code: 'unsupported-source-kind', field: 'source' })
      else source = { ...candidate }
    }
  }

  if (claim && source) {
    if (claim.speechAct === 'direct_request' && claim.addresseeQuote === null)
      issues.push({ code: 'missing-required-quote', field: 'addresseeQuote' })
    if (['direct_request', 'speaker_commitment'].includes(claim.speechAct) && claim.actionQuote === null)
      issues.push({ code: 'missing-required-quote', field: 'actionQuote' })
    if (claim.actionStatus === 'withdrawn' && claim.reversalQuotes.length === 0)
      issues.push({ code: 'missing-required-quote', field: 'reversalQuotes' })

    const quotes: Array<[string, string | null]> = [
      ['addresseeQuote', claim.addresseeQuote],
      ['actionQuote', claim.actionQuote],
      ['payloadQuote', claim.payloadQuote],
      ...claim.reversalQuotes.map((quote, index): [string, string] => [`reversalQuotes[${index}]`, quote]),
    ]
    for (const [field, quote] of quotes) {
      if (quote === null) continue
      const start = source.text.indexOf(quote)
      if (start === -1) issues.push({ code: 'quote-not-found', field })
      else if (source.text.indexOf(quote, start + 1) !== -1) issues.push({ code: 'quote-ambiguous', field })
      else spans.push({ field, start, end: start + quote.length })
    }
    for (const [index, span] of spans.entries()) {
      for (const previous of spans.slice(0, index)) {
        if (span.start < previous.end && previous.start < span.end)
          issues.push({ code: 'quote-overlap', field: span.field })
        else if (span.start < previous.start) issues.push({ code: 'quote-order', field: span.field })
      }
    }

    let cursor = 0
    for (const span of [...spans].sort((left, right) => left.start - right.start)) {
      if (cursor < span.start) unquotedRanges.push({ start: cursor, end: span.start })
      cursor = Math.max(cursor, span.end)
    }
    if (cursor < source.text.length) unquotedRanges.push({ start: cursor, end: source.text.length })
  }

  return {
    claim,
    source,
    structural: { status: issues.length ? 'invalid' : 'valid', issues, spans, unquotedRanges },
    semanticAssessment: 'not_assessed',
    provenance: checkedProvenance,
    sourceSuitability: checkedProvenance.state === 'unknown' ? 'unknown' : 'ineligible',
    automaticAssignment: 'not_authorized',
  }
}
