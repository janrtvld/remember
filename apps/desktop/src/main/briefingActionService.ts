import {
  BRIEFING_PROTOCOL,
  canonicalBriefingJson,
  validateBriefingObservation,
  validateBriefingResult,
} from '../../../../experiments/always-on-agent/briefing-protocol.mjs'
import type { BriefingConnection } from './briefingTcpConnector'
import type { HostInitiativeStore, InitiativeAction } from './hostInitiativeStore'

type Options = {
  store: HostInitiativeStore
  connect(action: InitiativeAction): Promise<BriefingConnection>
  assertCurrent(action: InitiativeAction, stage: 'dispatch' | 'write' | 'publication'): void
  validateSources(action: InitiativeAction, signal: AbortSignal): Promise<'valid' | 'unavailable' | 'invalidated'>
  changed(): void
  error(error: unknown): void
  now?: () => number
}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(new Error('briefing-operation-aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

export function createBriefingActionService(options: Options) {
  const now = options.now ?? Date.now
  let disposed = false
  type Operation = {
    id: string
    controller: AbortController
    connection: BriefingConnection | null
    done: Promise<void>
  }
  let active: Operation | null = null
  const operations = new Set<Operation>()
  const writeAttempts = new Set<string>()
  const begin = (id: string): Operation => {
    if (disposed || [...operations].some((entry) => entry.id === id)) throw new Error('briefing-operation-busy')
    const operation: Operation = { id, controller: new AbortController(), connection: null, done: Promise.resolve() }
    operations.add(operation)
    return operation
  }
  const finish = (operation: Operation) => {
    operation.connection?.close()
    operations.delete(operation)
    if (active === operation) active = null
    options.changed()
  }
  const fresh = new Set<string>()
  const action = (id: string) => {
    const value = options.store.action(id)
    if (!value) throw new Error('briefing-action-missing')
    return value
  }
  const identity = (value: InitiativeAction) => ({
    actionId: value.envelope.actionId,
    jobId: value.envelope.jobId,
    inputHash: value.prepared.descriptor.inputHash,
  })
  const available = (signal: AbortSignal) => {
    if (disposed || signal.aborted) throw new Error('briefing-operation-aborted')
  }

  async function connect(value: InitiativeAction, operation: Operation) {
    const signal = operation.controller.signal
    available(signal)
    const connection = await options.connect(value)
    operation.connection = connection
    try {
      available(signal)
      const hello = await connection.request('hello')
      available(signal)
      const descriptor = value.prepared.descriptor
      if (!hello || typeof hello !== 'object' || Array.isArray(hello)) throw new Error('briefing-hello-invalid')
      const row = hello as Record<string, unknown>
      const keys = ['protocol', 'capability', 'targetId', 'targetEpoch', 'directory', 'workspace', 'jobId', 'sessionId']
      if (
        Object.keys(row).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(row, key)) ||
        row.protocol !== BRIEFING_PROTOCOL ||
        row.capability !== 'private-briefing-v1' ||
        typeof row.sessionId !== 'string' ||
        !row.sessionId ||
        ['targetId', 'targetEpoch', 'directory', 'workspace', 'jobId'].some(
          (key) => row[key] !== descriptor[key as keyof typeof descriptor]
        )
      )
        throw new Error('briefing-hello-mismatch')
      return { connection, sessionId: row.sessionId }
    } catch (error) {
      connection.close()
      throw error
    }
  }

  async function permitted(value: InitiativeAction, stage: 'dispatch' | 'write' | 'publication', signal: AbortSignal) {
    available(signal)
    options.assertCurrent(action(value.envelope.actionId), stage)
    const controller = new AbortController()
    const combined = AbortSignal.any([signal, controller.signal])
    const status = await new Promise<'valid' | 'unavailable' | 'invalidated'>((resolve, reject) => {
      let settled = false
      const finish = (error: unknown, result: 'valid' | 'unavailable' | 'invalidated' = 'unavailable') => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        combined.removeEventListener('abort', aborted)
        if (error) reject(error)
        else resolve(result)
      }
      const aborted = () => finish(new Error('briefing-operation-aborted'))
      const timer = setTimeout(() => {
        finish(null, 'unavailable')
        controller.abort()
      }, 2_000)
      combined.addEventListener('abort', aborted, { once: true })
      if (combined.aborted) return aborted()
      try {
        options.validateSources(value, combined).then(
          (result) => finish(null, result),
          (error) => finish(error)
        )
      } catch (error) {
        finish(error)
      }
    })
    available(signal)
    const current = action(value.envelope.actionId)
    if (status === 'invalidated') options.store.invalidate(value.envelope.actionId)
    if (status !== 'valid') return false
    options.assertCurrent(current, stage)
    return true
  }

  async function observe(
    id: string,
    connection: BriefingConnection,
    sessionId: string,
    signal: AbortSignal,
    allowWrite: boolean
  ) {
    const current = action(id)
    const raw = await connection.request('snapshot', { ...identity(current), afterSeq: 0 })
    available(signal)
    const observed = validateBriefingObservation(raw, current.prepared.descriptor)
    if (observed.sessionId !== sessionId) throw new Error('briefing-session-changed')
    if (observed.phase === 'stopped') {
      options.store.observe(id, observed, 'publish', null, now())
      options.changed()
      return false
    }
    if (observed.phase === 'completed') {
      const withhold = () => {
        options.store.observe(id, observed, 'withheld', null, now())
        options.changed()
      }
      try {
        if (!(await permitted(current, 'publication', signal))) {
          withhold()
          return false
        }
        const result =
          observed.completion === 'briefing'
            ? validateBriefingResult(
                await connection.request('read-result', { ...identity(current), resultId: observed.receipt!.resultId }),
                current.prepared.descriptor
              )
            : null
        available(signal)
        if (result && canonicalBriefingJson(result.receipt) !== canonicalBriefingJson(observed.receipt))
          throw new Error('briefing-result-changed')
        if (!(await permitted(current, 'publication', signal))) {
          withhold()
          return false
        }
        options.assertCurrent(action(id), 'publication')
        options.store.observe(id, observed, 'publish', result, now())
        options.changed()
        return false
      } catch (error) {
        available(signal)
        withhold()
        throw error
      }
    }
    options.store.observe(id, observed, 'metadata', null, now())
    options.changed()
    if (observed.phase === 'unknown') return false
    if (observed.permission && allowWrite) {
      if (!(await permitted(current, 'write', signal))) return false
      const permission = observed.permission
      available(signal)
      options.assertCurrent(action(id), 'write')
      const attempt = canonicalBriefingJson({ id, sessionId, permission })
      if (writeAttempts.has(attempt)) throw new Error('briefing-permission-already-attempted')
      writeAttempts.add(attempt)
      await connection.request('authorize-write', {
        ...identity(current),
        authorityHash: current.prepared.descriptor.authorityHash,
        sessionId,
        requestId: permission.requestId,
        nonce: permission.nonce,
        contentHash: permission.contentHash,
        decision: 'allow',
      })
      available(signal)
    }
    return allowWrite
  }

  const service = {
    isActive(id: string) {
      return !disposed && active?.id === id && !active.controller.signal.aborted
    },
    /** Called only by the same lifetime that just admitted this fresh decision. */
    startAdmitted(id: string) {
      if (disposed || operations.size) throw new Error('briefing-operation-busy')
      const initial = action(id)
      if (initial.state !== 'prepared' || fresh.has(id)) throw new Error('briefing-first-submit-forbidden')
      fresh.add(id)
      const operation = begin(id)
      active = operation
      operation.done = (async () => {
        const signal = operation.controller.signal
        const timer = setTimeout(
          () => {
            operation.controller.abort()
            operation.connection?.close()
          },
          Math.max(0, initial.envelope.deadlineAt - now())
        )
        try {
          if (!(await permitted(initial, 'dispatch', signal))) throw new Error('briefing-sources-unavailable')
          const connected = await connect(initial, operation)
          operation.connection = connected.connection
          if (!(await permitted(initial, 'dispatch', signal))) throw new Error('briefing-sources-unavailable')
          available(signal)
          options.assertCurrent(action(id), 'dispatch')
          if (!options.store.markDispatch(id, initial.preparedHash, now()))
            throw new Error('briefing-first-submit-forbidden')
          options.assertCurrent(action(id), 'dispatch')
          await connected.connection.request('submit', {
            descriptor: initial.prepared.descriptor,
            spec: initial.prepared.spec,
          })
          available(signal)
          while (await observe(id, connected.connection, connected.sessionId, signal, true)) {
            await wait(100, signal)
          }
        } catch (error) {
          if (!disposed && !operation.controller.signal.aborted) options.error(error)
          options.changed()
        } finally {
          clearTimeout(timer)
          finish(operation)
        }
      })()
      return operation.done
    },
    check(id: string) {
      if (disposed || active) throw new Error('briefing-operation-busy')
      const value = action(id)
      if (value.state === 'prepared' || value.state === 'cancelled-unsubmitted') return Promise.resolve()
      const operation = begin(id)
      operation.done = (async () => {
        try {
          const connected = await connect(value, operation)
          await observe(id, connected.connection, connected.sessionId, operation.controller.signal, false)
        } finally {
          finish(operation)
        }
      })()
      return operation.done
    },
    async stop(id: string) {
      if (disposed) throw new Error('briefing-operation-aborted')
      const previous = [...operations].find((entry) => entry.id === id)
      if (previous) {
        previous.controller.abort()
        previous.connection?.close()
        await previous.done.catch(() => {})
      }
      if (disposed) throw new Error('briefing-operation-aborted')
      const value = action(id)
      if (value.state === 'prepared') {
        options.store.cancelUnsubmitted(id, value.preparedHash, now())
        options.changed()
        return
      }
      if (value.state === 'cancelled-unsubmitted') return
      const operation = begin(id)
      operation.done = (async () => {
        try {
          const connected = await connect(value, operation)
          available(operation.controller.signal)
          await connected.connection.request('stop', identity(value))
          await observe(id, connected.connection, connected.sessionId, operation.controller.signal, false)
        } finally {
          finish(operation)
        }
      })()
      return operation.done
    },
    async dispose() {
      disposed = true
      const pending = [...operations]
      for (const operation of pending) {
        operation.controller.abort()
        operation.connection?.close()
      }
      await Promise.allSettled(pending.map((operation) => operation.done))
    },
  }
  return service
}
