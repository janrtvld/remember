import type { OpenTask, WorkItem } from '@remember/shared'
import type { AmbientEvidence } from './ambientTaskStore'
import { parseDayMemory } from './analysisFormat'
import { FINAL_ANALYSIS_SCHEMA } from './analysisSchemas'
import type { AnalyzedWorkItemPlan } from './workItemAnalysis'

const supportProperties = {
  evidenceQuote: { type: 'string', minLength: 12, maxLength: 600 },
  ownership: { type: 'string', enum: ['user', 'other', 'unknown'] },
}
const task = FINAL_ANALYSIS_SCHEMA.properties.openTasks.items
const change = FINAL_ANALYSIS_SCHEMA.properties.taskChanges.items
export const AMBIENT_TASK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['proposed', 'changes', 'consideredEvidenceIds'],
  properties: {
    consideredEvidenceIds: { type: 'array', items: { type: 'string' }, maxItems: 12 },
    proposed: {
      type: 'array',
      maxItems: 5,
      items: {
        ...task,
        properties: {
          ...task.properties,
          aiSuggestion: {
            ...task.properties.aiSuggestion,
            description:
              'One optional offer sentence addressed to the user for a supported concrete deliverable, such as drafting a message for review. Never the draft itself or a claim of completed work. The human obligation remains open. Null if no useful deliverable is supported; never invent preparation or imply permission.',
          },
          ...supportProperties,
          notify: { type: 'boolean' },
        },
        required: [...task.required, 'evidenceQuote', 'ownership', 'notify'],
      },
    },
    changes: {
      type: 'array',
      maxItems: 10,
      items: {
        ...change,
        properties: { ...change.properties, ...supportProperties, evidenceId: { type: 'string' } },
        required: [...change.required, 'evidenceQuote', 'ownership', 'evidenceId'],
      },
    },
  },
}

export interface AmbientTaskPlan extends AnalyzedWorkItemPlan {
  notifyTitles: string[]
  consideredEvidenceIds: string[]
}

