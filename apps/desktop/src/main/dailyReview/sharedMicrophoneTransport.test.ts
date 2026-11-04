import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { type FileHandle, open } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { MicrophoneMessage, MicrophoneTransport } from './sharedMicrophoneService'

const ipcMain = new EventEmitter()
let captureWindow: FakeCaptureWindow
let microphonePermission = 'denied'
let finishPreparation: ((error: Error | null, stdout: string) => void) | null = null

class FakeCaptureWindow extends EventEmitter {
  loads = 0
  sent: { channel: string; value: unknown }[] = []
  webContents = Object.assign(new EventEmitter(), {
    send: (channel: string, value: unknown) => this.sent.push({ channel, value }),
    setWindowOpenHandler() {},
  })
  private destroyed = false

  static getAllWindows() {
    return captureWindow ? [captureWindow] : []
  }

  constructor() {
    super()
    captureWindow = this
  }

  loadFile() {
    this.loads++
    return Promise.resolve()
  }

  isDestroyed() {
    return this.destroyed
  }

  destroy() {
    this.destroyed = true
    this.emit('closed')
  }
}

// Keep the production transport and disk writer; replace only Electron's window/IPC surface.
const mockKey = '__rememberMicrophoneElectronTest'
Object.assign(globalThis, {
  [mockKey]: {
    app: { isPackaged: false, getAppPath: () => '/remember-test' },
    systemPreferences: { getMediaAccessStatus: () => microphonePermission },
    execFile: (
      executable: string,
      args: string[],
      options: { timeout: number },
      callback: (error: Error | null, stdout: string) => void
    ) => {
      assert.equal(executable, '/remember-test/native/microphone-audio-capture')
      assert.deepEqual(args, ['--configure-microphone-mode'])
      assert.equal(options.timeout, 8_000)
      finishPreparation = callback
    },
    BrowserWindow: FakeCaptureWindow,
    ipcMain,
    session: { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }) },
  },
})
const moduleHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'node:child_process') return { url: 'remember-test:microphone-helper', shortCircuit: true }
    return specifier === 'electron'
      ? { url: 'remember-test:electron-microphone', shortCircuit: true }
      : nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'remember-test:microphone-helper')
      return { format: 'module', source: `export const { execFile } = globalThis.${mockKey}`, shortCircuit: true }
    return url === 'remember-test:electron-microphone'
      ? {
          format: 'module',
          source: `export const { app, systemPreferences, BrowserWindow, ipcMain, session } = globalThis.${mockKey}`,
          shortCircuit: true,
        }
      : nextLoad(url, context)
  },
})

const { createSharedMicrophoneTransport } = await import('./sharedMicrophoneTransport')
moduleHooks.deregister()
Reflect.deleteProperty(globalThis, mockKey)
// The packaged main process supplies __dirname; this source-level test uses an unloaded fake window.
const previousDirname = Object.getOwnPropertyDescriptor(globalThis, '__dirname')
Object.defineProperty(globalThis, '__dirname', { configurable: true, value: import.meta.dirname })
after(() => {
  if (previousDirname) Object.defineProperty(globalThis, '__dirname', previousDirname)
  else Reflect.deleteProperty(globalThis, '__dirname')
})

test('wall-clock corrections do not interrupt valid PCM; a real monotonic stall retains the prefix once', async (t) => {
  let wallTime = 1_700_000_000_000
  let elapsed = 0
  t.mock.method(Date, 'now', () => wallTime)
  t.mock.method(performance, 'now', () => elapsed)
  t.mock.timers.enable({ apis: ['setInterval'] })
  const directory = mkdtempSync(join(tmpdir(), 'remember-microphone-watchdog-'))
  const events: MicrophoneMessage[] = []
  const failures: Error[] = []
  let transport: MicrophoneTransport
  transport = createSharedMicrophoneTransport(
    (message) => events.push(message),
    (error) => {
      failures.push(error)
      void transport.dispose()
    }
  )
  t.after(async () => {
    await transport.dispose()
    rmSync(directory, { recursive: true, force: true })
  })
  const deliver = async (message: MicrophoneMessage) => {
    for (const listener of ipcMain.listeners('remember:microphone:event'))
      await listener({ sender: captureWindow.webContents }, message)
  }
  const pcm = (frame: number) =>
    deliver({
      type: 'pcm',
      packet_id: frame,
      consumer: 'conversation',
      frame,
      samples: new Float32Array(128).fill(0.25).buffer,
      count: 128,
      stream_id: 1,
      started_at: wallTime,
    })
  transport.send({ id: 1, type: 'conversation-start', output_dir: directory, chunk_ms: 60_000 })
  await deliver({
    type: 'boundary',
    id: 1,
    action: 'conversation-start',
    frame: 0,
    route: 'conversation',
    stream_id: 1,
  })
  await pcm(0)
  const levelEvent = captureWindow.sent.find((event) => event.channel === 'remember:recording-audio-level')
  assert(levelEvent)
  assert.deepEqual(Object.keys(levelEvent.value as object), ['source', 'level', 'at'])
  assert.equal((levelEvent.value as { source: string }).source, 'microphone')
  assert.equal((levelEvent.value as { level: number }).level, 1)

  wallTime += 60_000
  elapsed += 1_000
  t.mock.timers.tick(1_000)
  assert.equal(failures.length, 0, 'A wall-clock jump must not tear down a healthy capture')
  await pcm(128)

  elapsed += 3_000
  t.mock.timers.tick(1_000)
  assert.equal(failures.length, 0, 'A delayed watchdog must allow queued PCM to arrive first')
  await pcm(256)

  wallTime -= 120_000
  elapsed += 1_000
  t.mock.timers.tick(1_000)
  elapsed += 1_001
  t.mock.timers.tick(1_000)
  await transport.dispose()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(failures.length, 1, 'A real audio stall must still fail when the wall clock moves backward')
  assert.match(failures[0].message, /stopped delivering audio/)
  const chunks = events.filter((event) => event.type === 'chunk')
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].sample_count, 384)
  const wav = readFileSync(String(chunks[0].path))
  assert.equal(wav.length, 44 + 384 * 2)
  assert.equal(wav.readUInt32LE(40), 384 * 2)
  assert.equal(wav.readInt16LE(44), Math.round(0.25 * 32767))
  elapsed += 5_000
  t.mock.timers.tick(5_000)
  assert.equal(failures.length, 1)
  assert.equal(events.filter((event) => event.type === 'chunk').length, 1)
  assert.equal(ipcMain.listenerCount('remember:microphone:event'), 0)
})

