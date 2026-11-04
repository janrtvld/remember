// The browser performs echo cancellation, noise suppression and filtered
// resampling before these 16 kHz samples reach this processor.
const packetFrames = 256
// About two seconds of audio (128 KiB) tolerate brief main-process stalls.
const bufferCount = 128
const commandLimit = 64

class RememberMicrophoneProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.route = 'idle'
    this.sessionId = undefined
    this.pending = []
    this.pool = Array.from({ length: bufferCount }, () => new Float32Array(packetFrames))
    this.buffer = null
    this.count = 0
    this.frame = 0
    this.inFlight = 0
    this.firstPacket = true
    this.failed = false
    this.port.onmessage = ({ data }) => this.receive(data)
    if (sampleRate !== 16_000) this.fail('Microphone processing requires a 16 kHz audio context')
  }

  receive(message) {
    if (this.failed) return
    if (message?.type === 'recycle') {
      if (
        !(message.buffer instanceof ArrayBuffer) ||
        message.buffer.byteLength !== packetFrames * 4 ||
        this.inFlight === 0
      ) {
        this.fail('Invalid microphone buffer acknowledgement')
        return
      }
      this.inFlight -= 1
      this.pool.push(new Float32Array(message.buffer))
      return
    }
    if (
      message?.type !== 'set-route' ||
      !Number.isSafeInteger(message.id) ||
      !['idle', 'conversation', 'dictation'].includes(message.route) ||
      typeof message.action !== 'string' ||
      (message.route === 'dictation' && !Number.isSafeInteger(message.sessionId))
    ) {
      this.fail('Invalid microphone route command')
      return
    }
    if (this.pending.length >= commandLimit) {
      this.fail('Microphone control queue exceeded its limit')
      return
    }
    this.pending.push(message)
  }

  fail(message) {
    if (this.failed) return
    this.failed = true
    this.route = 'idle'
    this.sessionId = undefined
    this.pending.length = 0
    this.count = 0
    this.buffer = null
    this.port.postMessage({ type: 'error', message })
  }

  flush() {
    if (!this.buffer || this.count === 0) return
    // A first/partial packet still transfers a fixed-size buffer. Clear its
    // unused tail so a recycled buffer cannot expose the previous consumer.
    this.buffer.fill(0, this.count)
    const samples = this.buffer.buffer
    this.port.postMessage(
      {
        type: 'pcm',
        consumer: this.route,
        ...(this.route === 'dictation' ? { session_id: this.sessionId } : {}),
        frame: this.frame,
        samples,
        count: this.count,
      },
      [samples]
    )
    this.inFlight += 1
    this.buffer = null
    this.count = 0
    this.firstPacket = false
  }

  process(inputs, outputs) {
    // Keep the node connected so Chromium schedules it, without monitoring the
    // microphone through the speakers or introducing acoustic feedback.
    for (const output of outputs) {
      for (const channel of output) channel.fill(0)
    }
    if (this.failed) return true

    // Route changes happen only between render quanta. Flush old PCM before
    // acknowledging the boundary so the main process can close that sink first.
    while (this.pending.length > 0) {
      const command = this.pending.shift()
      this.flush()
      const sessionId = command.route === 'dictation' ? command.sessionId : undefined
      if (command.route !== this.route || sessionId !== this.sessionId) this.firstPacket = true
      this.route = command.route
      this.sessionId = sessionId
      this.port.postMessage({
        type: 'boundary',
        id: command.id,
        action: command.action,
        frame: currentFrame,
        route: this.route,
        ...(this.route === 'dictation' ? { sessionId: this.sessionId } : {}),
      })
    }
    const input = inputs[0]?.[0]
    if (this.route === 'idle' || !input?.length) return true

    let offset = 0
    while (offset < input.length) {
      if (!this.buffer) {
        this.buffer = this.pool.pop()
        if (!this.buffer) {
          // A stalled consumer must fail explicitly rather than grow an
          // unbounded queue or return an apparently successful truncated note.
          this.fail('Microphone audio consumer could not keep up')
          return true
        }
        this.frame = currentFrame + offset
      }
      const target = this.firstPacket ? 128 : packetFrames
      const length = Math.min(target - this.count, input.length - offset)
      for (let index = 0; index < length; index += 1) this.buffer[this.count + index] = input[offset + index]
      this.count += length
      offset += length
      if (this.count === target) this.flush()
    }
    return true
  }
}

registerProcessor('remember-microphone', RememberMicrophoneProcessor)