function normalized(value: string) {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

function directlyAssignedSpeech(value: Record<string, unknown>, source: AmbientEvidence, userName: string) {
  // Without verified speakers, only a direct named request can create an audio task.
  // A completion claim or a name mentioned as recipient does not establish ownership.
  if (typeof value.title !== 'string') return false
  const quote = normalized(String(value.evidenceQuote))
  const name = normalized(userName)
  if (!quote.startsWith(`${name},`)) return false
  const sourceText = normalized(source.text)
  const prefix = sourceText.slice(0, sourceText.indexOf(quote)).trimEnd()
  if (prefix && !/[.!?]$/.test(prefix)) return false

  const passage = quote.slice(name.length + 1).trim()
  const boundary = passage.search(/[.!?](?=\s|$)/u)
  const request = boundary === -1 ? passage : passage.slice(0, boundary)
  const continuation = boundary === -1 ? '' : passage.slice(boundary + 1)
  // Reasons after the request do not change its addressee. Explicit reversals or
  // first-person continuations remain ambiguous without verified speakers.
  if (
    /\b(?:ik|wij|we|i|instead|myself|ourselves|zelf|overneem|overnemen)\b|\b(?:laat maar|toch niet|niet meer|never mind|nevermind|do not|don't|don’t)\b/u.test(
      continuation
    )
  ) {
    return false
  }
  const modal = /^(?:(?:can|could|will|would) you|(?:kun|kan|wil|zou) (?:je|jij))\s+/.exec(request)
  const directive = request.slice(modal?.[0].length ?? 0).replace(/^(?:please|alsjeblieft)\s+/, '')
  if (/\b(?:niet|nooit|geen|not|never)\b|\bdon['’]t\b/u.test(directive)) return false
  if (modal) {
    // The explicit addressee owns a simple second-person request regardless of title
    // word order. Nested requests still need ownership reasoning we cannot verify here.
    return (
      directive.length >= 8 &&
      !/\b(?:dat|of|te|whether|if|that)\b/u.test(directive) &&
      !/^(?:have|get|let|ask|tell)\b/u.test(directive) &&
      !/\b(?:ik|wij|we|i|he|she|they|hij|zij)\b/u.test(directive)
    )
  }
  const action = directive.match(/^[\p{L}]+/u)?.[0]
  const titleAction = normalized(value.title).match(/^[\p{L}]+/u)?.[0]
  if (!action || action !== titleAction) return false
  return !/^(?:ik|wij|we|i|my|our|je|jij|you|hij|zij|he|she|they|het|de|een|the|a|an|dit|dat|this|that|misschien|maybe)$/.test(
    action
  )
}

function supportsUserAction(
  value: Record<string, unknown>,
  source: AmbientEvidence | undefined,
  userName: string | null
) {
  if (!source || value.ownership !== 'user' || typeof value.evidenceQuote !== 'string') return false
  const quote = normalized(value.evidenceQuote)
  if (quote.length < 12 || !normalized(source.text).includes(quote)) return false
  if (source.kind === 'speech') {
    if (!userName || !directlyAssignedSpeech(value, source, userName)) return false
  }
  return true
}

export function parseAmbientTaskPlan(
  value: unknown,
  evidence: AmbientEvidence[],
  userName: string | null,
  items: WorkItem[]
): AmbientTaskPlan {
  if (!value || typeof value !== 'object') throw new Error('agent-invalid-response')
  const output = value as { proposed?: unknown; changes?: unknown; consideredEvidenceIds?: unknown }
  if (
    !Array.isArray(output.proposed) ||
    !Array.isArray(output.changes) ||
    output.proposed.length > 5 ||
    output.changes.length > 10
  ) {
    throw new Error('agent-invalid-response')
  }
  if (
    !Array.isArray(output.consideredEvidenceIds) ||
    output.consideredEvidenceIds.some(
      (id) => typeof id !== 'string' || !evidence.some((entry) => entry.evidenceId === id)
    )
  ) {
    throw new Error('agent-invalid-response')
  }
  const consideredEvidenceIds = [...new Set(output.consideredEvidenceIds)] as string[]
  if (!consideredEvidenceIds.length) throw new Error('ambient-analysis-deferred')
  const sources = new Map(
    evidence
      .filter((entry) => consideredEvidenceIds.includes(entry.evidenceId))
      .map((entry) => [entry.evidenceId, entry])
  )
  const known = new Map(items.map((item) => [item.id, item]))
  const proposed = output.proposed.filter((candidate) => {
    if (!candidate || typeof candidate !== 'object') throw new Error('agent-invalid-response')
    const source = candidate.source as OpenTask['source'] | undefined
    return (
      source?.kind === 'task' &&
      supportsUserAction(candidate, sources.get(source.evidenceId ?? ''), userName) &&
      (!candidate.id || known.get(candidate.id)?.lifecycle === 'open')
    )
  })
  const changes = output.changes.filter((candidate) => {
    if (!candidate || typeof candidate !== 'object') throw new Error('agent-invalid-response')
    return (
      known.get(candidate.id)?.lifecycle === 'open' &&
      supportsUserAction(candidate, sources.get(candidate.evidenceId), userName)
    )
  })
  const parsed = parseDayMemory(JSON.stringify({ summary: '', openTasks: proposed, taskChanges: changes }))
  if (parsed.openTasks?.length !== proposed.length || parsed.taskChanges?.length !== changes.length) {
    throw new Error('agent-invalid-response')
  }
  return {
    consideredEvidenceIds,
    proposed: parsed.openTasks ?? [],
    changes: parsed.taskChanges ?? [],
    notifyTitles: proposed.flatMap((candidate, index) =>
      candidate.notify === true && !candidate.id ? [parsed.openTasks?.[index]?.title ?? ''] : []
    ),
  }
}
