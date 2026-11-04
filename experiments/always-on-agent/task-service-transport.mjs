import { AsyncLocalStorage } from 'node:async_hooks'
import { openJobRouterV2 } from './job-router-v2.mjs'

function copy(value) {
  let nodes = 0
  const visit = (item, depth) => {
    if (++nodes > 12000 || depth > 24) throw Error('transport-invalid-json')
    if (item === null || ['string', 'boolean'].includes(typeof item)) return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (!item || typeof item !== 'object' || Object.getOwnPropertySymbols(item).length)
      throw Error('transport-invalid-json')
    const descriptors = Object.getOwnPropertyDescriptors(item)
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || Object.keys(descriptors).length !== item.length + 1)
        throw Error('transport-invalid-json')
      return Array.from({ length: item.length }, (_, i) => {
        const descriptor = descriptors[i]
        if (!descriptor?.enumerable || !('value' in descriptor)) throw Error('transport-invalid-json')
        return visit(descriptor.value, depth + 1)
      })
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw Error('transport-invalid-json')
    return Object.fromEntries(
      Object.keys(descriptors)
        .sort()
        .map((key) => {
          const descriptor = descriptors[key]
          if (!descriptor.enumerable || !('value' in descriptor)) throw Error('transport-invalid-json')
          return [key, visit(descriptor.value, depth + 1)]
        })
    )
  }
  const detached = visit(value, 0)
  if (Buffer.byteLength(JSON.stringify(detached)) > 131072) throw Error('transport-invalid-json')
  return detached
}
const equal = (a, b) => JSON.stringify(copy(a)) === JSON.stringify(copy(b))

// connectChild establishes its connection before returning. The final seam guarantees
// direct request invocation, not the internals of an arbitrary injected transport.
export function openTaskServiceTransport({ directory, targetId, targetEpoch, connectChild }) {
  if (typeof connectChild !== 'function') throw Error('transport-child-required')
  const operations = new AsyncLocalStorage()
  const pending = new Set()
  const clients = new Set()
  let disposed = false
  let closing = null
  const current = () => {
    if (disposed) throw Error('transport-disposed')
    const operation = operations.getStore()
    if (!operation) throw Error('transport-operation-missing')
    return operation
  }
  const router = openJobRouterV2({
    directory,
    targetId,
    targetEpoch,
    connectChild: async (rawDescriptor) => {
      const operation = current()
      const descriptor = copy(rawDescriptor)
      const child = await connectChild(copy(descriptor))
      let lastSnapshot = null
      clients.add(child)
      if (disposed) {
        clients.delete(child)
        await child.close()
        throw Error('transport-disposed')
      }
      return {
        async request(op, payload = {}) {
          if (current() !== operation) throw Error('transport-operation-mismatch')
          const detached = copy(payload)
          if (op === 'submit' || op === 'reply') {
            if (operation.op !== op || !operation.guard || operation.consumed) throw Error('transport-guard-required')
            if (!equal(descriptor, operation.prepared.descriptor)) throw Error('transport-binding-mismatch')
            const expected =
              op === 'submit'
                ? {
                    jobId: descriptor.assignment.jobId,
                    spec: { ...operation.prepared.input, workspace: descriptor.workspace },
                  }
                : {
                    requestId: operation.request.requestId,
                    sessionId: operation.request.sessionId,
                    result: operation.request.result,
                  }
            if (!equal(detached, expected)) throw Error('transport-payload-mismatch')
            if (op === 'reply') {
              const review = operation.expectedReview
              const actual = lastSnapshot?.requests.find((request) => request.id === detached.requestId)
              if (
                !review ||
                !actual ||
                lastSnapshot.sessionId !== detached.sessionId ||
                lastSnapshot.job?.threadId !== review.threadId ||
                lastSnapshot.job?.turnId !== review.turnId ||
                !equal(
                  {
                    id: actual.id,
                    sessionId: actual.sessionId,
                    status: actual.status,
                    method: actual.method,
                    payload: actual.payload,
                  },
                  review.request
                )
              )
                throw Error('transport-review-mismatch')
            }
            operation.consumed = true
            const finalize = await operation.guard()
            current()
            if (typeof finalize !== 'function') throw Error('transport-finalizer-required')
            finalize()
            // No await/queue between the last synchronous check and the child invocation.
            const response = child.request(op, detached)
            return response
          }
          if (!['hello', 'snapshot', 'stop'].includes(op) || (op === 'stop' && operation.op !== 'stop'))
            throw Error('transport-child-operation-mismatch')
          if (op === 'stop' && !equal(descriptor.assignment, operation.request.assignment))
            throw Error('transport-binding-mismatch')
          const response = await child.request(op, detached)
          current()
          if (op === 'snapshot') {
            if (!response || typeof response !== 'object' || !Array.isArray(response.requests))
              throw Error('transport-snapshot-invalid')
            lastSnapshot = {
              sessionId: response.sessionId,
              job: copy(response.job),
              requests: response.requests.map(copy),
            }
          }
          return response
        },
        async close() {
          clients.delete(child)
          await child.close()
        },
      }
    },
  })
  const dispose = () => {
    disposed = true
    for (const child of clients)
      void Promise.resolve()
        .then(() => child.close())
        .catch(() => {})
  }
  return {
    request(text, binding) {
      if (disposed) return Promise.reject(Error('transport-disposed'))
      let operation
      try {
        if (typeof text !== 'string' || Buffer.byteLength(text) > 70000) throw Error('transport-invalid-request')
        const request = copy(JSON.parse(text))
        const guarded = request.op === 'submit' || request.op === 'reply'
        if (guarded && (!binding || typeof binding.guard !== 'function')) throw Error('transport-guard-required')
        if (!guarded && binding) throw Error('transport-unexpected-guard')
        const prepared = binding ? copy(binding.prepared) : null
        const expectedReview = binding?.expectedReview ? copy(binding.expectedReview) : null
        if (prepared && (prepared.version !== 1 || !equal(prepared.descriptor.assignment, request.assignment)))
          throw Error('transport-binding-mismatch')
        if (
          request.op === 'reply' &&
          (!expectedReview ||
            expectedReview.request?.id !== request.requestId ||
            expectedReview.request?.sessionId !== request.sessionId)
        )
          throw Error('transport-review-mismatch')
        if (request.op !== 'reply' && expectedReview) throw Error('transport-review-mismatch')
        operation = { op: request.op, request, prepared, guard: binding?.guard, expectedReview, consumed: false }
      } catch (error) {
        return Promise.reject(error)
      }
      const work = operations.run(operation, () => router.request(JSON.stringify(operation.request)))
      pending.add(work)
      void work.finally(() => pending.delete(work)).catch(() => {})
      return work
    },
    dispose,
    close() {
      if (!closing) {
        dispose()
        closing = Promise.allSettled([...pending]).then(() => router.close())
      }
      return closing
    },
  }
}
