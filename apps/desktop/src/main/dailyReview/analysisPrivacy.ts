import type { PersistedEpisodeAnalysis } from '@remember/shared'
import { selectAgentEvidence } from '../residentAgentPrivacy'
import type { AnalysisEvidenceEntry } from './analysisContext'

export function selectDayAnalysisEvidence(
  entries: AnalysisEvidenceEntry[],
  settings: Parameters<typeof selectAgentEvidence>[1]
) {
  return entries.flatMap((entry) => {
    // Empty capture rows carry no text to summarize; app-period evidence preserves application activity.
    if (entry.kind === 'screen-context' && !entry.text.trim()) return []
    const bundleId =
      entry.bundleId ??
      (entry.agentMessage?.provider === 'codex'
        ? 'com.openai.codex'
        : entry.agentMessage?.provider === 'claude'
          ? 'com.anthropic.claudefordesktop'
          : '')
    const selected = selectAgentEvidence(
      [
        {
          kind: entry.kind === 'transcript' ? 'speech' : 'context',
          text: entry.text,
          appName: entry.app,
          bundleId,
          windowTitle: entry.window,
          url: entry.url,
        },
      ],
      settings
    ).evidence[0]
    return selected
      ? [
          {
            ...entry,
            text: selected.text,
            ...(entry.window ? { window: selected.windowTitle } : {}),
            ...(entry.url ? { url: selected.url } : {}),
          },
        ]
      : []
  })
}

type AnalysisPrivacyInput = {
  allEvidence: AnalysisEvidenceEntry[]
  conversationSummaries: PersistedEpisodeAnalysis[] | null
  after: number | null
}

export function prepareAnalysisEvidence(input: AnalysisPrivacyInput) {
  const conversationEvidence: AnalysisEvidenceEntry[] = input.conversationSummaries
    ? input.conversationSummaries
        .filter((summary) => input.after == null || summary.endedAt > input.after)
        .map((summary) => ({
          timestamp: input.after == null ? summary.startedAt : Math.max(summary.startedAt, input.after + 1),
          endedAt: summary.endedAt,
          kind: 'transcript',
          source: 'episode-summary',
          text: JSON.stringify({
            episodeId: summary.episodeId ?? null,
            title: summary.title,
            description: summary.description,
            summary: summary.summary,
            actionPoints: summary.actionPoints,
          }),
        }))
    : input.allEvidence.filter(
        (entry) => entry.kind === 'transcript' && (input.after == null || entry.timestamp > input.after)
      )

  return [
    ...input.allEvidence.filter(
      (entry) =>
        entry.kind !== 'transcript' &&
        (input.after == null || (entry.agentMessage?.recordedAt ?? entry.timestamp) > input.after)
    ),
    ...conversationEvidence,
  ].sort((first, second) => first.timestamp - second.timestamp)
}
