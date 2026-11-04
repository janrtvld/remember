import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DictationNote } from '@remember/shared'
import type { DictationHistorySnapshot, DictationNoteTombstone } from './historySource'

type SourceEntry = {
  incarnation: string
  revision: number
  contentHash: string
  completedAt: number | null
}

type SourceState = {
  version: 1
  epoch: string
  sequence: number
  entries: Record<string, SourceEntry>
  tombstones: Record<string, DictationNoteTombstone>
}

type HistoryFile = { version: 1; notes: DictationNote[]; sourceState: SourceState }
type HistoryOptions = { now?: () => number; newId?: () => string }
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const validId = (id: unknown): id is string => id === 'legacy' || uuid(id)
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const time = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const counter = (value: unknown, minimum = 0): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))

function contentHash(note: DictationNote) {
  return createHash('sha256')
    .update(
      JSON.stringify([note.id, note.createdAt, note.durationMs, note.text, note.status, note.error, note.hasAudio])
    )
    .digest('hex')
}

function validNote(value: unknown): value is DictationNote {
  return (
    record(value) &&
    validId(value.id) &&
    time(value.createdAt) &&
    time(value.durationMs) &&
    typeof value.text === 'string' &&
    typeof value.status === 'string' &&
    ['processing', 'completed', 'failed'].includes(value.status) &&
    typeof value.hasAudio === 'boolean' &&
    (value.error === null ||
      (typeof value.error === 'string' &&
        ['interrupted', 'microphone', 'recording', 'transcription', 'no-speech', 'model-required', 'download'].includes(
          value.error
        )))
  )
}

function parseHistory(raw: string, allowLegacy: boolean): { notes: DictationNote[]; sourceState?: SourceState } {
  let saved: unknown
  try {
    saved = JSON.parse(raw)
  } catch {
    throw new Error('invalid-dictation-history')
  }
  if (
    !record(saved) ||
    saved.version !== 1 ||
    !Array.isArray(saved.notes) ||
    !saved.notes.every(validNote) ||
    new Set(saved.notes.map((note) => note.id)).size !== saved.notes.length
  )
    throw new Error('invalid-dictation-history')
  const notes: DictationNote[] = saved.notes
  if (!Object.hasOwn(saved, 'sourceState') && allowLegacy) return { notes }
  const state = saved.sourceState
  if (
    !record(state) ||
    !exactKeys(state, ['version', 'epoch', 'sequence', 'entries', 'tombstones']) ||
    state.version !== 1 ||
    !uuid(state.epoch) ||
    !counter(state.sequence) ||
    !record(state.entries) ||
    !record(state.tombstones) ||
    Object.keys(state.entries).length !== notes.length
  )
    throw new Error('invalid-dictation-history')
  for (const note of notes) {
    const entry = state.entries[note.id]
    if (
      !record(entry) ||
      !exactKeys(entry, ['incarnation', 'revision', 'contentHash', 'completedAt']) ||
      !uuid(entry.incarnation) ||
      !counter(entry.revision, 1) ||
      entry.contentHash !== contentHash(note) ||
      !(entry.completedAt === null || time(entry.completedAt)) ||
      (note.status !== 'completed' && entry.completedAt !== null)
    )
      throw new Error('invalid-dictation-history')
  }
  for (const [id, tombstone] of Object.entries(state.tombstones)) {
    if (
      !validId(id) ||
      !record(tombstone) ||
      !exactKeys(tombstone, ['incarnation', 'revision', 'deletedAt']) ||
      !uuid(tombstone.incarnation) ||
      !counter(tombstone.revision, 1) ||
      !time(tombstone.deletedAt) ||
      (state.entries[id] as SourceEntry | undefined)?.incarnation === tombstone.incarnation
    )
      throw new Error('invalid-dictation-history')
  }
  return { notes, sourceState: state as SourceState }
}

function nextCounter(value: number) {
  if (!counter(value + 1, 1)) throw new Error('dictation-history-revision-overflow')
  return value + 1
}

