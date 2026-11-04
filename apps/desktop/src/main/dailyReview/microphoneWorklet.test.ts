import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

type Route = 'conversation' | 'dictation' | 'idle'
type Message = {
  type: string
  id?: number
  action?: string
  route?: Route
  consumer?: Route
  session_id?: number
  frame?: number
  count?: number
  samples?: ArrayBuffer
  message?: string
}
type Processor = {
  port: { onmessage: (event: { data: unknown }) => void }
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean
}

function harness(rate = 16_000) {
  const messages: Message[] = []
  let createProcessor: (() => Processor) | undefined
  const globals = {
    currentFrame: 0,
    sampleRate: rate,
    Float32Array,
    ArrayBuffer,
    AudioWorkletProcessor: class {
      port = {
        onmessage: (_event: { data: unknown }) => {},
        postMessage: (message: Message, transfer: ArrayBuffer[] = []) => {
          // Real ownership transfer catches accidental detached-buffer reuse.
          messages.push(structuredClone(message, { transfer }))
        },
      }
    },
    registerProcessor: (name: string, ProcessorClass: new () => Processor) => {
      assert.equal(name, 'remember-microphone')
      createProcessor = () => new ProcessorClass()
    },
  }
  runInNewContext(readFileSync(new URL('../../../resources/microphone-worklet.js', import.meta.url), 'utf8'), globals)
  assert(createProcessor)
  const processor = createProcessor()
  const receive = (data: unknown) => processor.port.onmessage({ data })
  let commandId = 0
  return {
    messages,
    route(route: Route, sessionId?: number, action = 'test') {
      receive({ type: 'set-route', id: ++commandId, route, sessionId, action })
      return commandId
    },
    process(value: number, length = 128) {
      const output = new Float32Array(length).fill(1)
      assert.equal(processor.process([[new Float32Array(length).fill(value)]], [[output]]), true)
      assert(
        output.every((sample) => sample === 0),
        'Microphone must never play through the speakers'
      )
      globals.currentFrame += length
    },
    recycle(packet: Message) {
      assert(packet.samples)
      receive({ type: 'recycle', buffer: structuredClone(packet.samples, { transfer: [packet.samples] }) })
    },
    pcm() {
      return messages.filter((message) => message.type === 'pcm')
    },
  }
}

function samples(packet: Message) {
  assert(packet.samples)
  return Array.from(new Float32Array(packet.samples).subarray(0, packet.count))
}

test('shared microphone routes each sample once and flushes old PCM before the note boundary', () => {
  const h = harness()
  h.process(9) // Idle samples never enter either consumer.
  h.route('conversation')
  h.process(1) // Immediate first packet.
  h.process(2) // Partial second packet.
  const begin = h.route('dictation', 7, 'dictation-start')
  h.process(3)
  h.process(4)
  const end = h.route('conversation', undefined, 'dictation-stop')
  h.process(5)
  h.route('idle')
  h.process(9)
  const packets = h.pcm()
  assert.deepEqual(
    packets.map((packet) => [packet.consumer, packet.session_id, packet.frame, packet.count]),
    [
      ['conversation', undefined, 128, 128],
      ['conversation', undefined, 256, 128],
      ['dictation', 7, 384, 128],
      ['dictation', 7, 512, 128],
      ['conversation', undefined, 640, 128],
    ]
  )
  assert.deepEqual(
    packets.flatMap(samples),
    [1, 2, 3, 4, 5].flatMap((value) => Array(128).fill(value))
  )
  assert(h.messages.indexOf(packets[1]) < h.messages.findIndex((message) => message.id === begin))
  assert(h.messages.indexOf(packets[3]) < h.messages.findIndex((message) => message.id === end))
})

test('an unchanged note route acknowledges other actions without restarting or duplicating audio', () => {
  const h = harness()
  h.route('dictation', 2)
  h.process(1)
  h.process(2)
  const stopConversation = h.route('dictation', 2, 'conversation-stop')
  h.process(3)
  h.process(4)
  const packets = h.pcm()
  assert.deepEqual(
    packets.map((packet) => [packet.frame, packet.count]),
    [
      [0, 128],
      [128, 128],
      [256, 256],
    ]
  )
  assert.deepEqual(
    packets.flatMap(samples),
    [1, 2, 3, 4].flatMap((value) => Array(128).fill(value))
  )
  assert.equal(h.messages.find((message) => message.id === stopConversation)?.action, 'conversation-stop')
})

