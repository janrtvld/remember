import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isLikelyTranscriptionHallucination } from './transcriptionQuality'

describe('transcription quality', () => {
  it('rejects common silence completions and degenerate repetition', () => {
    assert.equal(isLikelyTranscriptionHallucination('Thanks for watching.'), true)
    assert.equal(isLikelyTranscriptionHallucination('ja ja ja ja ja ja ja ja'), true)
    assert.equal(isLikelyTranscriptionHallucination('we need to review the proposal tomorrow'), false)
  })
})
