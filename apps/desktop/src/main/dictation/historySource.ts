import type { DictationNote } from '@remember/shared'

export type DictationNoteSource = {
  note: DictationNote
  incarnation: string
  revision: number
  contentHash: string
  completedAt: number | null
}

export type DictationNoteTombstone = {
  incarnation: string
  revision: number
  deletedAt: number
}

export type DictationHistorySnapshot =
  | {
      state: 'available'
      epoch: string
      sequence: number
      notes: DictationNoteSource[]
      tombstones: Record<string, DictationNoteTombstone>
    }
  | { state: 'missing' }
  | { state: 'unavailable'; reason: 'not-ready' | 'invalid' | 'unreadable' }

let owner: { read: () => DictationHistorySnapshot } | null = null
const listeners = new Set<() => void>()

export function getDictationHistorySnapshot(): DictationHistorySnapshot {
  if (!owner) return { state: 'unavailable', reason: 'not-ready' }
  try {
    return structuredClone(owner.read())
  } catch {
    return { state: 'unavailable', reason: 'unreadable' }
  }
}

export function subscribeDictationHistoryChanges(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function registerDictationHistorySource(read: () => DictationHistorySnapshot): () => void {
  if (owner) throw new Error('dictation-history-owner-exists')
  const registered = { read }
  owner = registered
  publishDictationHistoryChange()
  return () => {
    if (owner !== registered) return
    owner = null
    publishDictationHistoryChange()
  }
}

export function publishDictationHistoryChange(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (cause) {
      console.error('[dictation] History observer failed', cause)
    }
  }
}
