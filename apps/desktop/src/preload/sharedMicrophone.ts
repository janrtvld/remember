import { ipcRenderer } from 'electron'
import { selectSharedMicrophone } from './selectSharedMicrophone'

const commandChannel = 'remember:microphone:command'
const eventChannel = 'remember:microphone:event'
type Command = { id: number; type: string; session_id?: number }
type Route = 'idle' | 'conversation' | 'dictation'
let media: MediaStream | null = null
let context: AudioContext | null = null
let worklet: AudioWorkletNode | null = null
let source: MediaStreamAudioSourceNode | null = null
let microphone: MediaDeviceInfo | null = null
let defaultSelected = false
let conversation = false
let paused = false
let note: number | null = null
let streamId = 0
let packets = 0
let wallOffset = 0
let stoppedTracks: Array<{ readyState: MediaStreamTrackState; label: string }> = []
let commands = Promise.resolve()
let nextPacketId = 0
const cancelled = new Set<number>()
const boundaries = new Map<number, () => void>()
const pendingPackets = new Map<number, { node: AudioWorkletNode; buffer: ArrayBuffer }>()

function emit(event: Record<string, unknown>) {
  ipcRenderer.send(eventChannel, event)
}

function metadata() {
  return {
    microphone_name: microphone?.label ?? '',
    default_input_is_selected: defaultSelected,
    running: media?.getAudioTracks().some((track) => track.readyState === 'live') ?? false,
    callback_count: packets,
    stream_id: streamId,
    context_state: context?.state ?? 'closed',
    tracks:
      media?.getAudioTracks().map((track) => ({ readyState: track.readyState, label: track.label })) ?? stoppedTracks,
  }
}

async function refreshDevices() {
  const selection = selectSharedMicrophone(
    await navigator.mediaDevices.enumerateDevices(),
    media ? (media.getAudioTracks()[0]?.getSettings() ?? {}) : null
  )
  microphone = selection.microphone
  defaultSelected = selection.defaultSelected
}

async function closeInput() {
  const previousMedia = media
  const previousContext = context
  media = null
  context = null
  if (worklet) worklet.port.onmessage = null
  pendingPackets.clear()
  source?.disconnect()
  worklet?.disconnect()
  source = null
  worklet = null
  previousMedia?.getTracks().forEach((track) => {
    track.onended = null
    track.stop()
  })
  stoppedTracks =
    previousMedia?.getAudioTracks().map((track) => ({ readyState: track.readyState, label: track.label })) ??
    stoppedTracks
  await previousContext?.close()
}

async function ensureInput() {
  if (media) return
  await refreshDevices()
  if (!microphone) throw new Error('No microphone available')
  const audioContext = new AudioContext({ sampleRate: 16_000, latencyHint: 'interactive' })
  context = audioContext
  const contextReady = Promise.all([
    audioContext.resume(),
    audioContext.audioWorklet.addModule(new URL('microphone-worklet.js', window.location.href).href),
  ])
  // Observe rejection immediately even when device acquisition takes longer.
  const prepared = contextReady.then(
    () => null,
    (error: unknown) => ({ error })
  )
  try {
    media = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: microphone.deviceId },
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
    const failure = await prepared
    if (failure) throw failure.error
    if (audioContext.sampleRate !== 16_000) throw new Error('Unsupported microphone sample rate')
    streamId++
    wallOffset = Date.now() - audioContext.currentTime * 1000
    const currentStream = streamId
    source = audioContext.createMediaStreamSource(media)
    const node = new AudioWorkletNode(audioContext, 'remember-microphone', { outputChannelCount: [1] })
    worklet = node
    node.onprocessorerror = () => emit({ type: 'error', message: 'Microphone audio processor failed' })
    node.port.onmessage = (event: MessageEvent<Record<string, unknown>>) => {
      if (worklet !== node) return
      const message = event.data
      let packetId: number | undefined
      if (message.type === 'pcm' && message.samples instanceof ArrayBuffer) {
        packets++
        packetId = ++nextPacketId
        pendingPackets.set(packetId, { node, buffer: message.samples })
      }
      emit({
        ...message,
        packet_id: packetId,
        stream_id: currentStream,
        started_at: wallOffset + (Number(message.frame) / 16_000) * 1000,
      })
      if (message.type === 'boundary') {
        boundaries.get(Number(message.id))?.()
        boundaries.delete(Number(message.id))
      }
    }
    for (const track of media.getAudioTracks())
      track.onended = () => emit({ type: 'error', message: 'Microphone disconnected' })
    source.connect(node)
    node.connect(audioContext.destination)
  } catch (error) {
    await closeInput()
    throw error
  }
}

function route(): Route {
  return note != null ? 'dictation' : conversation && !paused ? 'conversation' : 'idle'
}

async function setRoute(command: Command) {
  const selectedRoute = route()
  if (worklet) {
    await new Promise<void>((resolve) => {
      boundaries.set(command.id, resolve)
      worklet?.port.postMessage({
        type: 'set-route',
        id: command.id,
        action: command.type,
        route: selectedRoute,
        sessionId: selectedRoute === 'dictation' ? (note ?? undefined) : command.session_id,
      })
    })
  } else {
    emit({
      type: 'boundary',
      id: command.id,
      action: command.type,
      route: selectedRoute,
      sessionId: command.session_id,
      frame: 0,
      stream_id: streamId,
    })
  }
  if (selectedRoute === 'idle') await closeInput()
}

async function handle(command: Command) {
  try {
    switch (command.type) {
      case 'status':
        await refreshDevices()
        break
      case 'conversation-start':
        if (conversation) throw new Error('Conversation microphone already active')
        await ensureInput()
        conversation = true
        paused = false
        await setRoute(command)
        break
      case 'conversation-stop':
        conversation = false
        paused = false
        await setRoute(command)
        break
      case 'conversation-pause':
        paused = true
        await setRoute(command)
        break
      case 'conversation-resume':
        if (!conversation) throw new Error('No conversation microphone subscription')
        await ensureInput()
        paused = false
        await setRoute(command)
        break
      case 'dictation-start':
        if (note != null || command.session_id == null) throw new Error('Invalid Voice note start')
        if (cancelled.has(command.session_id)) break
        await ensureInput()
        if (cancelled.has(command.session_id)) {
          if (!conversation) await closeInput()
          break
        }
        note = command.session_id
        await setRoute(command)
        break
      case 'dictation-stop':
      case 'dictation-cancel':
        if (note === command.session_id) note = null
        await setRoute(command)
        cancelled.delete(command.session_id ?? -1)
        break
      default:
        throw new Error('Unknown microphone command')
    }
    emit({ type: 'response', id: command.id, ok: true, ...metadata() })
  } catch (error) {
    emit({ type: 'response', id: command.id, ok: false, error: String(error) })
  }
}

ipcRenderer.on(commandChannel, (_event, command: Command) => {
  if (command.type === 'dictation-cancel' && command.session_id != null) cancelled.add(command.session_id)
  commands = commands.then(() => handle(command))
})

ipcRenderer.on('remember:microphone:consumed', (_event, packetId: number) => {
  const packet = pendingPackets.get(packetId)
  if (!packet) return
  pendingPackets.delete(packetId)
  if (worklet === packet.node) packet.node.port.postMessage({ type: 'recycle', buffer: packet.buffer }, [packet.buffer])
})

window.addEventListener('DOMContentLoaded', () => {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    void refreshDevices().catch((error) => emit({ type: 'error', message: String(error) }))
  })
  void refreshDevices()
    .then(() => emit({ type: 'ready', ...metadata() }))
    .catch((error) => emit({ type: 'error', message: String(error) }))
})
