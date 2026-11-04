import type { DictationBridge, DictationNote, DictationState } from '@remember/shared'
import { getRememberBridge } from './rememberBridge'

let browserBridge: DictationBridge | null = null

export function getDictationBridge(): DictationBridge | null {
  if (typeof window === 'undefined') return null
  if (window.rememberDictation) return window.rememberDictation
  if (process.env.NODE_ENV !== 'development') return null
  browserBridge ??= createBrowserDictationBridge()
  return browserBridge
}

function createBrowserDictationBridge(): DictationBridge {
  const historyKey = 'remember-dev-dictation-notes'
  const saved = localStorage.getItem(historyKey)
  let notes: DictationNote[] = saved
    ? JSON.parse(saved)
    : [
        {
          id: 'browser-note-1',
          createdAt: Date.now() - 3600000,
          durationMs: 14000,
          text: 'Morgen bespreken we de planning voor het nieuwe project. Stuur het verslag daarna naar het team.',
          status: 'completed',
          error: null,
          hasAudio: true,
        },
        {
          id: 'browser-note-2',
          createdAt: Date.now() - 86400000,
          durationMs: 22000,
          text: 'Het voorstel eerst met het team bespreken. Daarna een korte samenvatting sturen met de keuzes en de volgende stappen.',
          status: 'completed',
          error: null,
          hasAudio: true,
        },
      ]
  const historyListeners = new Set<(notes: DictationNote[]) => void>()
  const publishHistory = () => {
    localStorage.setItem(historyKey, JSON.stringify(notes))
    historyListeners.forEach((listener) => {
      listener(notes.map((note) => ({ ...note })))
    })
  }
  let composerTarget = false
  let state: DictationState = {
    status: 'idle',
    startedAt: null,
    level: 0,
    text: '',
    result: null,
    error: null,
    canRetry: false,
    microphones: [
      { id: 'built-in', label: 'MacBook Pro Microphone' },
      { id: 'headset', label: 'Headset' },
    ],
    shortcutRegistered: true,
    accessibilityGranted: true,
    modelReady: true,
    modelProgress: null,
    modelPreparing: false,
  }
  const listeners = new Set<(state: DictationState) => void>()
  let generation = 0
  let modelGeneration = 0
  const publish = () =>
    listeners.forEach((listener) => {
      listener({ ...state })
    })
  const update = (patch: Partial<DictationState>) => {
    state = { ...state, ...patch }
    publish()
  }
  const finish = async (noteId?: string) => {
    const current = ++generation
    const id = noteId ?? crypto.randomUUID()
    if (!noteId)
      notes = [
        {
          id,
          createdAt: state.startedAt ?? Date.now(),
          durationMs: Date.now() - (state.startedAt ?? Date.now()),
          text: '',
          status: 'processing',
          error: null,
          hasAudio: true,
        },
        ...notes,
      ]
    else notes = notes.map((note) => (note.id === id ? { ...note, status: 'processing', error: null } : note))
    publishHistory()
    update({ status: 'transcribing', level: 0 })
    await new Promise((resolve) => setTimeout(resolve, 700))
    if (current !== generation) return
    const preferences = (await getRememberBridge()?.getSettings())?.dictation
    notes = notes.map((note) =>
      note.id === id ? { ...note, text: 'Dit is een korte dictatie.', status: 'completed', error: null } : note
    )
    publishHistory()
    update({
      status: 'done',
      text: 'Dit is een korte dictatie.',
      result: composerTarget ? null : preferences?.autoInsert ? 'inserted' : 'copied',
    })
    setTimeout(() => {
      if (generation === current && state.status === 'done') update({ status: 'idle' })
    }, 4000)
  }
  return {
    getHistory: async () => notes.map((note) => ({ ...note })),
    onHistory: (listener) => {
      historyListeners.add(listener)
      return () => {
        historyListeners.delete(listener)
      }
    },
    retryNote: async (id) => {
      if (!notes.some((note) => note.id === id)) throw new Error('note-not-found')
      return finish(id)
    },
    deleteNote: async (id) => {
      notes = notes.filter((note) => note.id !== id)
      publishHistory()
    },
    copyNote: async (id) => {
      const note = notes.find((note) => note.id === id)
      if (note?.text) await navigator.clipboard.writeText(note.text)
    },
    downloadNote: async (id) => (notes.some((note) => note.id === id && note.hasAudio) ? browserAudio() : null),
    getState: async () => {
      const preferences = (await getRememberBridge()?.getSettings())?.dictation
      state = { ...state, shortcutRegistered: Boolean(preferences?.enabled && preferences.shortcut) }
      return { ...state }
    },
    onState: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    toggle: async (target) => {
      if (state.status === 'recording') return finish()
      if (state.status === 'transcribing') return
      generation++
      composerTarget = target === 'composer'
      update({ text: '', status: 'recording', startedAt: Date.now(), level: 0.4, result: null, error: null })
    },
    cancel: async () => {
      generation++
      notes = notes.filter((note) => note.status !== 'processing')
      publishHistory()
      update({ status: 'idle', startedAt: null, level: 0, error: null })
    },
    retry: () => finish(),
    copy: async () => {
      if (state.text) await navigator.clipboard.writeText(state.text)
    },
    prepareModel: async () => {
      const current = ++modelGeneration
      update({ modelPreparing: true, modelProgress: 0.5 })
      await new Promise((resolve) => setTimeout(resolve, 700))
      if (current !== modelGeneration) return
      update({ modelPreparing: false, modelReady: true, modelProgress: null })
    },
    cancelModelPreparation: async () => {
      modelGeneration++
      update({ modelPreparing: false, modelProgress: null })
    },
    requestAccessibility: async () => {
      update({ accessibilityGranted: true })
      return true
    },
    refreshMicrophones: async () => publish(),
    setShortcutRecording: async () => undefined,
  }
}

function browserAudio() {
  const buffer = new ArrayBuffer(32044)
  const view = new DataView(buffer)
  const text = (offset: number, value: string) =>
    [...value].forEach((letter, index) => {
      view.setUint8(offset + index, letter.charCodeAt(0))
    })
  text(0, 'RIFF')
  view.setUint32(4, 32036, true)
  text(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true)
  view.setUint32(28, 32000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, 32000, true)
  return buffer
}
