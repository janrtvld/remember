import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AssistantConversation, AssistantMessage } from '@remember/shared'
import { reconcileAssistantConversation } from './assistantConversation'

function message(id: string, text = id): AssistantMessage {
  return {
    id,
    text,
    role: 'assistant',
    provider: 'codex',
    createdAt: 1,
    updatedAt: 1,
    status: 'completed',
    replyTo: null,
    error: null,
    steps: [],
    results: [],
  }
}
function conversation(messages: AssistantMessage[]): AssistantConversation {
  return { messages, activeTurnId: null, hasEarlier: false, execution: 'local' }
}

test('streaming snapshots retain cached history while accepting source redaction without a timestamp change', () => {
  const previous = conversation(Array.from({ length: 40 }, (_, i) => message(String(i))))
  const next = structuredClone(previous)
  next.messages[39] = { ...message('39'), text: 'New words', status: 'streaming' }
  const merged = reconcileAssistantConversation(previous, next)
  assert.equal(merged.messages.filter((entry, i) => entry === previous.messages[i]).length, 39)
  assert.equal(merged.messages[39]?.text, 'New words')
  const redacted = structuredClone(next)
  redacted.messages[0] = { ...message('0'), text: '', error: 'assistant-proactive-source-unavailable' }
  const refreshed = reconcileAssistantConversation(merged, redacted)
  assert.equal(refreshed.messages[0]?.text, '')
  assert.equal(refreshed.messages[0]?.error, 'assistant-proactive-source-unavailable')
})

test('live updates preserve loaded earlier pages and empty snapshots clear the conversation', () => {
  const previous = conversation([message('older'), message('latest')])
  const next = reconcileAssistantConversation(previous, conversation([message('latest'), message('reply')]))
  assert.deepEqual(
    next.messages.map((entry) => entry.id),
    ['older', 'latest', 'reply']
  )
  assert.equal(next.messages[0], previous.messages[0])
  assert.equal(reconcileAssistantConversation(next, conversation([])).messages.length, 0)
})
