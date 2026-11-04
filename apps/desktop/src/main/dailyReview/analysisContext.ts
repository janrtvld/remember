import type { AgentProvider } from '@remember/shared'

export type AnalysisEvidenceEntry = {
  evidenceId?: string
  timestamp: number
  kind: 'app-period' | 'screen-context' | 'transcript' | 'agent-message'
  app?: string
  bundleId?: string
  window?: string
  url?: string
  focusedElement?: { role: string; title: string; description: string; value: string }
  source?: string
  agentMessage?: {
    provider: AgentProvider
    sessionId: string
    eventId: string
    recordedAt: number
    role: 'user' | 'assistant'
    projectPath: string | null
    partIndex: number
    partCount: number
  }
  endedAt?: number | null
  text: string
}

export type AnalysisEvidenceShard = {
  startedAt: number
  endedAt: number
  entries: AnalysisEvidenceEntry[]
}

const FULL_CONTEXT_CHECKPOINT_MS = 15 * 60_000

function normalizedLines(text: string) {
  return Array.from(
    new Set(
      text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    )
  )
}

/**
 * Accessibility snapshots repeat most of a window whenever one control
 * changes. Keep the first/full checkpoint and every newly visible line while
 * preserving app periods and transcripts verbatim.
 */
export function compactContextEvidence(evidence: AnalysisEvidenceEntry[]) {
  const previousByWindow = new Map<string, { lines: Set<string>; lastFullAt: number }>()
  const compacted: AnalysisEvidenceEntry[] = []

  for (const entry of [...evidence].sort((first, second) => first.timestamp - second.timestamp)) {
    if (entry.kind !== 'screen-context') {
      compacted.push(entry)
      continue
    }

    const lines = normalizedLines(entry.text)
    const key = `${entry.app ?? ''}\u0000${entry.window ?? ''}`
    const previous = previousByWindow.get(key)
    const needsCheckpoint = !previous || entry.timestamp - previous.lastFullAt >= FULL_CONTEXT_CHECKPOINT_MS
    if (needsCheckpoint) {
      compacted.push(entry)
      previousByWindow.set(key, { lines: new Set(lines), lastFullAt: entry.timestamp })
      continue
    }

    const addedLines = lines.filter((line) => !previous.lines.has(line))
    previousByWindow.set(key, { lines: new Set(lines), lastFullAt: previous.lastFullAt })
    if (addedLines.length === 0) continue
    compacted.push({
      ...entry,
      source: [entry.source, 'newly visible text'].filter(Boolean).join(', '),
      text: addedLines.join('\n'),
    })
  }

  return compacted
}

function entryParts(entry: AnalysisEvidenceEntry, maxCharacters: number) {
  if (JSON.stringify(entry).length <= maxCharacters) return [entry]

  const emptyTextCharacters = JSON.stringify({ ...entry, text: '' }).length
  const textCharactersPerPart = Math.max(1, maxCharacters - emptyTextCharacters - 80)
  const partCount = Math.ceil(entry.text.length / textCharactersPerPart)

  return Array.from({ length: partCount }, (_, index) => ({
    ...entry,
    text: entry.text.slice(index * textCharactersPerPart, (index + 1) * textCharactersPerPart),
    source: [entry.source, `part ${index + 1}/${partCount}`].filter(Boolean).join(', '),
  }))
}

function partitionWindow(entries: AnalysisEvidenceEntry[], maxCharacters: number) {
  const shards: AnalysisEvidenceShard[] = []
  let current: AnalysisEvidenceEntry[] = []
  let characters = 2

  const flush = () => {
    const first = current[0]
    const last = current.at(-1)
    if (!first || !last) return
    shards.push({ startedAt: first.timestamp, endedAt: last.timestamp, entries: current })
    current = []
    characters = 2
  }

  for (const entry of entries.flatMap((candidate) => entryParts(candidate, maxCharacters))) {
    const entryCharacters = JSON.stringify(entry).length
    if (current.length > 0 && characters + 1 + entryCharacters > maxCharacters) flush()
    characters += entryCharacters + (current.length > 0 ? 1 : 0)
    current.push(entry)
  }
  flush()
  return shards
}

export function partitionEvidence(
  evidence: AnalysisEvidenceEntry[],
  options: { maxCharacters: number; timeWindowMs: number }
) {
  const sorted = [...evidence].sort((first, second) => first.timestamp - second.timestamp)
  if (sorted.length === 0) return []

  const firstTimestamp = sorted[0]?.timestamp ?? 0
  const windows = new Map<number, AnalysisEvidenceEntry[]>()
  for (const entry of sorted) {
    const windowIndex = Math.floor((entry.timestamp - firstTimestamp) / options.timeWindowMs)
    const window = windows.get(windowIndex) ?? []
    window.push(entry)
    windows.set(windowIndex, window)
  }

  return Array.from(windows.values()).flatMap((entries) => partitionWindow(entries, options.maxCharacters))
}
