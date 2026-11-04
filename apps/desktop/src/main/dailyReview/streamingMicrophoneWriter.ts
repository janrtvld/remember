import { randomUUID } from 'node:crypto'
import { type FileHandle, mkdir, open, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { MicrophoneMessage } from './sharedMicrophoneService'

const SAMPLE_RATE = 16_000
const MAX_NOTE_FRAMES = SAMPLE_RATE * 30 * 60

function header(frames: number) {
  const bytes = Buffer.alloc(44)
  bytes.write('RIFF', 0)
  bytes.writeUInt32LE(36 + frames * 2, 4)
  bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(SAMPLE_RATE, 24)
  bytes.writeUInt32LE(SAMPLE_RATE * 2, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36)
  bytes.writeUInt32LE(frames * 2, 40)
  return bytes
}

async function writeAll(descriptor: FileHandle, bytes: Buffer, position: number | null = null) {
  for (let offset = 0; offset < bytes.length; ) {
    const { bytesWritten: count } = await descriptor.write(
      bytes,
      offset,
      bytes.length - offset,
      position == null ? null : position + offset
    )
    if (!count) throw new Error('Microphone file write made no progress')
    offset += count
  }
}

class PcmFile {
  frames = 0
  squares = 0

  private constructor(
    private descriptor: FileHandle | null,
    readonly path: string,
    readonly startedAt: number,
    readonly firstFrame: number
  ) {}

  static async create(path: string, startedAt: number, firstFrame: number) {
    const descriptor = await open(path, 'wx', 0o600)
    const file = new PcmFile(descriptor, path, startedAt, firstFrame)
    try {
      await writeAll(descriptor, header(0))
      return file
    } catch (error) {
      await file.finish(true)
      throw error
    }
  }

  async append(samples: Float32Array) {
    if (this.descriptor == null) throw new Error('Microphone file already closed')
    const bytes = Buffer.allocUnsafe(samples.length * 2)
    for (let index = 0; index < samples.length; index++) {
      const value = samples[index]
      if (!Number.isFinite(value)) throw new Error('Microphone supplied a non-finite sample')
      const clipped = Math.max(-1, Math.min(1, value))
      bytes.writeInt16LE(Math.round(clipped * (clipped < 0 ? 32768 : 32767)), index * 2)
      this.squares += clipped * clipped
    }
    await writeAll(this.descriptor, bytes)
    this.frames += samples.length
  }

  async finish(cancel = false) {
    let failure: unknown = null
    if (this.descriptor != null) {
      const descriptor = this.descriptor
      this.descriptor = null
      try {
        if (!cancel) await writeAll(descriptor, header(this.frames), 0)
      } catch (error) {
        failure = error
      } finally {
        try {
          await descriptor.close()
        } catch (error) {
          failure ??= error
        }
      }
    }
    if (cancel || this.frames === 0 || failure) {
      try {
        await unlink(this.path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    if (failure) throw failure
  }
}

type Conversation = {
  directory: string
  chunkFrames: number
  epoch: string
  sequence: number
  started: boolean
  file: PcmFile | null
}
type Note = { sessionId: number; path: string; started: boolean; file: PcmFile | null; limitRequested: boolean }

/** Disk sink for ordered AudioWorklet PCM and routing boundaries; it never owns the microphone. */
export class StreamingMicrophoneWriter {
  private conversation: Conversation | null = null
  private note: Note | null = null
  private route: 'idle' | 'conversation' | 'dictation' = 'idle'
  private nextFrame: number | null = null
  private minimumFrame = 0
  private streamId: number | null = null
  private lastLevelFrame = -Infinity
  private commands = new Map<number, MicrophoneMessage>()
  private failed = false
  private pending = Promise.resolve()
  private disposal: Promise<void> | null = null

  constructor(
    private readonly onMessage: (message: MicrophoneMessage) => void,
    private readonly onFailure: (error: Error) => void,
    private readonly onLimit: (sessionId: number) => void
  ) {}

  register(command: MicrophoneMessage) {
    return this.enqueue(async () => {
      if (!command.type?.startsWith('conversation-') && !command.type?.startsWith('dictation-')) return
      if (!Number.isSafeInteger(command.id)) throw new Error('Invalid microphone command id')
      this.commands.set(command.id as number, command)
      if (command.type === 'conversation-start') {
        if (this.conversation) throw new Error('Conversation is already subscribed')
        if (typeof command.output_dir !== 'string' || !Number.isFinite(command.chunk_ms))
          throw new Error('Invalid conversation destination')
        const chunkFrames = Math.round((Number(command.chunk_ms) * SAMPLE_RATE) / 1000)
        if (chunkFrames < 1600 || chunkFrames > SAMPLE_RATE * 60) throw new Error('Invalid microphone chunk duration')
        await mkdir(command.output_dir, { recursive: true, mode: 0o700 })
        this.conversation = {
          directory: command.output_dir,
          chunkFrames,
          epoch: randomUUID(),
          sequence: 0,
          started: false,
          file: null,
        }
      } else if (command.type === 'dictation-start') {
        if (this.note) throw new Error('Voice note is already subscribed')
        if (!Number.isSafeInteger(command.session_id) || typeof command.output_path !== 'string')
          throw new Error('Invalid voice note destination')
        this.note = {
          sessionId: command.session_id as number,
          path: command.output_path,
          started: false,
          file: null,
          limitRequested: false,
        }
      }
    })
  }

  handle(message: MicrophoneMessage) {
    return this.enqueue(async () => {
      if (message.type === 'boundary') await this.boundary(message)
      else if (message.type === 'pcm') await this.pcm(message)
      else throw new Error('Unknown microphone writer message')
    })
  }

  acknowledge(id: number) {
    return this.enqueue(async () => {
      const command = this.commands.get(id)
      const note = this.note
      this.commands.delete(id)
      // Successful routing emits its boundary before the response. A start
      // acknowledged without that boundary was cancelled or failed acquisition.
      if (command?.type === 'dictation-start' && note && note.sessionId === command.session_id) {
        if (note.started) throw new Error('Voice note acknowledged without a routing boundary')
        await note.file?.finish(true)
        this.note = null
      } else if (command?.type === 'conversation-start' && this.conversation) {
        if (this.conversation.started) throw new Error('Conversation acknowledged without a routing boundary')
        await this.conversation.file?.finish(true)
        this.conversation = null
      }
    })
  }

  private async boundary(message: MicrophoneMessage) {
    const command = typeof message.id === 'number' ? this.commands.get(message.id) : null
    if (!command || message.action !== command.type) throw new Error('Unmatched microphone routing boundary')
    this.commands.delete(message.id as number)
    if (!Number.isSafeInteger(message.frame) || Number(message.frame) < 0)
      throw new Error('Invalid microphone boundary frame')
    const route = message.route
    if (route !== 'idle' && route !== 'conversation' && route !== 'dictation')
      throw new Error('Invalid microphone route')
    if (!Number.isSafeInteger(message.stream_id)) throw new Error('Invalid microphone stream identity')
    if (message.stream_id !== this.streamId) {
      if (this.route !== 'idle') throw new Error('Microphone stream changed during capture')
      this.streamId = Number(message.stream_id)
      this.nextFrame = null
    }
    if (this.nextFrame != null && this.route !== 'idle' && Number(message.frame) !== this.nextFrame)
      throw new Error('Microphone boundary lost audio frames')
    const action = command.type
    if (action === 'dictation-start') {
      this.lastLevelFrame = -Infinity
      if (this.conversation) {
        await this.finishConversationChunk()
        this.onMessage({ type: 'conversation-paused' })
      }
    } else if (action === 'dictation-stop' || action === 'dictation-cancel') {
      if (this.note?.sessionId === command.session_id) await this.finishNote(action === 'dictation-cancel')
    } else if (action === 'conversation-stop' || action === 'conversation-pause') {
      await this.finishConversationChunk()
      if (action === 'conversation-stop') this.conversation = null
    }
    const wasStreaming = this.route !== 'idle' && this.nextFrame != null
    this.route = route
    this.minimumFrame = Number(message.frame)
    this.nextFrame = route !== 'idle' && wasStreaming ? Number(message.frame) : null
  }

  private async pcm(message: MicrophoneMessage) {
    if (
      !(message.samples instanceof ArrayBuffer) ||
      !Number.isSafeInteger(message.count) ||
      Number(message.count) < 1 ||
      Number(message.count) > SAMPLE_RATE ||
      message.samples.byteLength < Number(message.count) * 4 ||
      message.samples.byteLength > 1024 ||
      message.samples.byteLength % 4 !== 0 ||
      !Number.isSafeInteger(message.frame) ||
      Number(message.frame) < 0 ||
      !Number.isFinite(message.started_at)
    )
      throw new Error('Invalid microphone PCM block')
    if (message.stream_id !== this.streamId) throw new Error('Stale microphone PCM stream')
    if (message.consumer !== this.route || this.route === 'idle')
      throw new Error('Microphone PCM arrived outside its subscription')
    const frame = Number(message.frame)
    if (frame < this.minimumFrame) throw new Error('Microphone PCM precedes its routing boundary')
    if (this.nextFrame != null && frame !== this.nextFrame)
      throw new Error('Microphone PCM frames are missing or repeated')
    const samples = new Float32Array(message.samples, 0, Number(message.count))
    this.nextFrame = frame + samples.length
    if (this.route === 'conversation') {
      const conversation = this.conversation
      if (!conversation) throw new Error('Conversation PCM has no owner')
      for (let offset = 0; offset < samples.length; ) {
        if (!conversation.file)
          conversation.file = await PcmFile.create(
            join(conversation.directory, `${randomUUID()}.wav`),
            Number(message.started_at) + offset / 16,
            frame + offset
          )
        const count = Math.min(conversation.chunkFrames - conversation.file.frames, samples.length - offset)
        await conversation.file.append(samples.subarray(offset, offset + count))
        offset += count
        if (!conversation.started) {
          conversation.started = true
          this.onMessage({ type: 'conversation-started' })
        }
        if (conversation.file.frames === conversation.chunkFrames) await this.finishConversationChunk()
      }
    } else {
      const note = this.note
      if (!note || message.session_id !== note.sessionId) throw new Error('Voice note PCM has no matching owner')
      if (!note.file) note.file = await PcmFile.create(note.path, Number(message.started_at), frame)
      const count = Math.min(MAX_NOTE_FRAMES - note.file.frames, samples.length)
      if (count > 0) await note.file.append(samples.subarray(0, count))
      if (!note.started) {
        note.started = true
        this.onMessage({ type: 'dictation-started', session_id: note.sessionId, started_at: note.file.startedAt })
      }
      if (frame - this.lastLevelFrame >= 960) {
        this.lastLevelFrame = frame
        let squares = 0
        for (const value of samples) squares += value * value
        this.onMessage({
          type: 'dictation-level',
          session_id: note.sessionId,
          level: Math.min(1, Math.sqrt(squares / samples.length) * 4),
        })
      }
      if (note.file.frames === MAX_NOTE_FRAMES && !note.limitRequested) {
        note.limitRequested = true
        this.onLimit(note.sessionId)
      }
    }
  }

  private async finishConversationChunk() {
    const conversation = this.conversation
    const file = conversation?.file
    if (!conversation || !file) return
    conversation.file = null
    await file.finish()
    this.onMessage({
      type: 'chunk',
      path: file.path,
      started_at: file.startedAt,
      duration_ms: file.frames / 16,
      average_level: Math.sqrt(file.squares / file.frames),
      capture_epoch_id: conversation.epoch,
      sequence: ++conversation.sequence,
      sample_count: file.frames,
      first_sample_time: file.firstFrame,
    })
  }

  private async finishNote(cancel: boolean) {
    const note = this.note
    if (!note) return
    this.note = null
    await note.file?.finish(cancel)
    if (cancel) return
    if (!note.file?.frames) {
      this.onMessage({
        type: 'dictation-error',
        session_id: note.sessionId,
        message: 'The voice note contains no audio samples',
      })
    } else {
      this.onMessage({
        type: 'dictation-result',
        session_id: note.sessionId,
        path: note.path,
        duration_ms: note.file.frames / 16,
      })
    }
  }

  private enqueue(action: () => Promise<void>) {
    if (this.disposal) return this.disposal
    // Routing boundaries and acknowledgments must wait for earlier disk writes.
    this.pending = this.pending.then(async () => {
      if (this.failed) return
      try {
        await action()
      } catch (error) {
        this.failed = true
        await this.cleanUp(false)
        this.onFailure(error instanceof Error ? error : new Error(String(error)))
      }
    })
    return this.pending
  }

  dispose(retainConversation = false) {
    if (this.disposal) return this.disposal
    this.disposal = this.pending.then(() => this.cleanUp(retainConversation))
    return this.disposal
  }

  private async cleanUp(retainConversation: boolean) {
    this.failed = true
    if (retainConversation) {
      try {
        await this.finishConversationChunk()
      } catch (error) {
        console.warn('[microphone] Could not retain interrupted conversation', error)
      }
    }
    for (const file of [this.conversation?.file, this.note?.file]) {
      try {
        await file?.finish(true)
      } catch (error) {
        console.warn('[microphone] Could not clean up capture file', error)
      }
    }
    this.conversation = null
    this.note = null
    this.commands.clear()
  }
}