test('invalid PCM fails capture without publishing an audio level or acknowledgement', async (t) => {
  microphonePermission = 'denied'
  const directory = mkdtempSync(join(tmpdir(), 'remember-microphone-invalid-level-'))
  const failures: Error[] = []
  const transport = createSharedMicrophoneTransport(
    () => {},
    (error) => failures.push(error)
  )
  t.after(async () => {
    await transport.dispose()
    rmSync(directory, { recursive: true, force: true })
  })
  transport.send({ id: 1, type: 'conversation-start', output_dir: directory, chunk_ms: 60_000 })
  const deliver = async (message: MicrophoneMessage) => {
    for (const listener of ipcMain.listeners('remember:microphone:event'))
      await listener({ sender: captureWindow.webContents }, message)
  }
  await deliver({
    type: 'boundary',
    id: 1,
    action: 'conversation-start',
    frame: 0,
    route: 'conversation',
    stream_id: 1,
  })
  const sentBefore = captureWindow.sent.length
  await deliver({
    type: 'pcm',
    packet_id: 1,
    consumer: 'conversation',
    frame: 0,
    samples: new Float32Array([0.25]).buffer,
    count: 128,
    stream_id: 1,
    started_at: Date.now(),
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(failures.length, 1)
  assert.match(failures[0].message, /Invalid microphone PCM block/)
  assert.equal(captureWindow.sent.length, sentBefore)
})

test('disposing while native mode preparation is pending never reopens the capture window', async () => {
  microphonePermission = 'granted'
  const transport = createSharedMicrophoneTransport(
    () => {},
    (error) => assert.fail(error)
  )
  const window = captureWindow
  assert.equal(window.loads, 0)
  assert(finishPreparation)
  await transport.dispose()
  finishPreparation(null, JSON.stringify({ type: 'configured', voice_processing_bypassed: true, running: false }))
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(window.loads, 0)
  assert.equal(window.isDestroyed(), true)
})

test('PCM recycling and stop response wait for asynchronous storage and the final retained chunk', async (t) => {
  let writing!: () => void
  const started = new Promise<void>((resolve) => {
    writing = resolve
  })
  let release!: () => void
  const writable = new Promise<void>((resolve) => {
    release = resolve
  })
  t.after(release)
  microphonePermission = 'denied'
  const directory = mkdtempSync(join(tmpdir(), 'remember-microphone-ack-order-'))
  const probe = await open(join(directory, 'probe'), 'wx')
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
      if (bytes.length !== 44) {
        writing()
        await writable
      }
      return originalWrite.call(this, bytes, offset, length, position)
    }
  )
  const events: MicrophoneMessage[] = []
  const transport = createSharedMicrophoneTransport(
    (message) => events.push(message),
    (error) => assert.fail(error)
  )
  t.after(async () => {
    await transport.dispose()
    rmSync(directory, { recursive: true, force: true })
  })
  const deliver = async (message: MicrophoneMessage) => {
    for (const listener of ipcMain.listeners('remember:microphone:event'))
      await listener({ sender: captureWindow.webContents }, message)
  }
  transport.send({ id: 1, type: 'conversation-start', output_dir: directory, chunk_ms: 60_000 })
  await deliver({
    type: 'boundary',
    id: 1,
    action: 'conversation-start',
    frame: 0,
    route: 'conversation',
    stream_id: 1,
  })
  const pending = deliver({
    type: 'pcm',
    packet_id: 9,
    consumer: 'conversation',
    frame: 0,
    samples: new Float32Array(128).fill(0.25).buffer,
    count: 128,
    stream_id: 1,
    started_at: Date.now(),
  })
  await started
  transport.send({ id: 2, type: 'conversation-stop' })
  const boundary = deliver({
    type: 'boundary',
    id: 2,
    action: 'conversation-stop',
    frame: 128,
    route: 'idle',
    stream_id: 1,
  })
  const response = deliver({ type: 'response', id: 2, ok: true })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert(!captureWindow.sent.some((event) => event.channel === 'remember:microphone:consumed'))
  assert(!events.some((event) => event.type === 'chunk' || event.type === 'response'))

  release()
  await Promise.all([pending, boundary, response])
  assert(captureWindow.sent.some((event) => event.channel === 'remember:microphone:consumed' && event.value === 9))
  assert.deepEqual(
    events.map((event) => event.type),
    ['conversation-started', 'chunk', 'response']
  )
  assert.equal(events[1].sample_count, 128)
  assert.equal(readFileSync(String(events[1].path)).readUInt32LE(40), 256)
})
