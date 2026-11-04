import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { BriefingObservation } from '../../../../../experiments/always-on-agent/briefing-protocol.mjs'
import { createBriefingActionService } from '../briefingActionService'
import type { BriefingConnection } from '../briefingTcpConnector'
import type { ProactiveDecision } from '../dailyReview/proactiveStore'
import {
  buildInitiativePrepared,
  type HostInitiativeEnvelopeV2,
  type StandingGrantScope,
} from '../hostInitiativeProtocol'
import { canonicalHostTaskJson } from '../hostTaskProtocol'
import { ResidentAgentStore } from '../residentAgentStore'

const NOW = 1_800_000_000_000
const hash = (value: unknown) => createHash('sha256').update(canonicalHostTaskJson(value)).digest('hex')
const source = {
  eventId: 'event-1',
  kind: 'context' as const,
  sourceId: 'source-1',
  evidenceId: 'context:source-1',
  workdayId: 'day-1',
  eventRevision: 'b'.repeat(64),
  revision: 'c'.repeat(64),
  contentKey: 'd'.repeat(64),
  observedAt: NOW,
  appName: 'Test Editor',
  windowTitle: 'Atlas',
  url: '',
}
const scope: StandingGrantScope = {
  version: 1,
  installationId: 'install-1',
  contextFingerprint: 'fixture-current-context',
  target: { targetId: 'mini-1', targetEpoch: 'epoch-1', root: '/private/tmp/rpa3-unit' },
  capability: 'private-briefing-v1',
  evidenceSourceIds: ['source-1'],
  afterSequence: 10,
  personalSources: [{ spaceId: 'personal', slug: 'atlas', revision: 'r1' }],
  model: 'fake-model',
  effort: 'low',
  maxInputBytes: 10000,
  maxOutputBytes: 10000,
  maxDurationMs: 60000,
  outputBasename: 'briefing.md',
  expiresAt: NOW + 120000,
  maxJobs: 2,
}
function setup(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync('/private/tmp/rpa3-store-')
  const file = join(directory, 'resident.sqlite')
  const store = new ResidentAgentStore(file, { now: () => NOW })
  t.after(() => {
    try {
      store.close()
    } catch {}
    rmSync(directory, { recursive: true, force: true })
  })
  const decision: ProactiveDecision = {
    id: 'decision-1',
    kind: 'prepare',
    text: 'Ik bereid een Atlas briefing voor.',
    topicKey: 'atlas',
    sourceIds: [source.evidenceId],
    supportingQuotes: [{ sourceId: source.evidenceId, quote: 'Atlas besluit' }],
    createdAt: NOW,
    expiresAt: NOW + 60000,
    policyToken: 'policy-1',
    conversationGeneration: 0,
    inputHash: 'a'.repeat(64),
    sourceRefs: [source],
    consumerGeneration: 1,
    deletionRevision: 0,
    deliveredMessageId: null,
    invalidatedAt: null,
  }
  const messageId = store.appendProactiveInitiative(decision)!
  const api = store.initiatives
  const grant = () => api.createGrant(scope, NOW, 'grant-1')
  const inputs = () => {
    const g = grant()
    const { deliveredMessageId: _d, invalidatedAt: _i, ...payload } = decision
    const packet = {
      sources: [
        {
          sourceId: source.evidenceId,
          revision: createHash('sha256').update('Atlas besluit').digest('hex'),
          text: 'Atlas besluit',
        },
        {
          sourceId: 'personal:atlas',
          revision: createHash('sha256').update('Kies de deadline.').digest('hex'),
          text: 'Kies de deadline.',
        },
      ],
    }
    const envelope: HostInitiativeEnvelopeV2 = {
      version: 2,
      authority: {
        kind: 'initiative',
        decisionId: decision.id,
        decisionInputHash: decision.inputHash,
        decisionPayloadHash: hash(payload),
        grantId: g.id,
        grantGeneration: g.generation,
        grantScopeHash: g.scopeHash,
      },
      actionId: 'action-1',
      jobId: 'job-1',
      assistantMessageId: messageId,
      target: scope.target,
      policyFingerprint: 'policy-1',
      deletionRevision: 0,
      sourceRefs: { evidence: [source], personal: scope.personalSources },
      sourcePacketHash: hash(packet),
      startedAt: NOW,
      deadlineAt: NOW + 60000,
      capability: 'private-briefing-v1',
      preparedInput: {
        prompt: canonicalHostTaskJson(packet),
        systemPrompt: 'Synthesize only.',
        model: scope.model,
        effort: scope.effort,
        threadId: null,
        tools: [],
        maxInputBytes: scope.maxInputBytes,
        maxOutputBytes: scope.maxOutputBytes,
        maxDurationMs: scope.maxDurationMs,
      },
    }
    return {
      envelope,
      prepared: buildInitiativePrepared(envelope),
      current: {
        decision: { ...decision, deliveredMessageId: messageId },
        sourceSequences: [{ eventId: source.eventId, sequence: 11 }],
      },
    }
  }
  return { file, store, api, grant, inputs, decision, messageId }
}

