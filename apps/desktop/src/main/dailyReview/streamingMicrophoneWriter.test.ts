import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { type FileHandle, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'
import { readPcmWavInfo } from './pcmWav'
import type { MicrophoneMessage } from './sharedMicrophoneService'
import { StreamingMicrophoneWriter } from './streamingMicrophoneWriter'

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'shared-microphone-writer-'))
  const events: MicrophoneMessage[] = []
  const failures: Error[] = []
  const limits: number[] = []
  const writer = new StreamingMicrophoneWriter(
    (event) => events.push(event),
    (error) => failures.push(error),
    (id) => limits.push(id)
  )
  t.after(async () => {
    await writer.dispose()
    rmSync(directory, { recursive: true, force: true })
  })
  let id = 0
  function boundary(action: string, frame: number, route: string, fields: object = {}, streamId = 1) {
    const current = ++id
    void writer.register({ id: current, type: action, ...fields })
    return writer.handle({ type: 'boundary', id: current, action, frame, route, stream_id: streamId })
  }
  function pcm(consumer: string, frame: number, count: number, value: number, sessionId?: number, streamId = 1) {
    const samples = new Float32Array(256)
    samples.fill(value, 0, count)
    return writer.handle({
      type: 'pcm',
      consumer,
      frame,
      samples: samples.buffer,
      count,
      session_id: sessionId,
      stream_id: streamId,
      started_at: 1000 + frame / 16,
    })
  }
  return { directory, events, failures, limits, writer, boundary, pcm }
}

test('conversation/note boundaries preserve disjoint samples, flush before pause, and resume conversation', async (t) => {
  const f = fixture(t)
  await f.boundary('conversation-start', 0, 'conversation', { output_dir: f.directory, chunk_ms: 60000 })
  await f.pcm('conversation', 0, 128, 0.1)
  const notePath = join(f.directory, 'note.wav')
  await f.boundary('dictation-start', 128, 'dictation', { session_id: 8, output_path: notePath })
  assert.deepEqual(
    f.events.map((event) => event.type),
    ['conversation-started', 'chunk', 'conversation-paused']
  )
  await f.pcm('dictation', 128, 256, 0.8, 8)
  await f.boundary('dictation-stop', 384, 'conversation', { session_id: 8 })
  await f.pcm('conversation', 384, 128, 0.2)
  await f.boundary('conversation-stop', 512, 'idle')
  assert.equal(f.failures.length, 0)
  const chunks = f.events.filter((event) => event.type === 'chunk')
  assert.equal(chunks.length, 2)
  assert.deepEqual(
    chunks.map((chunk) => [chunk.first_sample_time, chunk.sample_count]),
    [
      [0, 128],
      [384, 128],
    ]
  )
  assert.equal(chunks[0].capture_epoch_id, chunks[1].capture_epoch_id)
  assert.deepEqual(
    chunks.map((chunk) => chunk.sequence),
    [1, 2]
  )
  const note = f.events.find((event) => event.type === 'dictation-result')
  assert.equal(note?.path, notePath)
  assert.equal(note?.duration_ms, 16)
  assert.equal(readPcmWavInfo(notePath).sampleCount, 256)
  assert.equal(readFileSync(notePath).readInt16LE(44), Math.round(0.8 * 32767))
  assert.equal(readFileSync(String(chunks[0].path)).readInt16LE(44), Math.round(0.1 * 32767))
})

test('stopping conversation during a note retains the note and cancels only its owned file', async (t) => {
  const f = fixture(t)
  await f.boundary('conversation-start', 0, 'conversation', { output_dir: f.directory, chunk_ms: 60000 })
  await f.pcm('conversation', 0, 128, 0.1)
  const path = join(f.directory, 'note.wav')
  await f.boundary('dictation-start', 128, 'dictation', { session_id: 1, output_path: path })
  await f.pcm('dictation', 128, 128, 0.4, 1)
  await f.boundary('conversation-stop', 256, 'dictation')
  await f.pcm('dictation', 256, 128, 0.6, 1)
  assert.equal(existsSync(path), true)
  await f.boundary('dictation-cancel', 384, 'idle', { session_id: 1 })
  assert.equal(existsSync(path), false)
  assert.equal(f.failures.length, 0)
  assert.equal(f.events.filter((event) => event.type === 'dictation-result').length, 0)
  assert.equal(readdirSync(f.directory).length, 1)
})

