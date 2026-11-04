import type { CaptureStatus } from '@remember/shared'

type CaptureLifecycleState = {
  status: CaptureStatus
  errorCode: string | null
}

const ACTIVE_CAPTURE_STATUSES = new Set<CaptureStatus>(['recording', 'paused', 'stopping'])

type ConversationAudioPlaybackTransition = 'started' | 'ended' | null

export class ConversationAudioPlaybackLeases {
  private readonly leasesBySender = new Map<number, Set<string>>()
  private leaseCount = 0

  get active() {
    return this.leaseCount > 0
  }

  set(senderId: number, playbackId: string, active: boolean): ConversationAudioPlaybackTransition {
    const wasActive = this.active
    const senderLeases = this.leasesBySender.get(senderId)

    if (active) {
      if (senderLeases?.has(playbackId)) return null
      const nextSenderLeases = senderLeases ?? new Set<string>()
      nextSenderLeases.add(playbackId)
      this.leasesBySender.set(senderId, nextSenderLeases)
      this.leaseCount += 1
    } else {
      if (!senderLeases?.delete(playbackId)) return null
      this.leaseCount -= 1
      if (senderLeases.size === 0) this.leasesBySender.delete(senderId)
    }

    return this.transitionFrom(wasActive)
  }

  releaseSender(senderId: number): ConversationAudioPlaybackTransition {
    const senderLeases = this.leasesBySender.get(senderId)
    if (!senderLeases) return null
    const wasActive = this.active
    this.leaseCount -= senderLeases.size
    this.leasesBySender.delete(senderId)
    return this.transitionFrom(wasActive)
  }

  clear() {
    this.leasesBySender.clear()
    this.leaseCount = 0
  }

  private transitionFrom(wasActive: boolean): ConversationAudioPlaybackTransition {
    if (!wasActive && this.active) return 'started'
    if (wasActive && !this.active) return 'ended'
    return null
  }
}

export class ConversationAudioPlaybackCoordinator {
  private readonly leases = new ConversationAudioPlaybackLeases()
  private transitionQueue = Promise.resolve()
  private captureSuspended = false

  constructor(
    private readonly suspendCapture: () => Promise<void>,
    private readonly resumeCapture: () => void | Promise<void>
  ) {}

  get active() {
    return this.captureSuspended
  }

  set(senderId: number, playbackId: string, active: boolean) {
    this.leases.set(senderId, playbackId, active)
    return this.reconcile()
  }

  releaseSender(senderId: number) {
    this.leases.releaseSender(senderId)
    return this.reconcile()
  }

  reset() {
    this.leases.clear()
    this.captureSuspended = false
  }

  private reconcile() {
    const operation = this.transitionQueue
      .catch(() => undefined)
      .then(async () => {
        const shouldSuspendCapture = this.leases.active
        if (this.captureSuspended === shouldSuspendCapture) return
        this.captureSuspended = shouldSuspendCapture
        if (shouldSuspendCapture) {
          try {
            await this.suspendCapture()
          } catch (error) {
            this.captureSuspended = false
            throw error
          }
          return
        }
        await this.resumeCapture()
      })
    this.transitionQueue = operation
    return operation
  }
}

export function shouldRunAudioEngines(input: {
  canRunAudioCapture: boolean
  conversationAudioPlaybackActive: boolean
}): boolean {
  return input.canRunAudioCapture && !input.conversationAudioPlaybackActive
}

export function nextAudioEngineToStart({
  microphoneStarted,
  microphoneReady,
  systemAudioStarted,
}: {
  microphoneStarted: boolean
  microphoneReady: boolean
  systemAudioStarted: boolean
}): 'microphone' | 'system' | null {
  if (!microphoneStarted) return 'microphone'
  return microphoneReady && !systemAudioStarted ? 'system' : null
}

export function modelPreparationStartState(state: CaptureLifecycleState): CaptureLifecycleState {
  if (ACTIVE_CAPTURE_STATUSES.has(state.status)) return state
  if (
    state.errorCode !== 'model-required' &&
    state.errorCode !== 'model-download-failed' &&
    state.errorCode !== 'model-download-offline'
  )
    return state
  return { status: 'idle', errorCode: null }
}

export function modelPreparationFailureState(
  state: CaptureLifecycleState,
  failureCode: 'model-download-failed' | 'model-download-offline' = 'model-download-failed'
): CaptureLifecycleState {
  if (ACTIVE_CAPTURE_STATUSES.has(state.status)) return state
  return { status: 'error', errorCode: failureCode }
}