test('start and cancel before a render quantum retain no note samples', () => {
  const h = harness()
  h.route('conversation')
  h.process(1)
  const start = h.route('dictation', 1, 'dictation-start')
  const cancel = h.route('conversation', undefined, 'dictation-cancel')
  h.process(2)
  assert(!h.pcm().some((packet) => packet.consumer === 'dictation'))
  assert.equal(h.messages.find((message) => message.id === start)?.frame, 128)
  assert.equal(h.messages.find((message) => message.id === cancel)?.frame, 128)
})

test('recycled buffers support long recordings and erase stale samples in partial packets', () => {
  const h = harness()
  h.route('conversation')
  let nextPacket = 0
  let total = 0
  for (let index = 0; index < 2_000; index += 1) {
    if (index % 3 === 0) h.route(index % 2 ? 'conversation' : 'dictation', index)
    h.process(index)
    const packets = h.pcm()
    while (nextPacket < packets.length) {
      const packet = packets[nextPacket++]
      total += packet.count ?? 0
      assert(packet.samples)
      assert(new Float32Array(packet.samples).subarray(packet.count).every((sample) => sample === 0))
      h.recycle(packet)
    }
  }
  h.route('idle')
  h.process(0)
  total += h
    .pcm()
    .slice(nextPacket)
    .reduce((sum, packet) => sum + (packet.count ?? 0), 0)
  assert.equal(total, 2_000 * 128)
  assert(!h.messages.some((message) => message.type === 'error'))
})

test('a 750 ms acknowledgement delay recovers with every sample retained in order', () => {
  const h = harness()
  h.route('dictation', 17)
  // 94 render quanta = 752 ms. Main-process storage is stalled, so none of
  // these buffers can be acknowledged/recycled yet.
  for (let quantum = 0; quantum < 94; quantum += 1) h.process(quantum)
  assert(!h.messages.some((message) => message.type === 'error'))
  const retained: number[] = []
  let nextPacket = 0
  let nextFrame = 0
  const acknowledge = () => {
    const packets = h.pcm()
    while (nextPacket < packets.length) {
      const packet = packets[nextPacket++]
      assert.equal(packet.frame, nextFrame)
      assert.equal(packet.session_id, 17)
      retained.push(...samples(packet))
      nextFrame += packet.count ?? 0
      h.recycle(packet)
    }
  }
  acknowledge()
  // Recording continues normally once the storage stall has ended.
  for (let quantum = 94; quantum < 300; quantum += 1) {
    h.process(quantum)
    acknowledge()
  }
  h.route('idle')
  h.process(-1)
  acknowledge()
  assert.deepEqual(retained, Array.from({ length: 300 }, (_, value) => Array(128).fill(value)).flat())
  assert.equal(nextFrame, 300 * 128)
  assert(!h.messages.some((message) => message.type === 'error'))
})

test('a stalled consumer fails once at the bounded pool limit and stops retaining samples', () => {
  const h = harness()
  h.route('dictation', 1)
  for (let index = 0; index < 300; index += 1) h.process(1)
  assert.equal(h.pcm().length, 128)
  assert.equal(h.messages.filter((message) => message.type === 'error').length, 1)
  assert.match(h.messages.find((message) => message.type === 'error')?.message ?? '', /could not keep up/)
  h.route('conversation')
  h.process(2)
  assert.equal(h.pcm().length, 128)
})

test('wrong sample rates and unbounded control traffic fail explicitly', () => {
  const wrongRate = harness(48_000)
  assert.match(wrongRate.messages[0].message ?? '', /16 kHz/)
  const h = harness()
  for (let index = 0; index < 65; index += 1) h.route('conversation')
  h.process(1)
  assert.match(h.messages.find((message) => message.type === 'error')?.message ?? '', /control queue/)
  assert.equal(h.pcm().length, 0)
})