test('streaming chunks split across worklet blocks exactly and retain short final buffers', async (t) => {
  const f = fixture(t)
  await f.boundary('conversation-start', 0, 'conversation', { output_dir: f.directory, chunk_ms: 100 })
  for (let frame = 0; frame < 1792; frame += 256) await f.pcm('conversation', frame, 256, 0.25)
  await f.boundary('conversation-stop', 1792, 'idle')
  const chunks = f.events.filter((event) => event.type === 'chunk')
  assert.deepEqual(
    chunks.map((chunk) => chunk.sample_count),
    [1600, 192]
  )
  assert.deepEqual(
    chunks.map((chunk) => chunk.started_at),
    [1000, 1100]
  )
  for (const chunk of chunks) {
    const info = readPcmWavInfo(String(chunk.path))
    assert.equal(info.sampleRate, 16000)
    assert.equal(info.sampleCount, chunk.sample_count)
    assert.equal(readFileSync(String(chunk.path)).length, 44 + Number(chunk.sample_count) * 2)
  }
  assert.equal(f.failures.length, 0)
})

test('transport interruption retains the valid conversation prefix exactly once', async (t) => {
  const f = fixture(t)
  await f.boundary('conversation-start', 0, 'conversation', { output_dir: f.directory, chunk_ms: 60000 })
  await f.pcm('conversation', 0, 256, 0.25)
  await f.pcm('conversation', 256, 128, 0.5)
  await f.writer.dispose(true)
  await f.writer.dispose(true)
  const chunks = f.events.filter((event) => event.type === 'chunk')
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].sample_count, 384)
  assert.equal(chunks[0].duration_ms, 24)
  const wav = readFileSync(String(chunks[0].path))
  assert.equal(wav.length, 44 + 384 * 2)
  assert.equal(readPcmWavInfo(String(chunks[0].path)).sampleCount, 384)
  assert.equal(wav.readInt16LE(44), Math.round(0.25 * 32767))
  assert.equal(wav.readInt16LE(44 + 256 * 2), Math.round(0.5 * 32767))
})

test('transport interruption never turns an incomplete Voice note into a successful result', async (t) => {
  const f = fixture(t)
  const path = join(f.directory, 'interrupted-note.wav')
  await f.boundary('dictation-start', 0, 'dictation', { session_id: 1, output_path: path })
  await f.pcm('dictation', 0, 128, 0.4, 1)
  await f.writer.dispose(true)
  assert.equal(existsSync(path), false)
  assert(!f.events.some((event) => event.type === 'dictation-result' || event.type === 'chunk'))
})

test('initial empty input permits a delayed first PCM but a later missing frame fails capture', async (t) => {
  const f = fixture(t)
  await f.boundary('conversation-start', 0, 'conversation', { output_dir: f.directory, chunk_ms: 60000 })
  await f.pcm('conversation', 256, 128, 0.1)
  assert.equal(f.failures.length, 0)
  await f.pcm('conversation', 512, 128, 0.1)
  assert.equal(f.failures.length, 1)
  assert.match(f.failures[0].message, /missing or repeated/)
  assert.equal(readdirSync(f.directory).length, 0)
})

