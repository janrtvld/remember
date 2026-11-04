import type { AgentProvider } from '@remember/shared'

export interface LocalAssistantSubmission {
  id: string
  text: string
  provider: AgentProvider
  mode?: 'question' | 'command'
  createdAt: number
  queued: boolean
  failed: boolean
}

export interface AssistantSession {
  draft: string
  scopedDrafts?: Record<string, string>
  queueEdit?: { id: string; text: string }
  submissions: LocalAssistantSubmission[]
}

export const ASSISTANT_OUTBOX_LIMIT = 10

const MAX_MESSAGE_LENGTH = 20_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function storageKey() {
  return 'remember:assistant-session:v1'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isSubmission(value: unknown): value is LocalAssistantSubmission {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    UUID.test(value.id) &&
    typeof value.text === 'string' &&
    value.text.trim().length > 0 &&
    value.text.length <= MAX_MESSAGE_LENGTH &&
    (value.provider === 'codex' || value.provider === 'claude') &&
    (value.mode === undefined || value.mode === 'question' || value.mode === 'command') &&
    typeof value.createdAt === 'number' &&
    Number.isFinite(value.createdAt) &&
    value.createdAt >= 0 &&
    typeof value.queued === 'boolean' &&
    typeof value.failed === 'boolean'
  )
}

function isSession(value: unknown): value is AssistantSession {
  return (
    isRecord(value) &&
    typeof value.draft === 'string' &&
    value.draft.length <= MAX_MESSAGE_LENGTH &&
    (value.scopedDrafts === undefined ||
      (isRecord(value.scopedDrafts) &&
        Object.entries(value.scopedDrafts).every(
          ([scope, draft]) =>
            scope.length > 0 &&
            scope.length <= MAX_MESSAGE_LENGTH + 10 &&
            !['__proto__', 'constructor', 'prototype'].includes(scope) &&
            typeof draft === 'string' &&
            draft.length <= MAX_MESSAGE_LENGTH
        ))) &&
    (value.queueEdit === undefined ||
      (isRecord(value.queueEdit) &&
        typeof value.queueEdit.id === 'string' &&
        UUID.test(value.queueEdit.id) &&
        typeof value.queueEdit.text === 'string' &&
        value.queueEdit.text.trim().length > 0 &&
        value.queueEdit.text.length <= MAX_MESSAGE_LENGTH)) &&
    Array.isArray(value.submissions) &&
    value.submissions.length <= ASSISTANT_OUTBOX_LIMIT &&
    value.submissions.every(isSubmission) &&
    new Set(value.submissions.map((submission) => submission.id.toLowerCase())).size === value.submissions.length
  )
}

function copyDrafts(session: AssistantSession) {
  return {
    draft: session.draft,
    ...(session.scopedDrafts === undefined ? {} : { scopedDrafts: { ...session.scopedDrafts } }),
    ...(session.queueEdit === undefined
      ? {}
      : { queueEdit: { id: session.queueEdit.id, text: session.queueEdit.text } }),
  }
}

function copySubmission(submission: LocalAssistantSubmission): LocalAssistantSubmission {
  return {
    id: submission.id,
    text: submission.text,
    provider: submission.provider,
    ...(submission.mode === undefined ? {} : { mode: submission.mode }),
    createdAt: submission.createdAt,
    queued: submission.queued,
    failed: submission.failed,
  }
}

export function restoreAssistantSessionDraft(
  session: AssistantSession,
  message: { id: string; text: string }
): { session: AssistantSession; prompt?: string } {
  const { queueEdit, ...current } = session
  const combined =
    !session.draft || session.draft === message.text ? message.text : `${session.draft}\n\n${message.text}`
  const restored: AssistantSession = {
    ...current,
    submissions: session.submissions.filter((entry) => entry.id !== message.id),
    ...(queueEdit && queueEdit.id !== message.id ? { queueEdit } : {}),
  }
  if (combined.length <= MAX_MESSAGE_LENGTH) return { session: { ...restored, draft: combined } }
  const scopedDrafts = { ...session.scopedDrafts }
  let prompt = message.id
  let suffix = 0
  while (scopedDrafts[`prompt:${prompt}`] && scopedDrafts[`prompt:${prompt}`] !== message.text)
    prompt = `${message.id}-${++suffix}`
  scopedDrafts[`prompt:${prompt}`] = message.text
  return { session: { ...restored, scopedDrafts }, prompt }
}

/** Returns null when storage cannot be trusted or read; existing bytes are left intact. */
export function readAssistantSession(): AssistantSession | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.sessionStorage.getItem(storageKey())
    if (raw === null) return { draft: '', submissions: [] }
    const stored: unknown = JSON.parse(raw)
    if (!isRecord(stored) || stored.version !== 1 || !isSession(stored)) return null
    return {
      ...copyDrafts(stored),
      // Reload cannot establish whether the server accepted a pending message.
      submissions: stored.submissions.map((submission) => ({ ...copySubmission(submission), failed: true })),
    }
  } catch {
    return null
  }
}

/** A failed save never truncates text or evicts unresolved submissions. */
export function writeAssistantSession(session: AssistantSession): boolean {
  if (typeof window === 'undefined' || !isSession(session)) return false
  try {
    const key = storageKey()
    if (
      !session.draft &&
      !session.submissions.length &&
      !Object.keys(session.scopedDrafts ?? {}).length &&
      !session.queueEdit
    )
      window.sessionStorage.removeItem(key)
    else
      window.sessionStorage.setItem(
        key,
        JSON.stringify({ version: 1, ...copyDrafts(session), submissions: session.submissions.map(copySubmission) })
      )
    return true
  } catch {
    return false
  }
}