function completion(prepared: ReturnType<typeof buildInitiativePrepared>) {
  const content = '# Atlas\nChoose the deadline.',
    contentHash = createHash('sha256').update(content).digest('hex')
  const receipt = {
    version: 1 as const,
    resultId: 'result-1',
    descriptorHash: hash(prepared.descriptor),
    actionId: prepared.descriptor.actionId,
    jobId: prepared.descriptor.jobId,
    inputHash: prepared.descriptor.inputHash,
    authorityHash: prepared.descriptor.authorityHash,
    basename: 'briefing.md' as const,
    contentHash,
    byteLength: Buffer.byteLength(content),
    createdAt: NOW + 10,
    verifiedAt: NOW + 11,
  }
  const observation = {
    version: 1 as const,
    sessionId: 'coordinator-1',
    descriptor: prepared.descriptor,
    phase: 'completed' as const,
    createdAt: NOW,
    updatedAt: NOW + 12,
    cursor: 3,
    events: [{ seq: 3, type: 'completed', at: NOW + 12, data: { privateText: 'withheld-nonce-43' } }],
    execution: {
      invocationId: 'actual-invocation',
      pid: 123,
      providerThreadId: 'actual-thread',
      exit: { code: 0, signal: null, at: NOW + 9 },
    },
    permission: null,
    writeIntent: { contentHash, byteLength: receipt.byteLength, createdAt: NOW + 10, state: 'verified' as const },
    receipt,
    completion: 'briefing' as const,
    error: null,
  }
  return { observation, result: { version: 1 as const, receipt, content } }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
async function until(condition: () => boolean) {
  for (let count = 0; count < 100 && !condition(); count++) await tick()
  assert(condition(), 'fixture reached expected boundary')
}
function host(prepared: ReturnType<typeof buildInitiativePrepared>) {
  const completed = completion(prepared),
    sessionId = 'coordinator-1'
  let observed: BriefingObservation = {
    ...completed.observation,
    phase: 'accepted',
    updatedAt: NOW,
    cursor: 1,
    events: [],
    execution: null,
    permission: null,
    writeIntent: null,
    receipt: null,
    completion: null,
  }
  let submits = 0,
    authorizations = 0,
    stops = 0,
    snapshots = 0,
    reads = 0,
    closes = 0
  let loseSubmitAck = false,
    loseWriteAck = false,
    lingerChallenge = false,
    stopCompletes = false
  let readHold: ReturnType<typeof deferred<unknown>> | null = null
  let beforeReply: ((op: string) => void) | null = null
  const requests: { op: string; payload: Record<string, unknown> }[] = []
  const waiting = () => {
    observed = {
      ...observed,
      phase: 'awaiting-write-permission',
      updatedAt: NOW + 1,
      cursor: 2,
      execution: completed.observation.execution,
      permission: {
        requestId: 'request-1',
        nonce: 'nonce-1',
        sessionId,
        contentHash: completed.result.receipt.contentHash,
        byteLength: completed.result.receipt.byteLength,
        leaseMs: 3000,
        createdAt: NOW + 1,
      },
      writeIntent: {
        contentHash: completed.result.receipt.contentHash,
        byteLength: completed.result.receipt.byteLength,
        createdAt: NOW + 1,
        state: 'reserved',
      },
    }
  }
  const connection = (): BriefingConnection => ({
    request(op, payload = {}) {
      requests.push({ op, payload })
      beforeReply?.(op)
      if (op === 'hello')
        return Promise.resolve({
          protocol: 'remember-private-briefing-v1',
          capability: 'private-briefing-v1',
          targetId: prepared.descriptor.targetId,
          targetEpoch: prepared.descriptor.targetEpoch,
          directory: prepared.descriptor.directory,
          workspace: prepared.descriptor.workspace,
          jobId: prepared.descriptor.jobId,
          sessionId,
        })
      if (op === 'submit') {
        submits++
        waiting()
        return loseSubmitAck ? Promise.reject(new Error('lost-submit-ack')) : Promise.resolve({ accepted: true })
      }
      if (op === 'snapshot') {
        snapshots++
        if (lingerChallenge && authorizations > 0 && snapshots >= 3) observed = completed.observation
        return Promise.resolve(structuredClone(observed))
      }
      if (op === 'authorize-write') {
        authorizations++
        if (!lingerChallenge) observed = completed.observation
        return loseWriteAck ? Promise.reject(new Error('lost-write-ack')) : Promise.resolve({ authorized: true })
      }
      if (op === 'read-result') {
        reads++
        return readHold ? readHold.promise : Promise.resolve(structuredClone(completed.result))
      }
      if (op === 'stop') {
        stops++
        observed =
          stopCompletes || observed.phase === 'completed'
            ? completed.observation
            : {
                ...observed,
                phase: 'stopped',
                updatedAt: NOW + 3,
                cursor: 3,
                permission: null,
                completion: null,
                error: null,
              }
        return Promise.resolve({ stopped: true })
      }
      return Promise.reject(new Error('unexpected-op'))
    },
    close() {
      closes++
    },
  })
  return {
    connection,
    requests,
    completed,
    counts: () => ({ submits, authorizations, stops, snapshots, reads, closes }),
    loseSubmit: () => {
      loseSubmitAck = true
    },
    loseWrite: () => {
      loseWriteAck = true
    },
    linger: () => {
      lingerChallenge = true
    },
    stopCompleted: () => {
      stopCompletes = true
    },
    setCompleted: () => {
      observed = completed.observation
    },
    setUnknown: () => {
      observed = { ...observed, phase: 'unknown', permission: null, error: 'interrupted' }
    },
    holdRead: () => {
      readHold = deferred()
      return readHold
    },
    before: (handler: (op: string) => void) => {
      beforeReply = handler
    },
  }
}
function fixture(t: { after(fn: () => void | Promise<void>): void }) {
  const state = setup(t),
    inputs = state.inputs(),
    admitted = state.api.admit(inputs.envelope, inputs.prepared, inputs.current, NOW),
    peer = host(inputs.prepared)
  let status: 'valid' | 'unavailable' | 'invalidated' = 'valid',
    permitted = true,
    stage = ''
  let validation: ((signal: AbortSignal) => Promise<'valid' | 'unavailable' | 'invalidated'>) | null = null
  let connectHold: ReturnType<typeof deferred<BriefingConnection>> | null = null
  const errors: unknown[] = []
  const peers = new Map([[inputs.envelope.jobId, peer]])
  const create = () =>
    createBriefingActionService({
      store: state.api,
      connect: async (value) => (connectHold ? connectHold.promise : peers.get(value.envelope.jobId)!.connection()),
      assertCurrent: (_action, currentStage) => {
        stage = currentStage
        if (!permitted) throw new Error('policy-unavailable')
      },
      validateSources: async (_action, signal) => (validation ? validation(signal) : status),
      changed: () => {},
      error: (error) => errors.push(error),
      now: () => NOW + 30,
    })
  const service = create()
  t.after(() => service.dispose())
  return {
    ...state,
    inputs,
    admitted,
    peer,
    peers,
    service,
    create,
    errors,
    stage: () => stage,
    setStatus: (value: typeof status) => {
      status = value
    },
    setPermitted: (value: boolean) => {
      permitted = value
    },
    setValidation: (value: typeof validation) => {
      validation = value
    },
    holdConnect: () => {
      connectHold = deferred()
      return connectHold
    },
  }
}

test('explicit admitted action submits once, authorizes one challenge and publishes exact result', async (t) => {
  const f = fixture(t)
  await f.service.startAdmitted('action-1')
  assert.deepEqual(f.errors, [])
  assert.equal(f.peer.counts().submits, 1)
  assert.equal(f.peer.counts().authorizations, 1)
  assert.equal(f.api.action('action-1')?.publication, 'published')
  assert.deepEqual(f.api.action('action-1')?.result, f.peer.completed.result)
  assert.equal(f.store.get(f.messageId)?.text, f.decision.text)
  await f.service.dispose()
})
test('lost accepted submit ACK then explicit Check remains read-only and never authorizes', async (t) => {
  const f = fixture(t)
  f.peer.loseSubmit()
  await f.service.startAdmitted('action-1')
  assert.equal(f.errors.length, 1)
  await f.service.check('action-1')
  assert.equal(f.peer.counts().submits, 1)
  assert.equal(f.peer.counts().authorizations, 0)
  assert.equal(f.api.action('action-1')?.state, 'awaiting-write-permission')
  await f.service.dispose()
  const next = f.create()
  await next.check('action-1')
  await next.dispose()
  assert.equal(f.peer.counts().submits, 1)
  assert.equal(f.peer.counts().authorizations, 0)
})
test('accepted write ACK loss is recovered by read-only Check without second authorization', async (t) => {
  const f = fixture(t)
  f.peer.loseWrite()
  await f.service.startAdmitted('action-1')
  assert.equal(f.peer.counts().authorizations, 1)
  await f.service.check('action-1')
  assert.equal(f.peer.counts().authorizations, 1)
  assert.equal(f.api.action('action-1')?.publication, 'published')
  await f.service.dispose()
})
test('one unchanged pending write challenge can be invoked at most once', async (t) => {
  const f = fixture(t)
  f.peer.linger()
  await f.service.startAdmitted('action-1')
  assert.equal(f.peer.counts().authorizations, 1)
  await f.service.dispose()
})
test('Stop returning completed validates and publishes the actual result', async (t) => {
  const f = fixture(t)
  f.peer.loseSubmit()
  f.peer.stopCompleted()
  await f.service.startAdmitted('action-1')
  await f.service.stop('action-1')
  assert.equal(f.peer.counts().stops, 1)
  assert.equal(f.api.action('action-1')?.state, 'completed')
  assert.deepEqual(f.api.action('action-1')?.result, f.peer.completed.result)
  await f.service.dispose()
})
test('source becomes unavailable during result read: no private import and terminal stays withheld', async (t) => {
  const f = fixture(t)
  f.peer.loseSubmit()
  await f.service.startAdmitted('action-1')
  f.peer.setCompleted()
  const held = f.peer.holdRead(),
    pending = f.service.check('action-1')
  await until(() => f.peer.counts().reads === 1)
  f.setStatus('unavailable')
  held.resolve(f.peer.completed.result)
  await pending
  assert.equal(f.api.action('action-1')?.publication, 'withheld')
  assert.equal(f.api.action('action-1')?.result, null)
  assert.equal(f.api.unresolved().length, 1)
  await f.service.dispose()
})
test('permission changes during result read preserve completed metadata as withheld', async (t) => {
  const f = fixture(t)
  f.peer.loseSubmit()
  await f.service.startAdmitted('action-1')
  f.peer.setCompleted()
  const held = f.peer.holdRead(),
    pending = f.service.check('action-1')
  await until(() => f.peer.counts().reads === 1)
  f.setPermitted(false)
  held.resolve(f.peer.completed.result)
  await assert.rejects(pending, /policy-unavailable/)
  assert.equal(f.api.action('action-1')?.publication, 'withheld')
  assert.equal(f.api.action('action-1')?.terminal?.phase, 'completed')
  assert.equal(f.api.action('action-1')?.result, null)
  await f.service.dispose()
})
test('dispose aborts pending write validation without Stop or authorization', async (t) => {
  const f = fixture(t),
    held = deferred<'valid'>()
  f.setValidation(async () => (f.stage() === 'write' ? held.promise : 'valid'))
  const running = f.service.startAdmitted('action-1')
  await until(() => f.stage() === 'write')
  await f.service.dispose()
  held.resolve('valid')
  await running
  assert.equal(f.peer.counts().stops, 0)
  assert.equal(f.peer.counts().authorizations, 0)
})
test('dispose waits for and closes a Check connection pending at hello', async (t) => {
  const f = fixture(t)
  f.peer.loseSubmit()
  await f.service.startAdmitted('action-1')
  const hold = f.holdConnect(),
    checking = f.service.check('action-1').catch((error) => error)
  await tick()
  let disposed = false
  const disposing = f.service.dispose().then(() => {
    disposed = true
  })
  await tick()
  const completedBeforeConnect = disposed
  hold.resolve(f.peer.connection())
  await disposing
  await checking
  assert.equal(completedBeforeConnect, false)
  assert(f.peer.counts().closes >= 2)
})
test('historical A Stop leaves active B review intact; exact B Stop rejects late validation', async (t) => {
  const f = fixture(t)
  await f.service.startAdmitted('action-1')
  const original = f.api.action('action-1')!
  const decision = { ...f.decision, id: 'decision-B', deliveredMessageId: null },
    messageId = f.store.appendProactiveInitiative(decision)!
  const { deliveredMessageId: _d, invalidatedAt: _i, ...payload } = decision
  const env = {
    ...f.inputs.envelope,
    actionId: 'action-B',
    jobId: 'job-B',
    assistantMessageId: messageId,
    authority: { ...f.inputs.envelope.authority, decisionId: decision.id, decisionPayloadHash: hash(payload) },
  }
  const prepared = buildInitiativePrepared(env)
  f.api.admit(
    env,
    prepared,
    { ...f.inputs.current, decision: { ...decision, deliveredMessageId: messageId } },
    NOW + 30
  )
  const peerB = host(prepared),
    held = deferred<'valid'>()
  f.peers.set('job-B', peerB)
  f.setValidation(async () => (f.stage() === 'write' ? held.promise : 'valid'))
  const running = f.service.startAdmitted('action-B')
  await until(() => f.stage() === 'write')
  const b = f.api.action('action-B'),
    counts = peerB.counts()
  await f.service.stop('action-1')
  assert.deepEqual(f.api.action('action-B'), b)
  assert.equal(peerB.counts().stops, counts.stops)
  assert.equal(f.api.action('action-1')?.resultHash, original.resultHash)
  await f.service.stop('action-B')
  held.resolve('valid')
  await running
  assert.equal(peerB.counts().submits, 1)
  assert.equal(peerB.counts().stops, 1)
  assert.equal(peerB.counts().authorizations, 0)
  assert.equal(f.api.action('action-B')?.state, 'stopped')
  assert.equal(f.peer.counts().authorizations, 1)
  await f.service.dispose()
})
test('policy loss while awaiting write validation produces no authorization', async (t) => {
  const f = fixture(t),
    held = deferred<'valid'>()
  f.setValidation(async () => (f.stage() === 'write' ? held.promise : 'valid'))
  const running = f.service.startAdmitted('action-1')
  await until(() => f.stage() === 'write')
  f.setPermitted(false)
  held.resolve('valid')
  await running
  assert.equal(f.peer.counts().authorizations, 0)
  assert.equal(f.peer.counts().submits, 1)
  assert.equal(f.errors.length, 1)
  await f.service.dispose()
})