test('a new idle stream may reset its clock; stale prior stream PCM fails closed', async (t) => {
  const f = fixture(t)
  await f.boundary('dictation-start', 0, 'dictation', { session_id: 1, output_path: join(f.directory, 'a.wav') })
  await f.pcm('dictation', 0, 128, 0.1, 1)
  await f.boundary('dictation-stop', 128, 'idle', { session_id: 1 })
  await f.boundary('dictation-start', 0, 'dictation', { session_id: 2, output_path: join(f.directory, 'b.wav') }, 2)
  await f.pcm('dictation', 0, 128, 0.1, 2, 2)
  assert.equal(f.failures.length, 0)
  await f.pcm('dictation', 128, 128, 0.1, 2, 1)
  assert.equal(f.failures.length, 1)
  assert.match(f.failures[0].message, /Stale/)
  assert.equal(existsSync(join(f.directory, 'a.wav')), true)
  assert.equal(existsSync(join(f.directory, 'b.wav')), false)
})

test('stopping before first PCM reports empty recording and creates no file', async (t) => {
  const f = fixture(t)
  await f.boundary('dictation-start', 0, 'dictation', { session_id: 1, output_path: join(f.directory, 'empty.wav') })
  await f.boundary('dictation-stop', 0, 'idle', { session_id: 1 })
  assert.equal(f.events.at(-1)?.type, 'dictation-error')
  assert.deepEqual(readdirSync(f.directory), [])
})

test('invalid samples and unmatched routing commands cannot create usable recordings', async (t) => {
  const f = fixture(t)
  await f.boundary('dictation-start', 0, 'dictation', { session_id: 1, output_path: join(f.directory, 'invalid.wav') })
  await f.pcm('dictation', 0, 128, Number.NaN, 1)
  assert.equal(f.failures.length, 1)
  assert.deepEqual(readdirSync(f.directory), [])
})

test('a canceled or failed start without a routing boundary releases metadata before the next note', async (t) => {
  const f = fixture(t)
  await f.writer.register({
    id: 100,
    type: 'dictation-start',
    session_id: 1,
    output_path: join(f.directory, 'never.wav'),
  })
  await f.writer.acknowledge(100)
  await f.boundary('dictation-cancel', 0, 'idle', { session_id: 1 }, 0)
  await f.boundary('dictation-start', 0, 'dictation', { session_id: 2, output_path: join(f.directory, 'next.wav') })
  await f.pcm('dictation', 0, 128, 0.1, 2)
  await f.boundary('dictation-stop', 128, 'idle', { session_id: 2 })
  assert.equal(f.failures.length, 0)
  assert.equal(existsSync(join(f.directory, 'never.wav')), false)
  assert.equal(existsSync(join(f.directory, 'next.wav')), true)
})

test('a delayed disk write leaves the event loop free and stop waits for all accepted PCM before its result', async (t) => {
  let signalWriting!: () => void
  const writing = new Promise<void>((resolve) => {
    signalWriting = resolve
  })
  let releaseWrite!: () => void
  const release = new Promise<void>((resolve) => {
    releaseWrite = resolve
  })
  t.after(releaseWrite)
  const f = fixture(t)
  const probe = await open(join(f.directory, 'probe'), 'wx')
  const prototype = Object.getPrototypeOf(probe) as {
    write: (
      bytes: Buffer,
      offset: number,
      length: number,
      position: number | null
    ) => Promise<{ bytesWritten: number; buffer: Buffer }>
  }
  const originalWrite = prototype.write
  await probe.close()
  let delayed = false
  t.mock.method(
    prototype,
    'write',
    async function (this: FileHandle, bytes: Buffer, offset: number, length: number, position: number | null) {
      if (!delayed && bytes.length === 512) {
        delayed = true
        signalWriting()
        await release
      }
      return originalWrite.call(this, bytes, offset, length, position)
    }
  )
  await f.boundary('conversation-start', 0, 'conversation', { output_dir: f.directory, chunk_ms: 60000 })
  const first = f.pcm('conversation', 0, 256, 0.25)
  const second = f.pcm('conversation', 256, 128, 0.5)
  const stopped = f.boundary('conversation-stop', 384, 'idle')
  await writing

  let heartbeats = 0
  const timer = setInterval(() => heartbeats++, 5)
  await new Promise((resolve) => setTimeout(resolve, 40))
  clearInterval(timer)
  assert(heartbeats > 0, 'Disk latency must not block UI/main-process timers')
  assert.equal(f.events.filter((event) => event.type === 'chunk').length, 0)

  releaseWrite()
  await Promise.all([first, second, stopped])
  const chunk = f.events.find((event) => event.type === 'chunk')
  assert(chunk)
  assert.equal(chunk.sample_count, 384)
  const wav = readFileSync(String(chunk.path))
  assert.equal(wav.length, 44 + 384 * 2)
  assert.equal(wav.readUInt32LE(40), 384 * 2)
  assert.equal(wav.readInt16LE(44), Math.round(0.25 * 32767))
  assert.equal(wav.readInt16LE(44 + 256 * 2), Math.round(0.5 * 32767))
  assert.equal(f.failures.length, 0)
})

