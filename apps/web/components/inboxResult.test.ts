import assert from 'node:assert/strict'
import test from 'node:test'
import { parseInboxResult } from '@remember/shared'

test('separates durable evidence from a bounded task update', () => {
  const update = {
    summary: 'Prepared the agenda',
    remaining: 'Human discussion',
    nextStep: 'Discuss options',
    needsUser: true,
  }
  assert.deepEqual(
    parseInboxResult(`## Agenda\nEvidence retained.\n\n\`\`\`remember-task-update\n${JSON.stringify(update)}\n\`\`\``),
    {
      response: '## Agenda\nEvidence retained.',
      update,
    }
  )
})

test('preserves legacy and malformed responses without changing task state', () => {
  for (const response of [
    'Legacy result',
    'Evidence\n```remember-task-update\n{}\n```',
    '```remember-task-update\n{"summary":"Done","remaining":"","nextStep":"","needsUser":false}\n```',
  ]) {
    assert.deepEqual(parseInboxResult(response), { response, update: null })
  }
})
