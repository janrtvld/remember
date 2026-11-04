import assert from 'node:assert/strict'
import test from 'node:test'
import { codexInfrastructureFailure, normalizeAgentTurnInput } from '../agentTurnInput'

test('normalizes a supported inline agent turn', () => {
  assert.deepEqual(
    normalizeAgentTurnInput({
      turnId: ' turn-1 ',
      workItemId: ' item-1 ',
      provider: 'codex',
      prompt: '  Help with this task.  ',
    }),
    {
      turnId: 'turn-1',
      workItemId: 'item-1',
      provider: 'codex',
      prompt: 'Help with this task.',
    }
  )
})

test('rejects empty, oversized, and unknown agent turns', () => {
  assert.equal(normalizeAgentTurnInput({ turnId: 'turn-1', provider: 'codex', prompt: '   ' }), null)
  assert.equal(normalizeAgentTurnInput({ turnId: 'turn-1', provider: 'other', prompt: 'Help.' }), null)
  assert.equal(normalizeAgentTurnInput({ turnId: 'turn-1', provider: 'claude', prompt: 'x'.repeat(100_001) }), null)
  assert.equal(normalizeAgentTurnInput({ provider: 'codex', prompt: 'Help.' }), null)
})

test('recognizes a missing Codex workspace host as infrastructure failure', () => {
  assert.equal(codexInfrastructureFailure('Failed to spawn codex-code-mode-host: No such file or directory'), true)
  assert.equal(codexInfrastructureFailure('I could not find the requested application file.'), false)
})
