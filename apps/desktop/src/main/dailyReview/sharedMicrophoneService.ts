import { EventEmitter } from 'node:events'
import type { DictationRecorderEvent } from '@remember/shared'

const COMMAND_TIMEOUT_MS = 10_000
const BUILT_IN_MICROPHONE =
  /\b(macbook|imac|mac pro|mac mini|mac studio|studio display|built-in|internal|ingebouwd|interne)\b/i

export type MicrophoneAudioChunk = {
  path: string
  startedAt: number
  durationMs: number
  averageLevel: number
  captureEpochId: string
  sequence: number
  sampleCount: number
  sampleTime: number | null
}

export type MicrophoneMessage = Record<string, unknown> & { type?: string; id?: number; ok?: boolean }
export type MicrophoneTransport = {
  send: (message: MicrophoneMessage) => void
  dispose: () => Promise<void>
}
export type CreateMicrophoneTransport = (
  onMessage: (message: MicrophoneMessage) => void,
  onFailure: (error: Error) => void
) => MicrophoneTransport
type ConversationCallbacks = {
  onReady: (microphoneName: string) => void
  onChunk: (chunk: MicrophoneAudioChunk) => void
  onError: (code: string, message: string) => void
  onPaused?: () => void
}
type Dictation = {
  sessionId: number
  outputPath: string
  onEvent: (event: DictationRecorderEvent) => void
  canceled: boolean
  started: boolean
  commandSent: boolean
}

export class MicrophoneCaptureHandle extends EventEmitter {
  readonly kind = 'microphone-lease'
  isClosed = false
  private closeBarrier: Promise<void> | null = null
  private closing = false
  private finish!: () => void
  readonly closed = new Promise<void>((resolve) => {
    this.finish = resolve
  })

  constructor(readonly stop: () => void) {
    super()
  }

  waitForTransportClosed(exited: Promise<void>) {
    this.closeBarrier = exited
  }

  close() {
    if (this.isClosed || this.closing) return
    if (this.closeBarrier) {
      this.closing = true
      void this.closeBarrier.then(() => {
        this.closing = false
        this.closeBarrier = null
        this.close()
      })
      return
    }
    this.isClosed = true
    this.finish()
    this.emit('close')
  }
}