test('partial asynchronous file writes preserve every sample and interruption drains queued PCM once', async (t) => {
  const f = fixture(t)
  const probe = await open(join(f.directory, 'probe'), 'wx')
  const prototype = Object.getPrototypeOf(probe) as {
    write: (
      bytes: Buffer,
      offset: number,
      length: number,
      position: number | null
    ) => Promise<{ bytesWritten: number; buffer: Buffer }>
  }
  const originalWrite = prototype.write
  await probe.close()
  t.mock.method(
    prototype,
    'write',
    function (this: FileHandle, bytes: Buffer, offset: number, length: number, position: number | null) {
      return originalWrite.call(this, bytes, offset, Math.min(length, 31), position)
    }
  )
  await f.boundary('conversation-start', 0, 'conversation', { output_dir: f.directory, chunk_ms: 60000 })
  const first = f.pcm('conversation', 0, 256, 0.25)
  const second = f.pcm('conversation', 256, 128, 0.5)
  const closed = f.writer.dispose(true)
  assert.equal(f.writer.dispose(true), closed)
  await Promise.all([first, second, closed])

  const chunks = f.events.filter((event) => event.type === 'chunk')
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].sample_count, 384)
  const wav = readFileSync(String(chunks[0].path))
  assert.equal(wav.length, 44 + 384 * 2)
  assert.equal(wav.readUInt32LE(40), 384 * 2)
  for (let index = 0; index < 384; index++)
    assert.equal(wav.readInt16LE(44 + index * 2), Math.round((index < 256 ? 0.25 : 0.5) * 32767))
  assert.equal(f.failures.length, 0)
})

test('asynchronous storage failure rejects the recording once and never publishes a successful result', async (t) => {
  const f = fixture(t)
  const probe = await open(join(f.directory, 'probe'), 'wx')
  const prototype = Object.getPrototypeOf(probe) as {
    write: (
      bytes: Buffer,
      offset: number,
      length: number,
      position: number | null
    ) => Promise<{ bytesWritten: number; buffer: Buffer }>
  }
  const originalWrite = prototype.write
  await probe.close()
  t.mock.method(
    prototype,
    'write',
    async function (this: FileHandle, bytes: Buffer, offset: number, length: number, position: number | null) {
      if (bytes.length !== 44) throw new Error('Storage unavailable')
      return originalWrite.call(this, bytes, offset, length, position)
    }
  )
  const path = join(f.directory, 'failed.wav')
  await f.boundary('dictation-start', 0, 'dictation', { session_id: 1, output_path: path })
  const writing = f.pcm('dictation', 0, 128, 0.25, 1)
  const stopped = f.boundary('dictation-stop', 128, 'idle', { session_id: 1 })
  await Promise.all([writing, stopped, f.writer.dispose(true)])

  assert.equal(f.failures.length, 1)
  assert.match(f.failures[0].message, /Storage unavailable/)
  assert.equal(existsSync(path), false)
  assert(!f.events.some((event) => event.type === 'dictation-result' || event.type === 'chunk'))
})
