import type { WikiPageUpdate } from '@remember/shared'
import { createAgentError } from './agentErrors'

export const DAY_WIKI_EDITS_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', maxLength: 240 },
    edits: {
      type: 'array',
      maxItems: 24,
      items: {
        type: 'object',
        properties: {
          oldText: { type: 'string', minLength: 1 },
          newText: { type: 'string' },
        },
        required: ['oldText', 'newText'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'edits'],
  additionalProperties: false,
} as const

export function dayWikiManagedBody(content: string) {
  // Match the writer's supported metadata grammar, including externally edited
  // whitespace. Ambiguous ownership must not fall through as a new managed body.
  const markers = [...content.matchAll(/<!--[ \t]*remember-managed:(start|end)[ \t]*-->/g)]
  if (!markers.length && !/<!--[ \t]*remember-managed:/.test(content)) return null
  if (markers.length !== 2 || markers[0]?.[1] !== 'start' || markers[1]?.[1] !== 'end') {
    throw createAgentError('agent-invalid-response', 'Wiki managed region is malformed or ambiguous')
  }
  return content.slice(markers[0].index + markers[0][0].length, markers[1].index).trim()
}

/** Materialize edits against one original version; untouched text is never regenerated. */
export function materializeDayWikiEdits(candidate: WikiPageUpdate, currentBody: string, value: unknown) {
  const invalid = () =>
    createAgentError('agent-invalid-response', 'Wiki edits must match unique, non-overlapping passages')
  if (!value || typeof value !== 'object' || !('summary' in value) || !('edits' in value)) throw invalid()
  if (typeof value.summary !== 'string' || !Array.isArray(value.edits) || value.edits.length > 24) throw invalid()
  const edits = value.edits.map((edit: unknown) => {
    if (!edit || typeof edit !== 'object' || !('oldText' in edit) || !('newText' in edit)) throw invalid()
    if (typeof edit.oldText !== 'string' || !edit.oldText.trim() || typeof edit.newText !== 'string') throw invalid()
    if (/<!--\s*remember-/.test(edit.newText)) throw invalid()
    const start = currentBody.indexOf(edit.oldText)
    if (start < 0 || currentBody.indexOf(edit.oldText, start + 1) >= 0) throw invalid()
    return { start, end: start + edit.oldText.length, text: edit.newText }
  })
  edits.sort((first, second) => first.start - second.start)
  for (let index = 1; index < edits.length; index++) {
    if (edits[index]!.start < edits[index - 1]!.end) throw invalid()
  }
  let content = currentBody
  for (const edit of edits.toReversed()) content = content.slice(0, edit.start) + edit.text + content.slice(edit.end)
  if (content === currentBody) return null
  if (!content.trim() || !value.summary.trim()) throw invalid()
  return { ...candidate, content, summary: value.summary.trim(), changeType: 'updated' as const }
}