/** One capture transport; stopping a subscriber never closes another subscriber. */
export class SharedMicrophoneService {
  private transport: MicrophoneTransport | null = null
  private generation = 0
  private rejectReady: ((error: Error) => void) | null = null
  private ready: Promise<void> | null = null
  private retiring: Promise<void> | null = null
  private microphoneName = ''
  private defaultSelected = false
  private nextCommandId = 0
  private pending = new Map<
    number,
    {
      resolve: (value: MicrophoneMessage) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private conversation: { handle: MicrophoneCaptureHandle; callbacks: ConversationCallbacks } | null = null
  private conversationQueue: Promise<void> = Promise.resolve()
  private leases = new Map<MicrophoneCaptureHandle, ConversationCallbacks>()
  private dictation: Dictation | null = null
  private disposed = false

  constructor(
    private readonly dependencies: {
      createTransport: CreateMicrophoneTransport
      outputPath: () => string
      readResult: (path: string) => ArrayBuffer
      removeFile: (path: string) => void
      timeoutMs?: number
    }
  ) {}

  defaultInputSelected() {
    return this.transport != null && this.defaultSelected
  }

  prewarm() {
    return this.ensureReady()
  }

  private ensureReady(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Microphone service disposed'))
    if (this.retiring) return this.retiring.then(() => this.ensureReady())
    if (this.ready) return this.ready
    const generation = ++this.generation
    let resolveReady!: () => void
    let rejectReady!: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    this.ready = ready
    const timeout = setTimeout(() => {
      this.fail(new Error('Microphone recorder did not become ready'), generation)
    }, this.dependencies.timeoutMs ?? COMMAND_TIMEOUT_MS)
    this.rejectReady = (error) => {
      clearTimeout(timeout)
      rejectReady(error)
    }
    try {
      this.transport = this.dependencies.createTransport(
        (message) => {
          if (generation !== this.generation) return
          if (message.type === 'ready') {
            this.updateDevice(message)
            clearTimeout(timeout)
            this.rejectReady = null
            resolveReady()
          } else this.handleMessage(message)
        },
        (error) => this.fail(error, generation)
      )
    } catch (error) {
      this.fail(new Error(String(error)), generation)
    }
    return ready
  }

  private updateDevice(event: MicrophoneMessage) {
    if (typeof event.microphone_name === 'string') this.microphoneName = event.microphone_name
    if (typeof event.default_input_is_selected === 'boolean') this.defaultSelected = event.default_input_is_selected
  }

  private command(type: string, fields: Record<string, unknown> = {}): Promise<MicrophoneMessage> {
    const transport = this.transport
    if (!transport) return Promise.reject(new Error('Microphone recorder unavailable'))
    const generation = this.generation
    const id = ++this.nextCommandId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error(`Microphone command timed out: ${type}`), generation)
      }, this.dependencies.timeoutMs ?? COMMAND_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      try {
        transport.send({ id, type, ...fields })
      } catch (error) {
        this.fail(new Error(String(error)), generation)
      }
    })
  }

  private handleMessage(event: MicrophoneMessage) {
    if (typeof event.id === 'number' && typeof event.ok === 'boolean') {
      const pending = this.pending.get(event.id)
      if (!pending) return
      this.pending.delete(event.id)
      clearTimeout(pending.timer)
      this.updateDevice(event)
      if (event.ok) pending.resolve(event)
      else pending.reject(new Error(String(event.error ?? 'Microphone command failed')))
      return
    }
    if (event.type === 'chunk') {
      if (!this.conversation) return
      this.conversation.callbacks.onChunk({
        path: String(event.path),
        startedAt: Number(event.started_at),
        durationMs: Number(event.duration_ms),
        averageLevel: Number(event.average_level),
        captureEpochId: String(event.capture_epoch_id),
        sequence: Number(event.sequence),
        sampleCount: Number(event.sample_count),
        sampleTime: typeof event.first_sample_time === 'number' ? event.first_sample_time : null,
      })
      return
    }
    if (event.type === 'conversation-started') {
      this.updateDevice(event)
      this.conversation?.callbacks.onReady(this.microphoneName)
      return
    }
    if (event.type === 'conversation-paused') {
      this.conversation?.callbacks.onPaused?.()
      return
    }
    const note = this.dictation
    if (typeof event.session_id === 'number') {
      if (!note || note.sessionId !== event.session_id || note.canceled) return
      if (event.type === 'dictation-started') {
        note.started = true
        note.onEvent({ type: 'started', sessionId: note.sessionId, startedAt: Number(event.started_at) })
      } else if (event.type === 'dictation-level') {
        note.onEvent({ type: 'level', sessionId: note.sessionId, level: Number(event.level) })
      } else if (event.type === 'dictation-result') {
        this.dictation = null
        try {
          if (event.path !== note.outputPath) throw new Error('Unexpected shared recording path')
          const wav = this.dependencies.readResult(note.outputPath)
          note.onEvent({ type: 'result', sessionId: note.sessionId, wav, durationMs: Number(event.duration_ms) })
        } catch (error) {
          note.onEvent({ type: 'error', sessionId: note.sessionId, message: String(error) })
        } finally {
          this.dependencies.removeFile(note.outputPath)
        }
      } else if (event.type === 'dictation-error') {
        this.dictation = null
        this.dependencies.removeFile(note.outputPath)
        note.onEvent({ type: 'error', sessionId: note.sessionId, message: String(event.message) })
      }
    } else if (event.type === 'error') {
      this.fail(new Error(String(event.message ?? 'Microphone recorder failed')))
    }
  }

  startConversation(outputDirectory: string, chunkDurationMs: number, callbacks: ConversationCallbacks) {
    let stopping = false
    const handle = new MicrophoneCaptureHandle(() => {
      if (stopping || handle.isClosed) return
      stopping = true
      this.conversationQueue = this.conversationQueue.then(async () => {
        try {
          if (this.conversation?.handle === handle) await this.command('conversation-stop')
        } catch (error) {
          if (this.transport) this.fail(new Error(String(error)))
        } finally {
          if (this.conversation?.handle === handle) this.conversation = null
          this.leases.delete(handle)
          handle.close()
        }
      })
    })
    this.leases.set(handle, callbacks)
    this.conversationQueue = this.conversationQueue.then(async () => {
      try {
        if (!this.leases.has(handle) || stopping) return
        await this.ensureReady()
        if (!this.leases.has(handle) || stopping) return
        if (this.conversation) throw new Error('A conversation microphone subscriber already exists')
        this.conversation = { handle, callbacks }
        await this.command('conversation-start', { output_dir: outputDirectory, chunk_ms: chunkDurationMs })
      } catch (error) {
        if (this.leases.has(handle)) callbacks.onError('microphone-capture-failed', String(error))
        if (this.conversation?.handle === handle) this.conversation = null
        this.leases.delete(handle)
        handle.close()
      }
    })
    return handle
  }

  async startDictation(
    options: {
      sessionId: number
      forceBuiltInMicrophone: boolean
      microphoneId?: string | null
      microphoneLabel?: string | null
    },
    onEvent: (event: DictationRecorderEvent) => void
  ): Promise<boolean> {
    if (options.microphoneId && !options.forceBuiltInMicrophone && !options.microphoneLabel) return false
    if (this.dictation) throw new Error('Shared dictation already active')
    const note: Dictation = {
      sessionId: options.sessionId,
      outputPath: this.dependencies.outputPath(),
      onEvent,
      canceled: false,
      started: false,
      commandSent: false,
    }
    this.dictation = note
    try {
      await this.ensureReady()
      if (note.canceled) return false
      await this.command('status')
      if (note.canceled) return false
      // Device IDs are partition-scoped. Only our preferred built-in input can
      // be matched by label; identical external-device names are ambiguous.
      const explicitBuiltIn =
        options.microphoneId &&
        BUILT_IN_MICROPHONE.test(this.microphoneName) &&
        options.microphoneLabel?.replace(/ \(Built-in\)$/, '') === this.microphoneName.replace(/ \(Built-in\)$/, '')
      if (!options.forceBuiltInMicrophone && (options.microphoneId ? !explicitBuiltIn : !this.defaultSelected)) {
        this.dictation = null
        return false
      }
      note.commandSent = true
      await this.command('dictation-start', { session_id: note.sessionId, output_path: note.outputPath })
      return !note.canceled
    } catch (error) {
      if (this.dictation === note) {
        this.cancelDictation(note.sessionId)
        // A rejected start must be fully released before Chromium can acquire input.
        if (note.commandSent && this.transport) this.fail(new Error(String(error)))
      }
      if (this.retiring) await this.retiring
      throw error
    } finally {
      if (note.canceled && this.dictation === note) this.dictation = null
      if (!note.commandSent || note.canceled) this.dependencies.removeFile(note.outputPath)
    }
  }

  stopDictation(sessionId: number) {
    const note = this.dictation
    if (!note || note.sessionId !== sessionId || note.canceled) return
    void this.command('dictation-stop', { session_id: sessionId }).catch((error) => {
      if (this.dictation !== note) return
      this.cancelDictation(sessionId)
      note.onEvent({ type: 'error', sessionId, message: String(error) })
    })
  }

  cancelDictation(sessionId: number) {
    const note = this.dictation
    if (!note || note.sessionId !== sessionId || note.canceled) return
    note.canceled = true
    this.dictation = null
    const generation = this.generation
    if (note.commandSent && this.transport) {
      void this.command('dictation-cancel', { session_id: sessionId })
        .catch((error) => {
          this.fail(error, generation)
          return this.retiring
        })
        .finally(() => this.dependencies.removeFile(note.outputPath))
    } else this.dependencies.removeFile(note.outputPath)
  }

  private fail(error: Error, generation = this.generation) {
    if (generation !== this.generation) return
    ++this.generation
    const transport = this.transport
    this.transport = null
    this.rejectReady?.(error)
    this.rejectReady = null
    this.ready = null
    this.defaultSelected = false
    const closed = transport?.dispose() ?? Promise.resolve()
    this.retiring = closed
    void closed.then(() => {
      if (this.retiring === closed) this.retiring = null
    })
    for (const lease of this.leases.keys()) lease.waitForTransportClosed(closed)
    for (const command of this.pending.values()) {
      clearTimeout(command.timer)
      command.reject(error)
    }
    this.pending.clear()
    this.conversation = null
    for (const [lease, callbacks] of this.leases) {
      callbacks.onError('microphone-capture-failed', error.message)
      lease.close()
    }
    this.leases.clear()
    const note = this.dictation
    this.dictation = null
    if (note) {
      void closed.then(() => this.dependencies.removeFile(note.outputPath))
      note.canceled = true
      this.dependencies.removeFile(note.outputPath)
      note.onEvent({ type: 'error', sessionId: note.sessionId, message: error.message })
    }
  }

  dispose() {
    if (this.disposed) return this.retiring ?? Promise.resolve()
    this.disposed = true
    if (this.transport || this.ready) this.fail(new Error('Microphone service disposed'))
    return this.retiring ?? Promise.resolve()
  }
}
