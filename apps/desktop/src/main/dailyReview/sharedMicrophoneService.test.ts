import assert from 'node:assert/strict'
import { type TestContext, test } from 'node:test'
import type { DictationRecorderEvent } from '@remember/shared'
import { type MicrophoneMessage, SharedMicrophoneService } from './sharedMicrophoneService'

type Command = { id: number; type: string; session_id?: number; output_path?: string }
class Helper {
  readonly commands: Command[] = []
  readonly signals: string[] = []
  defaultSelected = true
  autoRespond = true
  onCommand: ((command: Command) => void) | null = null
  delayClose = false
  private finishClose: (() => void) | null = null
  constructor(
    readonly onMessage: (message: MicrophoneMessage) => void,
    readonly onFailure: (error: Error) => void
  ) {}

  command(message: MicrophoneMessage) {
    const command = message as Command
    this.commands.push(command)
    this.onCommand?.(command)
    if (this.autoRespond) queueMicrotask(() => this.respond(command))
  }

  send(value: MicrophoneMessage) {
    this.onMessage(value)
  }

  ready() {
    this.send({ type: 'ready', microphone_name: 'Built-in', default_input_is_selected: this.defaultSelected })
  }

  respond(command: Command, fields: object = {}) {
    if (command.type === 'conversation-start') this.send({ type: 'conversation-started' })
    this.send({
      type: 'response',
      id: command.id,
      ok: true,
      default_input_is_selected: this.defaultSelected,
      ...fields,
    })
  }

  crash() {
    this.onFailure(new Error('Recorder crashed'))
  }

  dispose() {
    this.signals.push('dispose')
    if (!this.delayClose) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.finishClose = resolve
    })
  }

  closed() {
    this.finishClose?.()
  }
}

