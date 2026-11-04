import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { DailyReviewMoment } from '@remember/shared'
import { parseConversationClassification, parseConversationSummary } from '../conversationAnalysis'

const microphoneMoment: DailyReviewMoment = {
  id: 'microphone-1',
  sessionId: 'day-1',
  source: 'microphone',
  startedAt: 100,
  durationMs: 1_000,
  status: 'ready',
  transcript: 'Ik ga het voorstel vanmiddag testen.',
}

function summaryOutput(actionPoints: Array<{ text: string; evidenceQuote: string }>) {
  return JSON.stringify({
    title: 'Voorstel testen',
    description: 'Een korte bespreking.',
    summary: 'Het voorstel wordt vanmiddag getest.',
    actionPoints,
  })
}

describe('conversation analysis output', () => {
  it('accepts only the explicit classification contract', () => {
    assert.deepEqual(
      parseConversationClassification(
        JSON.stringify({ classification: 'media', confidence: 'high', reason: 'Video narration.' })
      ),
      { classification: 'media', confidence: 'high', reason: 'Video narration.' }
    )
    assert.throws(
      () => parseConversationClassification(JSON.stringify({ classification: 'conversation' })),
      /agent-invalid-response/
    )
  })

  it('keeps only action points backed by an explicit first-person microphone quote', () => {
    const parsed = parseConversationSummary(
      summaryOutput([
        { text: 'Test het voorstel vanmiddag.', evidenceQuote: 'Ik ga het voorstel vanmiddag testen.' },
        { text: 'Maak een benchmarkrapport.', evidenceQuote: 'Noteer de resultaten in een rapport.' },
      ]),
      [microphoneMoment]
    )

    assert.deepEqual(parsed.actionPoints, ['Test het voorstel vanmiddag.'])
  })

  it('rejects another participant’s commitment from system audio', () => {
    const parsed = parseConversationSummary(
      summaryOutput([{ text: 'Test het voorstel.', evidenceQuote: 'Ik test het voorstel vanmiddag.' }]),
      [{ ...microphoneMoment, source: 'system' }]
    )

    assert.deepEqual(parsed.actionPoints, [])
  })

  it('rejects hedged suggestions as personal action points', () => {
    const transcript = 'Ik ga misschien het voorstel vanmiddag testen.'
    const parsed = parseConversationSummary(
      summaryOutput([{ text: 'Maybe test het voorstel.', evidenceQuote: transcript }]),
      [{ ...microphoneMoment, transcript }]
    )

    assert.deepEqual(parsed.actionPoints, [])
  })
})