export function createDictationHistory(directory: string, options: HistoryOptions = {}) {
  const file = join(directory, 'history.json')
  const audioDirectory = join(directory, 'notes')
  const listeners = new Set<() => void>()
  let initialized = false

  function timestamp() {
    const value = (options.now ?? Date.now)()
    if (!time(value)) throw new Error('invalid-dictation-history-time')
    return value
  }

  function persist(next: HistoryFile) {
    mkdirSync(directory, { recursive: true })
    writeFileSync(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (cause) {
        console.error('[dictation] History observer failed', cause)
      }
    }
  }

  function audioFile(id: string) {
    if (!validId(id)) throw new Error('invalid-dictation-note')
    return join(audioDirectory, `${id}.wav`)
  }

  function read(allowLegacy = false) {
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('dictation-history-missing')
      throw cause
    }
    return parseHistory(raw, allowLegacy)
  }

  function historicalState(notes: DictationNote[]): SourceState {
    return {
      version: 1,
      epoch: randomUUID(),
      sequence: 0,
      entries: Object.fromEntries(
        notes.map((note) => [
          note.id,
          {
            incarnation: randomUUID(),
            revision: 1,
            contentHash: contentHash(note),
            completedAt: null,
          },
        ])
      ),
      tombstones: {},
    }
  }

  function changedNotes(current: HistoryFile, next: DictationNote[]) {
    const sourceState = structuredClone(current.sourceState)
    let changed = false
    for (const note of next) {
      if (!validNote(note)) throw new Error('invalid-dictation-note')
      const previous = current.notes.find((entry) => entry.id === note.id)
      const entry = sourceState.entries[note.id]
      const hash = contentHash(note)
      if (!entry || !previous) throw new Error('dictation-note-not-found')
      if (hash === entry.contentHash) continue
      changed = true
      entry.revision = nextCounter(entry.revision)
      entry.contentHash = hash
      entry.completedAt =
        note.status === 'completed' ? (previous.status === 'completed' ? entry.completedAt : timestamp()) : null
    }
    if (!changed) return null
    sourceState.sequence = nextCounter(sourceState.sequence)
    return { version: 1 as const, notes: next, sourceState }
  }

  function initialize(input: { hasPriorNoteSources?: boolean } = {}) {
    if (initialized) return
    initialized = true
    if (existsSync(file)) {
      const saved = read(true)
      const current: HistoryFile = {
        version: 1,
        notes: saved.notes,
        sourceState: saved.sourceState ?? historicalState(saved.notes),
      }
      const recovered = current.notes.map((note) => ({
        ...note,
        hasAudio: note.hasAudio && existsSync(audioFile(note.id)),
        ...(note.status === 'processing' ? { status: 'failed' as const, error: 'interrupted' as const } : {}),
      }))
      const changed = changedNotes(current, recovered)
      if (changed || !saved.sourceState) persist(changed ?? current)
      return
    }
    if (input.hasPriorNoteSources) throw new Error('dictation-history-missing')
    const previousFile = join(directory, 'last-result.json')
    const previousAudio = join(directory, 'last-recording.wav')
    const imported: DictationNote[] = []
    if (existsSync(previousFile)) {
      const saved = JSON.parse(readFileSync(previousFile, 'utf8')) as { text?: string; pending?: boolean }
      const text = typeof saved.text === 'string' ? saved.text : ''
      const hasAudio = existsSync(previousAudio)
      if (text || (saved.pending && hasAudio)) {
        if (hasAudio) {
          mkdirSync(audioDirectory, { recursive: true })
          writeFileSync(audioFile('legacy'), readFileSync(previousAudio), { mode: 0o600 })
        }
        imported.push({
          id: 'legacy',
          createdAt: statSync(previousFile).mtimeMs,
          durationMs: 0,
          text,
          status: saved.pending ? 'failed' : 'completed',
          error: saved.pending ? 'interrupted' : null,
          hasAudio,
        })
      }
    }
    persist({ version: 1, notes: imported, sourceState: historicalState(imported) })
  }

  function current(): HistoryFile {
    initialize()
    const saved = read()
    if (!saved.sourceState) throw new Error('invalid-dictation-history')
    return { version: 1, notes: saved.notes, sourceState: saved.sourceState }
  }

  function snapshot(): DictationHistorySnapshot {
    if (!initialized) return { state: 'unavailable', reason: 'not-ready' }
    try {
      const saved = current()
      return {
        state: 'available',
        epoch: saved.sourceState.epoch,
        sequence: saved.sourceState.sequence,
        notes: saved.notes.map((note) => {
          const entry = saved.sourceState.entries[note.id]
          if (!entry) throw new Error('invalid-dictation-history')
          return { note, ...entry }
        }),
        tombstones: saved.sourceState.tombstones,
      }
    } catch (cause) {
      const message = (cause as Error).message
      if (message === 'dictation-history-missing') return { state: 'missing' }
      return { state: 'unavailable', reason: message === 'invalid-dictation-history' ? 'invalid' : 'unreadable' }
    }
  }

  function find(id: string) {
    if (!validId(id)) throw new Error('invalid-dictation-note')
    return current().notes.find((note) => note.id === id)
  }

  return {
    initialize,
    snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    list: () => current().notes,
    find,
    add: (audio: Buffer, createdAt: number, durationMs: number) => {
      const saved = current()
      const note: DictationNote = {
        id: (options.newId ?? randomUUID)(),
        createdAt,
        durationMs,
        text: '',
        status: 'processing',
        error: null,
        hasAudio: true,
      }
      if (!validNote(note)) throw new Error('invalid-dictation-note')
      if (saved.sourceState.entries[note.id]) throw new Error('dictation-note-exists')
      saved.sourceState.sequence = nextCounter(saved.sourceState.sequence)
      saved.sourceState.entries[note.id] = {
        incarnation: randomUUID(),
        revision: 1,
        contentHash: contentHash(note),
        completedAt: null,
      }
      mkdirSync(audioDirectory, { recursive: true })
      writeFileSync(audioFile(note.id), audio, { mode: 0o600 })
      persist({ ...saved, notes: [note, ...saved.notes] })
      return { ...note }
    },
    update: (id: string, patch: Partial<Pick<DictationNote, 'text' | 'status' | 'error'>>) => {
      if (!validId(id)) throw new Error('invalid-dictation-note')
      if (!record(patch) || Object.keys(patch).some((key) => !['text', 'status', 'error'].includes(key)))
        throw new Error('invalid-dictation-note')
      const saved = current()
      if (!saved.sourceState.entries[id]) throw new Error('dictation-note-not-found')
      const changed = changedNotes(
        saved,
        saved.notes.map((note) => (note.id === id ? { ...note, ...patch } : note))
      )
      if (changed) persist(changed)
    },
    remove: (id: string) => {
      if (!validId(id)) throw new Error('invalid-dictation-note')
      const saved = current()
      const entry = saved.sourceState.entries[id]
      if (!entry) return
      saved.sourceState.sequence = nextCounter(saved.sourceState.sequence)
      saved.sourceState.tombstones[id] = {
        incarnation: entry.incarnation,
        revision: nextCounter(entry.revision),
        deletedAt: timestamp(),
      }
      delete saved.sourceState.entries[id]
      persist({ ...saved, notes: saved.notes.filter((note) => note.id !== id) })
      rmSync(audioFile(id), { force: true })
    },
    audio: (id: string) => (find(id)?.hasAudio && existsSync(audioFile(id)) ? readFileSync(audioFile(id)) : null),
  }
}