function fixture(t: TestContext, { ready = true, timeoutMs = 1000 } = {}) {
  const helpers: Helper[] = []
  const removed: string[] = []
  const reads: string[] = []
  const events: DictationRecorderEvent[] = []
  let paths = 0
  const service = new SharedMicrophoneService({
    createTransport: (onMessage, onFailure) => {
      const helper = new Helper(onMessage, onFailure)
      helpers.push(helper)
      if (ready) queueMicrotask(() => helper.ready())
      return { send: (command) => helper.command(command), dispose: () => helper.dispose() }
    },
    outputPath: () => `/owned/note-${++paths}.wav`,
    readResult: (path) => {
      reads.push(path)
      return new ArrayBuffer(100)
    },
    removeFile: (path) => removed.push(path),
    timeoutMs,
  })
  t.after(() => service.dispose())
  return { service, helpers, removed, reads, events, onEvent: (event: DictationRecorderEvent) => events.push(event) }
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

test('preparing does not subscribe input; conversation stop flushes without stopping an active note', async (t) => {
  const f = fixture(t)
  await f.service.prewarm()
  const helper = f.helpers[0]
  assert.equal(helper.commands.length, 0)
  const chunks: string[] = []
  let ready = false
  const handle = f.service.startConversation('/conversation', 60000, {
    onReady: () => {
      ready = true
    },
    onChunk: (chunk) => chunks.push(chunk.path),
    onError: assert.fail,
  })
  await nextTurn()
  assert.equal(ready, true)
  assert.equal(await f.service.startDictation({ sessionId: 1, forceBuiltInMicrophone: false }, f.onEvent), true)
  helper.send({ type: 'dictation-started', session_id: 1, started_at: 1000 })
  helper.onCommand = (command) => {
    if (command.type === 'conversation-stop') {
      assert.equal(handle.isClosed, false)
      helper.send({
        type: 'chunk',
        path: '/conversation/final.wav',
        started_at: 1,
        duration_ms: 10,
        average_level: 0.2,
        capture_epoch_id: 'epoch',
        sequence: 1,
        sample_count: 160,
        first_sample_time: 0,
      })
    }
  }
  handle.stop()
  await handle.closed
  assert.deepEqual(chunks, ['/conversation/final.wav'])
  assert.deepEqual(helper.signals, [])
  helper.send({ type: 'dictation-level', session_id: 1, level: 0.5 })
  f.service.stopDictation(1)
  helper.send({ type: 'dictation-result', session_id: 1, path: '/owned/note-1.wav', duration_ms: 100 })
  assert.deepEqual(
    f.events.map((event) => event.type),
    ['started', 'level', 'result']
  )
  assert.deepEqual(f.reads, ['/owned/note-1.wav'])
  assert.ok(f.removed.includes('/owned/note-1.wav'))
  assert.deepEqual(
    helper.commands.map((command) => command.type),
    ['conversation-start', 'status', 'dictation-start', 'conversation-stop', 'dictation-stop']
  )
})

test('cancelling while prepare waits never opens input and the next session can start', async (t) => {
  const f = fixture(t, { ready: false })
  const canceled = f.service.startDictation({ sessionId: 1, forceBuiltInMicrophone: false }, f.onEvent)
  f.service.cancelDictation(1)
  f.helpers[0].ready()
  assert.equal(await canceled, false)
  assert.equal(
    f.helpers[0].commands.some((command) => command.type === 'dictation-start'),
    false
  )
  assert.equal(await f.service.startDictation({ sessionId: 2, forceBuiltInMicrophone: false }, f.onEvent), true)
  f.helpers[0].send({ type: 'dictation-started', session_id: 1, started_at: 2 })
  f.helpers[0].send({ type: 'dictation-started', session_id: 2, started_at: 3 })
  assert.deepEqual(f.events, [{ type: 'started', sessionId: 2, startedAt: 3 }])
})

test('cancel ignores stale PCM events and cleans the owned file after native cancellation finishes', async (t) => {
  const f = fixture(t)
  await f.service.startDictation({ sessionId: 1, forceBuiltInMicrophone: false }, f.onEvent)
  const helper = f.helpers[0]
  helper.autoRespond = false
  f.service.cancelDictation(1)
  const command = helper.commands.at(-1)
  assert.equal(command?.type, 'dictation-cancel')
  helper.send({ type: 'dictation-result', session_id: 1, path: '/owned/note-1.wav', duration_ms: 100 })
  assert.deepEqual(f.events, [])
  assert.deepEqual(f.reads, [])
  helper.respond(command as Command)
  await nextTurn()
  assert.ok(f.removed.includes('/owned/note-1.wav'))
})

test('route selection is refreshed, preserves explicit devices, and allows the built-in override', async (t) => {
  const f = fixture(t)
  await f.service.prewarm()
  assert.equal(f.service.defaultInputSelected(), true)
  f.helpers[0].defaultSelected = false
  assert.equal(await f.service.startDictation({ sessionId: 1, forceBuiltInMicrophone: false }, f.onEvent), false)
  assert.equal(f.service.defaultInputSelected(), false)
  assert.equal(
    await f.service.startDictation({ sessionId: 1, forceBuiltInMicrophone: false, microphoneId: 'usb' }, f.onEvent),
    false
  )
  assert.equal(
    await f.service.startDictation({ sessionId: 1, forceBuiltInMicrophone: true, microphoneId: 'usb' }, f.onEvent),
    true
  )
})

test('recorder crash closes leases, reports interruption, and stale process events cannot affect the replacement', async (t) => {
  const f = fixture(t)
  const failures: string[] = []
  const lease = f.service.startConversation('/conversation', 60000, {
    onReady: () => {},
    onChunk: () => {},
    onError: (_code, message) => failures.push(message),
  })
  await nextTurn()
  await f.service.startDictation({ sessionId: 1, forceBuiltInMicrophone: false }, f.onEvent)
  const first = f.helpers[0]
  first.crash()
  await lease.closed
  assert.equal(failures.length, 1)
  assert.equal(f.events.filter((event) => event.type === 'error').length, 1)
  assert.equal(await f.service.startDictation({ sessionId: 2, forceBuiltInMicrophone: false }, f.onEvent), true)
  assert.equal(f.helpers.length, 2)
  first.send({ type: 'dictation-started', session_id: 2, started_at: 50 })
  assert.equal(
    f.events.some((event) => event.type === 'started'),
    false
  )
  f.helpers[1].send({ type: 'dictation-started', session_id: 2, started_at: 100 })
  assert.equal(f.events.at(-1)?.type, 'started')
})

test('native results cannot read or delete arbitrary recorder paths', async (t) => {
  const f = fixture(t)
  await f.service.startDictation({ sessionId: 1, forceBuiltInMicrophone: false }, f.onEvent)
  f.helpers[0].send({ type: 'dictation-result', session_id: 1, path: '/private/unrelated.wav', duration_ms: 100 })
  assert.deepEqual(f.reads, [])
  assert.deepEqual(f.removed, ['/owned/note-1.wav'])
  assert.equal(f.events.at(-1)?.type, 'error')
})

test('command timeout terminates the recorder and closes every lease', async (t) => {
  const f = fixture(t, { timeoutMs: 20 })
  await f.service.prewarm()
  f.helpers[0].autoRespond = false
  const errors: string[] = []
  const lease = f.service.startConversation('/conversation', 60000, {
    onReady: assert.fail,
    onChunk: () => assert.fail(),
    onError: (_code, message) => errors.push(message),
  })
  await lease.closed
  assert.equal(errors.length, 1)
  assert.match(errors[0], /timed out/)
  assert.deepEqual(f.helpers[0].signals, ['dispose'])
})

test('queued replacement waits for the old final chunk and stop acknowledgment', async (t) => {
  const f = fixture(t)
  const order: string[] = []
  const a = f.service.startConversation('/a', 60000, {
    onReady: () => order.push('a-ready'),
    onChunk: () => order.push('a-chunk'),
    onError: assert.fail,
  })
  await nextTurn()
  const helper = f.helpers[0]
  helper.autoRespond = false
  a.stop()
  const b = f.service.startConversation('/b', 60000, {
    onReady: () => order.push('b-ready'),
    onChunk: () => order.push('b-chunk'),
    onError: assert.fail,
  })
  await nextTurn()
  assert.equal(helper.commands.at(-1)?.type, 'conversation-stop')
  helper.send({ type: 'chunk', path: '/a/final.wav' })
  helper.respond(helper.commands.at(-1) as Command)
  await a.closed
  await nextTurn()
  assert.equal(helper.commands.at(-1)?.type, 'conversation-start')
  helper.respond(helper.commands.at(-1) as Command)
  await nextTurn()
  assert.deepEqual(order, ['a-ready', 'a-chunk', 'b-ready'])
  helper.autoRespond = true
  b.stop()
  await b.closed
})

test('conversation ready requires retained PCM, and pause notification follows the last preceding chunk', async (t) => {
  const f = fixture(t)
  await f.service.prewarm()
  const helper = f.helpers[0]
  helper.autoRespond = false
  const order: string[] = []
  const lease = f.service.startConversation('/conversation', 60000, {
    onReady: () => order.push('ready'),
    onChunk: () => order.push('chunk'),
    onPaused: () => order.push('flush-transcription'),
    onError: assert.fail,
  })
  await nextTurn()
  helper.send({ type: 'response', id: helper.commands[0].id, ok: true })
  await nextTurn()
  assert.equal(order.length, 0)
  helper.send({ type: 'conversation-started' })
  helper.send({ type: 'chunk', path: '/conversation/before-note.wav' })
  helper.send({ type: 'conversation-paused' })
  helper.send({ type: 'chunk', path: '/conversation/after-note.wav' })
  assert.deepEqual(order, ['ready', 'chunk', 'flush-transcription', 'chunk'])
  helper.autoRespond = true
  lease.stop()
  await lease.closed
})

test('explicit built-in labels map only the exact known device, including Chromium suffix', async (t) => {
  const f = fixture(t)
  await f.service.prewarm()
  f.helpers[0].defaultSelected = false
  assert.equal(
    await f.service.startDictation(
      {
        sessionId: 1,
        forceBuiltInMicrophone: false,
        microphoneId: 'external',
        microphoneLabel: 'Built-in USB',
      },
      f.onEvent
    ),
    false
  )
  assert.equal(
    await f.service.startDictation(
      {
        sessionId: 2,
        forceBuiltInMicrophone: false,
        microphoneId: 'builtin',
        microphoneLabel: 'Built-in (Built-in)',
      },
      f.onEvent
    ),
    true
  )
})

test('an explicitly selected Chromium built-in input reuses the shared stream when both labels have the suffix', async (t) => {
  const f = fixture(t)
  await f.service.prewarm()
  const helper = f.helpers[0]
  helper.defaultSelected = false
  helper.autoRespond = false
  helper.onCommand = (command) => helper.respond(command, { microphone_name: 'MacBook Pro Microphone (Built-in)' })
  const accepted = await f.service.startDictation(
    {
      sessionId: 1,
      forceBuiltInMicrophone: false,
      microphoneId: 'configured-laptop-microphone',
      microphoneLabel: 'MacBook Pro Microphone (Built-in)',
    },
    f.onEvent
  )
  assert.equal(accepted, true, 'The selected physical microphone should not fall back to a second capture stream')
  assert.deepEqual(
    helper.commands.map((command) => command.type),
    ['status', 'dictation-start']
  )
})

test('identically named external microphones do not reuse a stream selected in another renderer partition', async (t) => {
  const f = fixture(t)
  await f.service.prewarm()
  const helper = f.helpers[0]
  helper.autoRespond = false
  helper.onCommand = (command) => helper.respond(command, { microphone_name: 'USB Podcast Microphone' })
  const accepted = await f.service.startDictation(
    {
      sessionId: 1,
      forceBuiltInMicrophone: false,
      microphoneId: 'second-usb-device-in-dictation-partition',
      microphoneLabel: 'USB Podcast Microphone',
    },
    f.onEvent
  )
  assert.equal(accepted, false, 'The legacy recorder must resolve the exact external device ID')
  assert.deepEqual(
    helper.commands.map((command) => command.type),
    ['status']
  )
})

test('startup failure reports its waiting conversation and cannot leave a hanging lease', async (t) => {
  const f = fixture(t, { ready: false, timeoutMs: 20 })
  const errors: string[] = []
  const lease = f.service.startConversation('/conversation', 60000, {
    onReady: assert.fail,
    onChunk: () => assert.fail(),
    onError: (_code, message) => errors.push(message),
  })
  await lease.closed
  assert.equal(errors.length, 1)
  assert.match(errors[0], /did not become ready/)
})

test('a failed recorder must release input before a conversation lease releases input', async (t) => {
  const f = fixture(t, { timeoutMs: 20 })
  await f.service.prewarm()
  const helper = f.helpers[0]
  helper.autoRespond = false
  let interrupted = false
  helper.delayClose = true
  const lease = f.service.startConversation('/conversation', 60000, {
    onReady: assert.fail,
    onChunk: () => assert.fail(),
    onError: () => {
      interrupted = true
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(interrupted, true)
  assert.equal(lease.isClosed, false)
  helper.closed()
  await lease.closed
  assert.equal(lease.isClosed, true)
})

test('a conversation retry queued during failed transport shutdown acquires input after it closes', async (t) => {
  const f = fixture(t)
  const failures: string[] = []
  const callbacks = {
    onReady: () => {},
    onChunk: () => {},
    onError: (_code: string, message: string) => failures.push(message),
  }
  const first = f.service.startConversation('/first', 60000, callbacks)
  await nextTurn()
  f.helpers[0].delayClose = true
  f.helpers[0].crash()
  const retry = f.service.startConversation('/retry', 60000, callbacks)
  await nextTurn()
  assert.equal(first.isClosed, false)
  assert.equal(f.helpers.length, 1, 'Retry must wait for the old input to be released')
  f.helpers[0].closed()
  await first.closed
  await nextTurn()
  assert.equal(f.helpers.length, 2)
  assert.equal(f.helpers[1].commands[0]?.type, 'conversation-start')
  assert.deepEqual(failures, ['Recorder crashed'])
  retry.stop()
  await retry.closed
})

test('disposal waits for the microphone renderer and rejects reacquisition', async (t) => {
  const f = fixture(t)
  await f.service.prewarm()
  f.helpers[0].delayClose = true
  let finished = false
  const closed = f.service.dispose()
  void closed.then(() => {
    finished = true
  })
  await nextTurn()
  assert.equal(finished, false)
  assert.equal(f.service.dispose(), closed)
  await assert.rejects(f.service.prewarm(), /disposed/)
  f.helpers[0].closed()
  await closed
  assert.equal(finished, true)
})
