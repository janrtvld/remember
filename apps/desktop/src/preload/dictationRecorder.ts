import type { DictationRecorderCommand, DictationRecorderEvent } from '@remember/shared'
import { play as playCue } from 'cuelume'
import { ipcRenderer } from 'electron'

// Sandboxed preloads must be self-contained; no shared output chunks can be required.
const commandChannel: typeof import('@remember/shared').DICTATION_CHANNELS.recorderCommand =
  'remember:dictation-recorder:command'
const eventChannel: typeof import('@remember/shared').DICTATION_CHANNELS.recorderEvent =
  'remember:dictation-recorder:event'

let active: { sessionId: number; stop: boolean; cancelled: boolean } | null = null
let context: AudioContext | null = null
let media: MediaStream | null = null
let processor: ScriptProcessorNode | null = null
let source: MediaStreamAudioSourceNode | null = null
let mute: GainNode | null = null
let chunks: Float32Array[] = []
let startedAt = 0
let lastLevelAt = 0
let sampleCount = 0
const BUILT_IN = /\b(macbook|imac|mac pro|mac mini|mac studio|studio display|built-in|internal|ingebouwd|interne)\b/i

function send(event: DictationRecorderEvent) {
  ipcRenderer.send(eventChannel, event)
}

async function publishDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    send({
      type: 'devices',
      devices: devices
        .filter((device) => device.kind === 'audioinput' && !['default', 'communications'].includes(device.deviceId))
        .map((device, index) => ({ id: device.deviceId, label: device.label || `Microphone ${index + 1}` })),
    })
  } catch {
    send({ type: 'devices', devices: [] })
  }
}

function cleanup() {
  active = null
  processor?.disconnect()
  source?.disconnect()
  mute?.disconnect()
  media?.getTracks().forEach((track) => {
    track.stop()
  })
  void context?.close().catch(() => undefined)
  processor = null
  source = null
  mute = null
  context = null
  media = null
  chunks = []
  sampleCount = 0
}

function encodeWav(samples: Float32Array, sampleRate: number) {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index))
  }
  text(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  text(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, samples[index]))
    view.setInt16(44 + index * 2, sample * (sample < 0 ? 32768 : 32767), true)
  }
  return buffer
}

function stop(sessionId: number) {
  if (!active || active.sessionId !== sessionId) return
  active.stop = true
  if (!processor) return
  const samples = new Float32Array(sampleCount)
  let offset = 0
  for (const chunk of chunks) {
    samples.set(chunk, offset)
    offset += chunk.length
  }
  const sampleRate = context?.sampleRate ?? 16_000
  const wav = encodeWav(samples, sampleRate)
  cleanup()
  send({ type: 'result', sessionId, wav, durationMs: (samples.length / sampleRate) * 1000 })
}

async function start(command: Extract<DictationRecorderCommand, { type: 'start' }>) {
  if (active) return
  const capture = { sessionId: command.sessionId, stop: false, cancelled: false }
  active = capture
  try {
    let microphoneId = command.microphoneId
    if (command.forceBuiltInMicrophone) {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const microphones = devices.filter(
        (device) => device.kind === 'audioinput' && !['default', 'communications'].includes(device.deviceId)
      )
      const outputGroups = new Set(
        devices
          .filter((device) => device.kind === 'audiooutput' && device.groupId && BUILT_IN.test(device.label))
          .map((device) => device.groupId)
      )
      const builtIn =
        microphones.find((device) => BUILT_IN.test(device.label)) ??
        microphones.find((device) => device.groupId && outputGroups.has(device.groupId))
      if (builtIn) microphoneId = builtIn.deviceId
    }
    const audio = {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    }
    // Start the audio context while the OS opens the microphone. This starts only
    // after an explicit recording command and never keeps an idle input open.
    context = new AudioContext({ sampleRate: 16_000, latencyHint: 'interactive' })
    const contextReady = context.resume().then(
      () => null,
      (error: unknown) => ({ error })
    )
    try {
      media = await navigator.mediaDevices.getUserMedia({
        audio: { ...audio, ...(microphoneId ? { deviceId: { exact: microphoneId } } : {}) },
      })
    } catch (error) {
      if (
        !microphoneId ||
        !(error instanceof DOMException) ||
        !['NotFoundError', 'OverconstrainedError'].includes(error.name)
      )
        throw error
      media = await navigator.mediaDevices.getUserMedia({ audio })
    }
    if (capture.cancelled) {
      cleanup()
      return
    }
    const contextFailure = await contextReady
    if (contextFailure) throw contextFailure.error
    if (capture.cancelled) {
      cleanup()
      return
    }
    source = context.createMediaStreamSource(media)
    processor = context.createScriptProcessor(256, 1, 1)
    mute = context.createGain()
    mute.gain.value = 0
    chunks = []
    sampleCount = 0
    startedAt = 0
    lastLevelAt = 0
    processor.onaudioprocess = (event) => {
      if (active !== capture || capture.cancelled) return
      const samples = new Float32Array(event.inputBuffer.getChannelData(0))
      chunks.push(samples)
      sampleCount += samples.length
      if (!startedAt) {
        startedAt = Date.now()
        send({ type: 'started', sessionId: capture.sessionId, startedAt })
      }
      if (sampleCount >= 16_000 * 30 * 60) {
        stop(capture.sessionId)
        return
      }
      if (performance.now() - lastLevelAt < 60) return
      lastLevelAt = performance.now()
      const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length)
      send({ type: 'level', sessionId: capture.sessionId, level: Math.min(1, rms * 4) })
    }
    for (const track of media.getAudioTracks()) {
      track.onended = () => {
        if (active === capture) {
          cleanup()
          send({ type: 'error', sessionId: capture.sessionId, message: 'Microphone disconnected' })
        }
      }
    }
    source.connect(processor)
    processor.connect(mute)
    mute.connect(context.destination)
    void publishDevices()
    if (capture.stop) stop(capture.sessionId)
  } catch (error) {
    const cancelled = capture.cancelled
    cleanup()
    if (!cancelled) send({ type: 'error', sessionId: capture.sessionId, message: String(error) })
  }
}

ipcRenderer.on(commandChannel, (_event, command: DictationRecorderCommand) => {
  if (command.type === 'sound') playCue(command.cue)
  else if (command.type === 'start') void start(command)
  else if (command.type === 'devices') void publishDevices()
  else if (active?.sessionId === command.sessionId) {
    if (command.type === 'stop') stop(command.sessionId)
    else {
      active.cancelled = true
      if (processor) cleanup()
    }
  }
})

window.addEventListener('DOMContentLoaded', () => {
  navigator.mediaDevices.addEventListener('devicechange', () => void publishDevices())
  send({ type: 'ready' })
  void publishDevices()
})
