import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { evaluateTranscriptionSegment, initialTranscriptionLanguageState } from './transcriptionLanguagePolicy'

describe('transcription language policy', () => {
  it('uses Dutch for supported or unspecified speech by default', () => {
    const dutch = evaluateTranscriptionSegment(initialTranscriptionLanguageState(), {
      detectedLanguage: 'nl',
      speechStartedAt: 1_000,
      speechDurationMs: 900,
    })
    const unspecified = evaluateTranscriptionSegment(dutch.state, {
      detectedLanguage: null,
      speechStartedAt: 2_000,
      speechDurationMs: 800,
    })

    assert.equal(dutch.accept, true)
    assert.equal(unspecified.accept, true)
    assert.equal(unspecified.language, 'nl')
  })

  it('rejects unsupported and short cross-language detections', () => {
    const unsupported = evaluateTranscriptionSegment(initialTranscriptionLanguageState(), {
      detectedLanguage: 'ja',
      speechStartedAt: 1_000,
      speechDurationMs: 2_000,
    })
    const shortEnglish = evaluateTranscriptionSegment(unsupported.state, {
      detectedLanguage: 'en',
      speechStartedAt: 4_000,
      speechDurationMs: 800,
    })

    assert.equal(unsupported.accept, false)
    assert.equal(unsupported.rejectionReason, 'unsupported-language')
    assert.equal(shortEnglish.accept, false)
    assert.equal(shortEnglish.rejectionReason, 'cross-language-short')
    assert.equal(shortEnglish.state.language, 'nl')
  })

  it('switches to English after sustained English speech', () => {
    const first = evaluateTranscriptionSegment(initialTranscriptionLanguageState(), {
      detectedLanguage: 'en',
      speechStartedAt: 1_000,
      speechDurationMs: 2_000,
    })
    const second = evaluateTranscriptionSegment(first.state, {
      detectedLanguage: 'en',
      speechStartedAt: 3_500,
      speechDurationMs: 2_000,
    })
    const shortFollowUp = evaluateTranscriptionSegment(second.state, {
      detectedLanguage: 'en',
      speechStartedAt: 6_000,
      speechDurationMs: 700,
    })

    assert.equal(first.accept, false)
    assert.equal(first.rejectionReason, 'cross-language-unconfirmed')
    assert.equal(first.state.language, 'nl')
    assert.equal(second.accept, true)
    assert.equal(second.state.language, 'en')
    assert.equal(shortFollowUp.accept, true)
  })

  it('uses the interface language as the reset default', () => {
    const english = initialTranscriptionLanguageState('en')
    const unspecified = evaluateTranscriptionSegment(english, {
      detectedLanguage: null,
      speechStartedAt: 1_000,
      speechDurationMs: 900,
    })

    assert.equal(unspecified.language, 'en')
    assert.equal(unspecified.state.defaultLanguage, 'en')
  })

  it('switches immediately for one substantial English turn', () => {
    const result = evaluateTranscriptionSegment(initialTranscriptionLanguageState(), {
      detectedLanguage: 'en',
      speechStartedAt: 1_000,
      speechDurationMs: 8_000,
    })

    assert.equal(result.accept, true)
    assert.equal(result.state.language, 'en')
  })

  it('returns to Dutch after a conversation gap', () => {
    const english = evaluateTranscriptionSegment(initialTranscriptionLanguageState(), {
      detectedLanguage: 'en',
      speechStartedAt: 1_000,
      speechDurationMs: 8_000,
    })
    const laterDutch = evaluateTranscriptionSegment(english.state, {
      detectedLanguage: 'nl',
      speechStartedAt: 130_000,
      speechDurationMs: 900,
    })

    assert.equal(english.state.language, 'en')
    assert.equal(laterDutch.accept, true)
    assert.equal(laterDutch.state.language, 'nl')
  })
})
