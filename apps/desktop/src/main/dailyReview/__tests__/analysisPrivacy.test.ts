import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PersistedEpisodeAnalysis } from '@remember/shared'
import { DEFAULT_SETTINGS } from '../../settingsStore'
import type { AnalysisEvidenceEntry } from '../analysisContext'
import { prepareAnalysisEvidence, selectDayAnalysisEvidence } from '../analysisPrivacy'
import { wikiSuggestionSources } from '../wikiSuggestionPolicy'

const rawEvidence: AnalysisEvidenceEntry[] = [
  { timestamp: 100, endedAt: 150, kind: 'transcript', source: 'microphone', text: 'private raw words' },
  { timestamp: 110, endedAt: 110, kind: 'screen-context', source: 'Mail', text: 'private screen text' },
  { timestamp: 120, endedAt: 120, kind: 'app-period', source: 'Mail', text: 'Mail was active' },
]

const episodeSummary: PersistedEpisodeAnalysis = {
  id: 'summary-1',
  episodeId: 'episode-1',
  workdayId: 'day-1',
  startedAt: 100,
  endedAt: 150,
  title: 'Planning',
  description: 'A short planning conversation',
  summary: 'They agreed to revisit the plan.',
  actionPoints: [],
  sourceHash: 'hash',
  provider: 'codex',
  model: 'gpt-5.6-terra',
  promptVersion: 1,
  schemaVersion: 1,
  generatedAt: 200,
  classification: 'conversation',
  confidence: 'high',
  reason: 'Reciprocal exchange.',
}

describe('Day analysis privacy boundary', () => {
  it('omits empty screen captures before collecting source references while retaining app-period activity', () => {
    const entries: AnalysisEvidenceEntry[] = [
      {
        evidenceId: 'empty',
        timestamp: 100,
        kind: 'screen-context',
        app: 'Mail',
        bundleId: 'com.apple.mail',
        window: 'Inbox',
        text: '  ',
      },
      {
        evidenceId: 'app:mail-focus',
        timestamp: 100,
        endedAt: null,
        kind: 'app-period',
        app: 'Mail',
        bundleId: 'com.apple.mail',
        text: '',
      },
      {
        evidenceId: 'message',
        timestamp: 110,
        kind: 'screen-context',
        app: 'Mail',
        bundleId: 'com.apple.mail',
        window: 'Inbox',
        text: 'Review the application draft.',
      },
    ]
    const admitted = selectDayAnalysisEvidence(entries, DEFAULT_SETTINGS)
    assert.deepEqual(
      admitted.map((entry) => entry.evidenceId),
      ['app:mail-focus', 'message']
    )
    assert.equal(admitted[0]?.text, '')
    assert.equal(admitted[0]?.bundleId, 'com.apple.mail')
  })
  it('sends episode summaries instead of raw conversation text to a Day provider', () => {
    const evidence = prepareAnalysisEvidence({
      allEvidence: rawEvidence,
      conversationSummaries: [episodeSummary],
      after: null,
    })

    assert.equal(
      evidence.some((entry) => entry.text.includes('private raw words')),
      false
    )
    assert.equal(
      evidence.some((entry) => entry.source === 'episode-summary'),
      true
    )
  })

  it('does not leak provisional raw speech when no episode is finalized yet', () => {
    const evidence = prepareAnalysisEvidence({ allEvidence: rawEvidence, conversationSummaries: [], after: null })

    assert.equal(
      evidence.some((entry) => entry.kind === 'transcript'),
      false
    )
  })

  it('retains screen text for Day analysis', () => {
    const evidence = prepareAnalysisEvidence({
      allEvidence: rawEvidence,
      conversationSummaries: [episodeSummary],
      after: null,
    })

    assert.equal(
      evidence.some((entry) => entry.kind === 'screen-context'),
      true
    )
  })

  it('keeps a newly completed conversation eligible for Wiki maintenance during end-of-day replay', () => {
    const fresh = prepareAnalysisEvidence({ allEvidence: [], conversationSummaries: [episodeSummary], after: 125 })
    assert.equal(wikiSuggestionSources(fresh, [], 125, 200).length, 1)
    const alreadyProcessed = prepareAnalysisEvidence({
      allEvidence: [],
      conversationSummaries: [episodeSummary],
      after: 150,
    })
    assert.deepEqual(wikiSuggestionSources(alreadyProcessed, [], 150, 200), [])
  })
})
