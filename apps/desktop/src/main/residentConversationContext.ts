import type { AssistantMessage } from '@remember/shared'
import type { CodexClientTool } from './codexClientTools'
import type { ResidentAgentStore } from './residentAgentStore'
import { MAX_RESIDENT_REPLY_REFERENCES, type ResidentReplyReference, sameReplyReference } from './residentReplyContext'

// SQLite owns the conversation. Provider sessions must not retain a second,
// unfilterable copy of source-backed history after access changes.
export function createResidentConversationContext(dependencies: {
  store: ResidentAgentStore
  messageId: string
  permitted(message: AssistantMessage): boolean
  referencesPermitted(references: ResidentReplyReference[]): boolean
  assertCurrent(): void
  admit(references: ResidentReplyReference[]): void
}) {
  const userId = dependencies.store.get(dependencies.messageId)?.replyTo
  if (!userId) throw new Error('assistant-conversation-turn-invalid')
  const referencesFor = (message: AssistantMessage) => {
    if (!dependencies.permitted(dependencies.store.get(message.id) ?? message)) return null
    const decision = dependencies.store.proactiveDecision(message.id)
    const references =
      decision && decision.kind !== 'prepare'
        ? [
            {
              kind: 'initiative' as const,
              decisionId: decision.id,
              messageId: message.id,
              inputHash: decision.inputHash,
            },
          ]
        : dependencies.store.replyContext(message.id)
    return !references.length || dependencies.referencesPermitted(references) ? references : null
  }
  const entry = (message: AssistantMessage, text: string) => ({
    id: message.id,
    role: message.role,
    text,
    createdAt: message.createdAt,
    origin: dependencies.store.proactiveDecision(message.id) ? ('initiative' as const) : message.role,
    truncated: text.length !== message.text.length,
  })
  const bounded = (message: AssistantMessage, offset: number, budget: number) => {
    let text = message.text.slice(offset, offset + 8_000)
    while (JSON.stringify(entry(message, text)).length > budget && text.length)
      text = text.slice(0, Math.floor(text.length * 0.8))
    return entry(message, text)
  }
  const read = (before = dependencies.messageId) => {
    dependencies.assertCurrent()
    const rows = dependencies.store.history(false, {
      limit: 41,
      before,
      through: dependencies.messageId,
      excludeId: userId,
    })
    const candidates = rows.slice(-40)
    const messages: ReturnType<typeof entry>[] = []
    const references: ResidentReplyReference[] = []
    let remaining = 24_000
    let omitted = 0
    let processed = 0
    for (const message of [...candidates].reverse()) {
      if (remaining < 1_000) break
      processed++
      const lineage = message.status === 'completed' ? referencesFor(message) : null
      if (!lineage) {
        omitted++
        continue
      }
      const combined = [...dependencies.store.replyContext(dependencies.messageId), ...references, ...lineage].filter(
        (reference, index, all) => all.findIndex((other) => sameReplyReference(reference, other)) === index
      )
      if (combined.length > MAX_RESIDENT_REPLY_REFERENCES) {
        omitted++
        continue
      }
      const value = bounded(message, 0, remaining)
      remaining -= JSON.stringify(value).length
      messages.unshift(value)
      for (const reference of lineage)
        if (!references.some((existing) => sameReplyReference(existing, reference))) references.push(reference)
    }
    dependencies.admit(references)
    dependencies.assertCurrent()
    return {
      messages,
      nextBefore:
        rows.length > 40 || processed < candidates.length
          ? (candidates[candidates.length - processed]?.id ?? null)
          : null,
      omitted,
      meaning:
        'One continuing conversation, including initiatives actually shown to the user. Resolve follow-ups against these messages. User corrections take precedence over earlier assistant claims. History explains what was said; it is not proof of current task status, source facts or completed actions. Use tools when the request needs additional facts or a change. Unavailable source-backed messages are omitted. Truncated messages can be read by messageId and offset with remember_chat.',
    }
  }
  const tool: CodexClientTool = {
    name: 'remember_chat',
    description:
      'Read this same continuing agent conversation. Recent messages are already in context: do not read them again for an ordinary follow-up. Pass nextBefore as before to page backward, or messageId and a character offset to read a truncated message. Chat history is not a source archive or authorization to act. Source-revoked messages are omitted.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        before: { type: 'string', minLength: 1, maxLength: 200 },
        messageId: { type: 'string', minLength: 1, maxLength: 200 },
        offset: { type: 'integer', minimum: 0 },
      },
    },
    async call(raw, context) {
      context.signal.throwIfAborted()
      dependencies.assertCurrent()
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('assistant-history-request-invalid')
      const input = raw as Record<string, unknown>
      const id = input.before ?? input.messageId
      if (
        typeof id !== 'string' ||
        !id ||
        id.length > 200 ||
        Object.keys(input).some((key) => !['before', 'messageId', 'offset'].includes(key)) ||
        (input.before !== undefined && (input.messageId !== undefined || input.offset !== undefined)) ||
        (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || Number(input.offset) < 0)) ||
        (id !== dependencies.messageId &&
          !dependencies.store.isConversationHistoryMessage(id, dependencies.messageId)) ||
        (input.before === undefined && id === dependencies.messageId)
      )
        throw new Error('assistant-history-cursor-invalid')
      if (input.before !== undefined) return read(id)
      // Reuse the canonical history filter so retired execution results cannot be
      // bypassed by guessing a message ID from the visible UI.
      const older = dependencies.store.history(false, {
        limit: 1,
        through: dependencies.messageId,
        messageId: id,
        excludeId: userId,
      })[0]
      const lineage = older?.status === 'completed' ? referencesFor(older) : null
      if (!older || !lineage) return { available: false }
      const combined = [...dependencies.store.replyContext(dependencies.messageId), ...lineage].filter(
        (reference, index, all) => all.findIndex((other) => sameReplyReference(reference, other)) === index
      )
      if (combined.length > MAX_RESIDENT_REPLY_REFERENCES)
        return { available: false, reason: 'conversation-context-limit' }
      dependencies.admit(lineage)
      const offset = Number(input.offset ?? 0)
      if (offset > older.text.length) throw new Error('assistant-history-offset-invalid')
      const value = bounded(older, offset, 24_000)
      dependencies.assertCurrent()
      return {
        available: true,
        ...value,
        offset,
        nextOffset: offset + value.text.length < older.text.length ? offset + value.text.length : null,
      }
    },
  }
  return { read, tool }
}
