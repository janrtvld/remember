import { createHash } from 'node:crypto'
import type { AgentContextDocument } from './contextImportSources'

export type ContextSourceCheckpoint = { sourceKey: string; fingerprints: string[]; through: number }

export function contextContentFingerprint(content: string) {
  return createHash('sha256').update(content.normalize('NFKC').replace(/\s+/g, ' ').trim()).digest('hex')
}

function fragments(document: AgentContextDocument) {
  if (document.kind === 'session') return document.messages ?? []
  return document.content
    .split(/\n\s*\n/)
    .filter(Boolean)
    .map((content) => ({ content, observedAt: null }))
}

export function contextSourceKey(document: AgentContextDocument) {
  return `${document.provider}:${document.kind}:${document.sourceId}`
}

export function contextSourceCheckpoints(documents: AgentContextDocument[], through: number) {
  return documents.map((document) => ({
    sourceKey: contextSourceKey(document),
    fingerprints: fragments(document).map((fragment) => contextContentFingerprint(fragment.content)),
    through,
  }))
}

export function prepareContextDocumentChanges(
  documents: AgentContextDocument[],
  after: number,
  through: number,
  previous: ContextSourceCheckpoint[]
) {
  const known = new Map(previous.map((checkpoint) => [checkpoint.sourceKey, checkpoint]))
  const baselines: ContextSourceCheckpoint[] = []
  const checkpoints: ContextSourceCheckpoint[] = []
  const changes: AgentContextDocument[] = []
  for (const document of documents) {
    if (document.updatedAt > through) continue
    const sourceKey = contextSourceKey(document)
    const parts = fragments(document)
    let baseline = known.get(sourceKey)
    if (!baseline) {
      // On upgrade/discovery, undated material is a baseline, never new evidence.
      baseline = {
        sourceKey,
        through: after,
        fingerprints: parts
          .filter((part) => part.observedAt === null || part.observedAt <= after)
          .map((part) => contextContentFingerprint(part.content)),
      }
      baselines.push(baseline)
    }
    if (baseline.through >= through) continue
    const seen = new Set(baseline.fingerprints)
    const added = parts.filter((part) => {
      if (seen.has(contextContentFingerprint(part.content))) return false
      return document.kind !== 'session'
        ? document.updatedAt > baseline.through
        : part.observedAt !== null && part.observedAt > baseline.through && part.observedAt <= through
    })
    checkpoints.push({
      sourceKey,
      through,
      // Keep seen passages even if removed, so an old excerpt returning is not a new fact.
      fingerprints: [...new Set([...seen, ...parts.map((part) => contextContentFingerprint(part.content))])],
    })
    if (!added.length) continue
    changes.push({
      ...document,
      content: added.map((part) => part.content).join('\n\n'),
      messages: added.map((part) => ({ ...part, observedAt: part.observedAt ?? document.updatedAt })),
    })
  }
  return { documents: changes, baselines, checkpoints }
}
