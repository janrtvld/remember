import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type { DailyReviewSession, WikiPage } from '@remember/shared'
import { hashBriefingValue as hash } from '../../../../../experiments/always-on-agent/briefing-protocol.mjs'
import type { AgentContextSnapshot } from '../agentContextService'
import {
  type BriefingNativeDependencies,
  type BriefingNativeManifest,
  briefingQaInstallationId,
  createBriefingNative,
  validateBriefingNativeManifest,
} from '../briefingNativeCore'
import { EvidenceStore } from '../dailyReview/evidenceStore'
import { ResidentAgentStore } from '../residentAgentStore'

const NOW = Date.now()
function setup(t: { after(fn: () => void): void }, evidenceSourceIds = ['screen-a', 'screen-b'], privateScope = false) {
  const directory = mkdtempSync('/private/tmp/rpa3-native-unit-')
  let now = NOW
  let evidence = new EvidenceStore(join(directory, 'evidence.sqlite'))
  let resident = new ResidentAgentStore(join(directory, 'resident.sqlite'), { now: () => now })
  const owners: ReturnType<typeof createBriefingNative>[] = []
  t.after(async () => {
    for (const instance of owners) await instance.dispose()
    resident.close()
    evidence.close()
    rmSync(directory, { recursive: true, force: true })
  })
  evidence.upsertSession({
    id: 'day',
    startedAt: NOW - 60000,
    endedAt: null,
    activeDurationMs: 0,
    moments: [],
    contextMoments: [],
    appActivity: [],
    memory: null,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  } as DailyReviewSession)
  evidence.proactive.configureConsumer(true, NOW - 1)
  const legacyManifest: BriefingNativeManifest = {
    version: 1,
    profilePath: directory,
    installationId: 'installation-qa',
    targetId: 'mini',
    targetEpoch: 'epoch',
    root: '/private/tmp/rpa3-native-unit-host',
    computerExecutionKey: 'remote-key',
    targetLabel: 'Eigen Mini',
    source: { spaceId: 'personal', slug: 'atlas' },
    evidenceSourceIds,
    model: 'fake-model',
    effort: 'low',
    maxDurationMs: 60000,
    slots: ['job-a', 'job-b'].map((jobId, index) => {
      const d = `/private/tmp/rpa3-native-unit-host/jobs/${createHash('sha256').update(jobId).digest('hex').slice(0, 24)}`
      return { jobId, directory: d, workspace: `${d}/workspace`, endpoint: `tcp://127.0.0.1:${47910 + index}` }
    }),
  }
  const { evidenceSourceIds: _ids, ...privateFields } = legacyManifest
  const manifest = privateScope
    ? ({
        ...privateFields,
        version: 2,
        screenApp: { bundleId: 'com.test.editor', label: 'Editor' },
      } as unknown as BriefingNativeManifest)
    : legacyManifest
  let page: WikiPage = {
    slug: 'atlas',
    title: 'Atlas',
    content: 'Voor bredere uitrol moet uitval onder 10% zijn.',
    excerpt: '',
    updatedAt: NOW - 1000,
    sourceCount: 0,
    revision: 'r1',
  }
  let fingerprint = 'context-1',
    policyToken: string | null = 'policy-1',
    attention = true
  let read: () => Promise<AgentContextSnapshot> = async () => ({
    pages: [structuredClone(page)],
    checkedAt: now,
    state: 'fresh',
  })
  const wire: { op: string; payload: unknown }[] = []
  let connections = 0
  const dependencies: BriefingNativeDependencies = {
    manifest,
    resident,
    evidence,
    now: () => now,
    context: () => ({
      available: true,
      fingerprint,
      policyToken,
      profilePath: directory,
      installationId: 'installation-qa',
      computerExecutionKey: 'remote-key',
      locale: 'nl',
      timeZone: 'Europe/Amsterdam',
    }),
    currentPage: () => structuredClone(page),
    readPersonal: () => read(),
    projectEvidence: (source) => structuredClone(source),
    projectPersonal: (p) => p.content,
    attentionAvailable: () => attention,
    systemPrompt: 'Draft one grounded briefing; tools disabled.',
    changed() {},
    error() {},
    connect: async (_endpoint, action) => {
      connections += 1
      return {
        request: async (op, payload) => {
          wire.push({ op, payload })
          if (op === 'hello')
            return {
              protocol: 'remember-private-briefing-v1',
              capability: 'private-briefing-v1',
              sessionId: 'host-session',
              ...Object.fromEntries(
                ['targetId', 'targetEpoch', 'directory', 'workspace', 'jobId'].map((key) => [
                  key,
                  action.prepared.descriptor[key as keyof typeof action.prepared.descriptor],
                ])
              ),
            }
          throw new Error('fixture-wire-stop')
        },
        close() {},
      }
    },
  }
  const owner = createBriefingNative(dependencies)
  owners.push(owner)
  const grant = async () => {
    const preview = (await owner.previewGrant()) as { token: string }
    await owner.confirmGrant(preview.token)
    return resident.initiatives.grants()[0]!
  }
  const delivered = (id = 'screen-a', bundleId = 'com.test.editor', observedOffset = 0) => {
    now += 20000
    evidence.appendContextMoment(
      'day',
      {
        id,
        timestamp: now + observedOffset,
        text: `Atlas uitval is 18%; uitrolbesluit staat open. ${id}`,
        appName: 'Editor',
        windowTitle: 'Atlas',
        textSource: 'accessibility',
        trigger: 'content-change',
        monitorName: '',
        screenshotPath: '',
      },
      null,
      bundleId
    )
    now += 20000
    const source = evidence.proactive
      .batch(
        now,
        () => true,
        () => true
      )
      .find((s) => s.sourceId === id)!
    const decision = evidence.proactive.commit({
      consumerGeneration: evidence.proactive.generation(),
      sources: [source],
      decision: {
        id: `decision-${id}`,
        kind: 'prepare',
        text: 'Een briefing verbindt uitval en beslisgrens.',
        topicKey: `atlas-${id}`,
        sourceIds: [source.evidenceId],
        supportingQuotes: [{ sourceId: source.evidenceId, quote: 'Atlas uitval is 18%' }],
        createdAt: now,
        expiresAt: now + 60000,
        policyToken: 'policy-1',
        conversationGeneration: resident.proactiveConversationGeneration(),
      },
    })
    const messageId = resident.appendProactiveInitiative(decision)!
    evidence.proactive.acknowledgeDelivery(decision.id, decision.inputHash, messageId, now)
    return { decision: evidence.proactive.get(decision.id)!, messageId, source }
  }
  return {
    owner,
    recreate: (changes: Partial<BriefingNativeDependencies> = {}) => {
      const next = createBriefingNative({ ...dependencies, ...changes })
      owners.push(next)
      return next
    },
    reopenStores: () => {
      resident.close()
      evidence.close()
      resident = new ResidentAgentStore(join(directory, 'resident.sqlite'), { now: () => now })
      evidence = new EvidenceStore(join(directory, 'evidence.sqlite'))
      dependencies.resident = resident
      dependencies.evidence = evidence
    },
    get connections() {
      return connections
    },
    get resident() {
      return resident
    },
    get evidence() {
      return evidence
    },
    directory,
    currentTime: () => now,
    snapshot: (): AgentContextSnapshot => ({ pages: [structuredClone(page)], checkedAt: now, state: 'fresh' }),
    manifest,
    wire,
    grant,
    delivered,
    setFingerprint: (v: string) => {
      fingerprint = v
    },
    setPolicy: (v: string | null) => {
      policyToken = v
    },
    setPage: (p: Partial<WikiPage>) => {
      page = { ...page, ...p }
    },
    setAttention: (v: boolean) => {
      attention = v
    },
    setRead: (fn: typeof read) => {
      read = fn
    },
    advance: (ms: number) => {
      now += ms
    },
  }
}

test('RPA7 private manifest names one exact app without an empty fixed-ID wildcard', (t) => {
  const f = setup(t, [], true)
  assert.deepEqual(validateBriefingNativeManifest(f.manifest), f.manifest)
  for (const change of [
    { screenApp: { bundleId: '', label: 'Editor' } },
    { screenApp: { bundleId: '*', label: 'Editor' } },
    { screenApp: { bundleId: 'com.test.editor', label: 'Editor', kind: 'speech' } },
    { evidenceSourceIds: [] },
  ])
    assert.throws(() => validateBriefingNativeManifest({ ...f.manifest, ...change }), /invalid/)
  assert.equal(f.resident.initiatives.grants().length, 0)
  assert.equal(f.connections, 0)
})

test('RPA7 future canonical app source is eligible; forged/wrong bundle and no batch fail closed', async (t) => {
  const f = setup(t, [], true)
  const preview = await f.owner.previewGrant()
  assert.equal(preview.screenAppLabel, 'Editor')
  await f.owner.confirmGrant(preview.token)
  const a = f.delivered('new-unlisted-source')
  assert.deepEqual(f.owner.candidateSourceIds(), [])
  assert.deepEqual(f.owner.candidateSourceIds([a.source]), [a.source.evidenceId])
  assert.deepEqual(f.owner.candidateSourceIds([{ ...a.source, bundleId: 'com.other' }]), [])
  const b = f.delivered('same-title-other-app', 'com.other')
  assert.equal(b.source.appName, a.source.appName)
  assert.deepEqual(f.owner.candidateSourceIds([b.source]), [])
  assert.deepEqual(f.owner.candidateSourceIds([{ ...a.source, kind: 'speech' }]), [])
  assert.deepEqual(f.owner.candidateSourceIds([{ ...a.source, kind: 'note' }]), [])
  assert.equal(f.connections, 0)
})

test('RPA7 private grant excludes pre-grant, stale, revised and currently excluded source', async (t) => {
  const f = setup(t, [], true)
  const old = f.delivered('before-grant')
  await f.grant()
  assert.deepEqual(f.owner.candidateSourceIds([old.source]), [])
  const fresh = f.delivered('fresh')
  assert.deepEqual(f.owner.candidateSourceIds([fresh.source]), [fresh.source.evidenceId])
  const excluded = f.recreate({ projectEvidence: () => null })
  assert.deepEqual(excluded.candidateSourceIds([fresh.source]), [])
  const db = new DatabaseSync(join(f.directory, 'evidence.sqlite'))
  db.prepare('UPDATE context_evidence SET text=? WHERE id=?').run('edited', fresh.source.sourceId)
  db.close()
  assert.deepEqual(f.owner.candidateSourceIds([fresh.source]), [])
  const stale = f.delivered('stale')
  f.advance(120001)
  assert.deepEqual(f.owner.candidateSourceIds([stale.source]), [])
  assert.equal(f.connections, 0)
})

test('RPA7 private admission freezes canonical bundle and material without a synthetic/live assertion', async (t) => {
  const f = setup(t, [], true)
  await f.grant()
  const a = f.delivered('unlisted')
  const id = await f.owner.consider(a.decision, a.messageId)
  assert.ok(id)
  const action = f.resident.initiatives.action(id!)!
  const packet = JSON.parse(action.envelope.preparedInput.prompt)
  assert.equal(packet.version, 2)
  assert.equal(packet.material, 'canonical-source-snapshot')
  assert.equal(Object.hasOwn(packet, 'synthetic'), false)
  assert.equal(action.envelope.sourceRefs.evidence[0]?.bundleId, 'com.test.editor')
  assert.equal(packet.sources[0].bundleId, 'com.test.editor')
  assert.equal(packet.sources[0].eventRevision, a.source.eventRevision)
  assert.equal(packet.sources[0].sourceRevision, a.source.revision)
  assert.equal(packet.sources[0].provenance.speaker, 'unknown')
  assert.equal(packet.sources[0].provenance.mediaPlayback, 'unknown')
  assert.equal(packet.sources.length, 2)
  assert.equal(packet.sources[1].sourceId, 'personal:atlas')
  assert.equal(action.envelope.sourcePacketHash, hash(packet))
})

test('RPA7 private held source read rechecks context before admission', async (t) => {
  const f = setup(t, [], true)
  await f.grant()
  const a = f.delivered('held')
  f.setRead(async () => {
    f.setFingerprint('changed-during-await')
    return f.snapshot()
  })
  await assert.rejects(f.owner.consider(a.decision, a.messageId), /changed|invalidated|unavailable/)
  assert.equal(f.resident.initiatives.all().length, 0)
  assert.equal(f.connections, 0)
})

test('RPA7 private grant survives store reopen without implicit dispatch or capacity replenishment', async (t) => {
  const f = setup(t, [], true)
  const grant = await f.grant()
  await f.owner.dispose()
  f.reopenStores()
  const reopened = f.recreate()
  assert.deepEqual(f.resident.initiatives.grant(grant.id), grant)
  assert.deepEqual(reopened.candidateSourceIds(), [])
  assert.equal(f.connections, 0)
  assert.equal(f.resident.initiatives.all().length, 0)
})

test('RPA7 private grant lifetime is bounded and late-accepted pre-grant context is not new context', async (t) => {
  const f = setup(t, [], true)
  const grant = await f.grant()
  assert.equal(grant.scope.expiresAt - grant.issuedAt, 30 * 60000)
  assert.throws(
    () =>
      f.resident.initiatives.createGrant(
        { ...grant.scope, expiresAt: f.currentTime() + 30 * 60000 + 1 },
        f.currentTime()
      ),
    /grant-invalid/
  )
  const late = f.delivered('late-accepted', 'com.test.editor', -30000)
  assert.ok(late.source.sequence > grant.scope.afterSequence)
  assert.ok(late.source.observedAt < grant.issuedAt)
  assert.deepEqual(f.owner.candidateSourceIds([late.source]), [])
  await assert.rejects(f.owner.consider(late.decision, late.messageId), /before-grant/)
  assert.equal(f.resident.initiatives.all().length, 0)
  assert.equal(f.connections, 0)
})

test('exact manifest accepts; extra fields, profile/path remap and duplicate endpoints reject', (t) => {
  const f = setup(t)
  assert.deepEqual(validateBriefingNativeManifest(f.manifest), f.manifest)
  for (const bad of [
    { ...f.manifest, extra: true },
    { ...f.manifest, profilePath: 'relative' },
    { ...f.manifest, maxDurationMs: 120001 },
    { ...f.manifest, slots: f.manifest.slots.map((s) => ({ ...s, workspace: '/other' })) },
    { ...f.manifest, slots: [f.manifest.slots[0], f.manifest.slots[0]] },
  ])
    assert.throws(() => validateBriefingNativeManifest(bad))
  assert.equal(briefingQaInstallationId('/profile'), briefingQaInstallationId('/profile'))
  assert.notEqual(briefingQaInstallationId('/profile'), briefingQaInstallationId('/other'))
})
test('preview and activation do not dispatch; exact token consumed once with sequence floor', async (t) => {
  const f = setup(t)
  const preview = (await f.owner.previewGrant()) as { token: string; maxJobs: number }
  assert.equal(preview.maxJobs, 2)
  assert.deepEqual(f.wire, [])
  await f.owner.confirmGrant(preview.token)
  assert.equal(f.resident.initiatives.grants()[0]?.scope.afterSequence, f.evidence.proactive.latestSequence())
  await assert.rejects(f.owner.confirmGrant(preview.token))
  assert.deepEqual(f.wire, [])
})
test('changed page or context after preview refuses activation', async (t) => {
  const f = setup(t)
  const p = (await f.owner.previewGrant()) as { token: string }
  f.setPage({ revision: 'r2' })
  await assert.rejects(f.owner.confirmGrant(p.token))
  const q = (await f.owner.previewGrant()) as { token: string }
  f.setFingerprint('changed')
  await assert.rejects(f.owner.confirmGrant(q.token))
  assert.equal(f.resident.initiatives.grants().length, 0)
})
test('fresh delivered decision admits once with current packet and no Task session', async (t) => {
  const f = setup(t)
  await f.grant()
  const d = f.delivered()
  const actionId = await f.owner.consider(d.decision, d.messageId)
  assert.ok(actionId)
  assert.equal(await f.owner.consider(d.decision, d.messageId), actionId)
  assert.equal(f.resident.initiatives.all().length, 1)
  assert.equal(f.resident.initiatives.grants()[0]?.remainingJobs, 1)
  assert.deepEqual(f.evidence.listWorkItems(), [])
  const action = f.resident.initiatives.action(actionId!)!
  const packet = JSON.parse(action.envelope.preparedInput.prompt)
  assert.equal(packet.version, 1)
  assert.equal(packet.synthetic, true)
  assert.equal(Object.hasOwn(packet, 'material'), false)
  assert.equal(Object.hasOwn(packet.sources[0], 'bundleId'), false)
  assert.deepEqual(packet.candidate, { kind: 'private-briefing', sourceIds: [d.source.evidenceId] })
  assert.equal(packet.sources.length, 2)
  assert.equal(packet.sources[0].revision, createHash('sha256').update(packet.sources[0].text).digest('hex'))
  await f.owner.dispose()
})
test('no grant, wrong decision/message, stale source and attention refuse before admission', async (t) => {
  const f = setup(t)
  const before = f.delivered()
  await assert.rejects(f.owner.consider(before.decision, before.messageId))
  await f.grant()
  await assert.rejects(f.owner.consider(before.decision, before.messageId))
  const current = f.delivered('screen-b')
  await assert.rejects(f.owner.consider({ ...current.decision, text: 'forged' }, current.messageId))
  await assert.rejects(f.owner.consider(current.decision, 'wrong-message'))
  f.setAttention(false)
  await assert.rejects(f.owner.consider(current.decision, current.messageId))
  f.setAttention(true)
  f.advance(121000)
  await assert.rejects(f.owner.consider(current.decision, current.messageId))
  assert.equal(f.resident.initiatives.all().length, 0)
  assert.deepEqual(f.wire, [])
})
test('context change while Personal read is held cannot admit or dispatch', async (t) => {
  const f = setup(t)
  await f.grant()
  const d = f.delivered()
  let finish!: (value: AgentContextSnapshot) => void
  f.setRead(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const pending = f.owner.consider(d.decision, d.messageId)
  f.setFingerprint('changed-during-await')
  finish({ pages: [], checkedAt: NOW, state: 'fresh' })
  await assert.rejects(pending)
  assert.equal(f.resident.initiatives.all().length, 0)
  assert.deepEqual(f.wire, [])
})
test('revocation and replacement never restore old token; candidates require current grant', async (t) => {
  const f = setup(t)
  assert.deepEqual(f.owner.candidateSourceIds(), [])
  const g = await f.grant()
  assert.deepEqual(f.owner.candidateSourceIds(), ['screen-a', 'screen-b'])
  await f.owner.revokeGrant(g.id)
  assert.deepEqual(f.owner.candidateSourceIds(), [])
  const next = await f.grant()
  assert.ok(next.generation > g.generation)
})
test('historical wrong controls and arbitrary result IDs reject without contact', async (t) => {
  const f = setup(t)
  for (const command of ['check', 'stop', 'cancel'])
    await assert.rejects(f.owner.control({ actionId: 'missing', messageId: 'message', command }))
  await assert.rejects(f.owner.openResult({ actionId: 'a', messageId: 'm', resultId: '/private/file' }))
  assert.deepEqual(f.wire, [])
})
test('dispose during pending read fences late completion without remote Stop', async (t) => {
  const f = setup(t)
  const preview = (await f.owner.previewGrant()) as { token: string }
  let finish!: (value: AgentContextSnapshot) => void
  f.setRead(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const pending = f.owner.confirmGrant(preview.token)
  await f.owner.dispose()
  finish({ pages: [], checkedAt: NOW, state: 'fresh' })
  await assert.rejects(pending)
  assert.deepEqual(f.wire, [])
  assert.equal(f.resident.initiatives.grants().length, 0)
})

test('invalidation during unactivated confirmation cannot regain authority when context returns equal', async (t) => {
  const f = setup(t)
  const preview = (await f.owner.previewGrant()) as { token: string }
  let finish!: (value: AgentContextSnapshot) => void
  f.setRead(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const pending = f.owner.confirmGrant(preview.token)
  await f.owner.invalidate()
  finish({
    pages: [
      {
        slug: 'atlas',
        title: 'Atlas',
        content: 'Voor bredere uitrol moet uitval onder 10% zijn.',
        excerpt: '',
        updatedAt: NOW - 1000,
        sourceCount: 0,
        revision: 'r1',
      },
    ],
    checkedAt: NOW,
    state: 'fresh',
  })
  await assert.rejects(pending, /invalidated/)
  assert.equal(f.resident.initiatives.grants().length, 0)
  assert.deepEqual(f.wire, [])
})

test('service recreation presents persisted executing metadata as unknown without contacting the host', async (t) => {
  const f = setup(t)
  await f.grant()
  const d = f.delivered()
  const id = (await f.owner.consider(d.decision, d.messageId))!
  await f.owner.dispose()
  const action = f.resident.initiatives.action(id)!
  assert.equal(f.resident.initiatives.markDispatch(id, action.preparedHash, action.envelope.startedAt), true)
  f.resident.initiatives.observe(
    id,
    {
      version: 1,
      sessionId: 'host-session',
      descriptor: action.prepared.descriptor,
      phase: 'executing',
      createdAt: action.envelope.startedAt,
      updatedAt: action.envelope.startedAt,
      cursor: 0,
      events: [],
      execution: null,
      permission: null,
      writeIntent: null,
      receipt: null,
      completion: null,
      error: null,
    },
    'metadata',
    null,
    action.envelope.startedAt
  )
  const calls = f.wire.length
  const reopened = f.recreate()
  const message = reopened.enrichSnapshot(f.resident.conversation(null)).messages.find((m) => m.id === d.messageId)!
  assert.equal(message.briefingAction?.state, 'unknown')
  assert.deepEqual(message.briefingAction?.allowedControls, ['check', 'stop'])
  assert.equal(f.wire.length, calls)
  assert.equal(f.resident.initiatives.action(id)?.state, 'executing')
  await reopened.dispose()
})

test('failed durable grant revocation still fences its generation and cancels owned unsubmitted action', async (t) => {
  const f = setup(t)
  await f.grant()
  const d = f.delivered()
  const id = (await f.owner.consider(d.decision, d.messageId))!
  const revoke = f.resident.initiatives.revokeGrant.bind(f.resident.initiatives)
  f.resident.initiatives.revokeGrant = () => {
    throw new Error('injected-storage-failure')
  }
  await assert.rejects(f.owner.invalidate(), /injected-storage-failure/)
  assert.deepEqual(f.owner.candidateSourceIds(), [])
  assert.equal(f.resident.initiatives.action(id)?.state, 'cancelled-unsubmitted')
  assert.equal(
    f.wire.some((call) => call.op === 'submit' || call.op === 'authorize-write'),
    false
  )
  f.resident.initiatives.revokeGrant = revoke
  await f.owner.dispose()
})

function completeFixture(
  f: ReturnType<typeof setup>,
  id: string,
  content: string,
  publication: 'publish' | 'withheld' = 'publish',
  silent = false
) {
  const action = f.resident.initiatives.action(id)!
  f.resident.initiatives.markDispatch(id, action.preparedHash, action.envelope.startedAt)
  const contentHash = createHash('sha256').update(content).digest('hex')
  const receipt = {
    version: 1 as const,
    resultId: `historical-result-${id}`,
    descriptorHash: hash(action.prepared.descriptor),
    actionId: id,
    jobId: action.envelope.jobId,
    inputHash: action.prepared.descriptor.inputHash,
    authorityHash: action.prepared.descriptor.authorityHash,
    basename: 'briefing.md' as const,
    contentHash,
    byteLength: Buffer.byteLength(content),
    createdAt: action.envelope.startedAt + 10,
    verifiedAt: action.envelope.startedAt + 11,
  }
  f.advance(20)
  return f.resident.initiatives.observe(
    id,
    {
      version: 1,
      sessionId: 'fixture-host-session',
      descriptor: action.prepared.descriptor,
      phase: 'completed',
      createdAt: action.envelope.startedAt,
      updatedAt: action.envelope.startedAt + 12,
      cursor: 3,
      events: [],
      execution: {
        invocationId: 'fixture-invocation',
        pid: 123,
        providerThreadId: 'fixture-thread',
        exit: { code: 0, signal: null, at: action.envelope.startedAt + 9 },
      },
      permission: null,
      writeIntent: silent
        ? null
        : { contentHash, byteLength: receipt.byteLength, createdAt: receipt.createdAt, state: 'verified' },
      receipt: silent ? null : receipt,
      completion: silent ? 'silent' : 'briefing',
      error: null,
    },
    publication,
    publication === 'publish' && !silent ? { version: 1, receipt, content } : null,
    f.currentTime()
  )
}

async function publishedFixture(
  t: { after(fn: () => void): void },
  publication: 'publish' | 'withheld' = 'publish',
  silent = false
) {
  const f = setup(t)
  const grant = await f.grant()
  const delivery = f.delivered()
  const id = (await f.owner.consider(delivery.decision, delivery.messageId))!
  await f.owner.dispose()
  const content = '# Atlas\nThe drop is lower; the rollout question remains open.'
  const completed = completeFixture(f, id, content, publication, silent)
  const owner = f.recreate()
  const input = { actionId: id, messageId: delivery.messageId, resultId: `historical-result-${id}` }
  return { f, owner, completed, grant, input, content }
}

test('RPA4 published result survives grant expiry locally; new admission remains denied', async (t) => {
  const { f, owner, completed, input, content } = await publishedFixture(t)
  assert.deepEqual(await owner.openResult(input), { title: 'Atlas', content })
  const connections = f.connections
  const wire = structuredClone(f.wire)
  f.advance(31 * 60000)
  assert.deepEqual(await owner.openResult(input), { title: 'Atlas', content })
  const view = owner.enrichSnapshot(f.resident.conversation(null)).messages.find((m) => m.id === input.messageId)!
  assert.equal(view.briefingAction?.state, 'completed')
  assert.equal(view.briefingAction?.result?.id, input.resultId)
  assert.deepEqual(f.resident.initiatives.action(input.actionId), completed)
  assert.deepEqual(owner.candidateSourceIds(), [])
  const next = f.delivered('screen-b')
  await assert.rejects(owner.consider(next.decision, next.messageId), /grant-unavailable/)
  assert.equal(f.connections, connections)
  assert.deepEqual(f.wire, wire)
})

test('RPA4 UI pause and replacement preserve published result through real store reopen', async (t) => {
  const { f, owner, completed, grant, input, content } = await publishedFixture(t)
  const connections = f.connections
  await owner.revokeGrant(grant.id)
  assert.deepEqual(owner.candidateSourceIds(), [])
  assert.deepEqual(await owner.openResult(input), { title: 'Atlas', content })
  assert.deepEqual(f.resident.initiatives.action(input.actionId), completed)
  await owner.dispose()
  f.reopenStores()
  const reopened = f.recreate()
  assert.deepEqual(await reopened.openResult(input), { title: 'Atlas', content })
  const preview = await reopened.previewGrant()
  await reopened.confirmGrant(preview.token)
  assert.deepEqual(await reopened.openResult(input), { title: 'Atlas', content })
  assert.deepEqual(f.resident.initiatives.action(input.actionId), completed)
  assert.deepEqual(reopened.candidateSourceIds(), ['screen-a', 'screen-b'])
  assert.equal(f.connections, connections)
  const next = f.delivered('screen-b')
  const nextId = await reopened.consider(next.decision, next.messageId)
  assert.notEqual(nextId, input.actionId)
  assert.notEqual(f.resident.initiatives.action(nextId!)!.envelope.jobId, completed.envelope.jobId)
  assert.deepEqual(f.resident.initiatives.action(input.actionId), completed)
})

test('RPA4 privacy invalidation after pause latches historical completed result through regrant and reopen', async (t) => {
  const { f, owner, grant, input } = await publishedFixture(t)
  const connections = f.connections
  await owner.revokeGrant(grant.id)
  assert.equal(f.resident.initiatives.action(input.actionId)?.invalidated, false)
  await owner.invalidate()
  assert.equal(f.resident.initiatives.action(input.actionId)?.invalidated, true)
  const preview = await owner.previewGrant()
  await owner.confirmGrant(preview.token)
  await assert.rejects(owner.openResult(input), /invalidated|unavailable/)
  await owner.dispose()
  f.reopenStores()
  const reopened = f.recreate()
  await assert.rejects(reopened.openResult(input), /invalidated|unavailable/)
  assert.equal(
    reopened.enrichSnapshot(f.resident.conversation(null)).messages.find((m) => m.id === input.messageId)
      ?.briefingAction?.state,
    'withheld'
  )
  assert.equal(f.connections, connections)
})

test('RPA4 historical result still requires exact source, account, target, identity and deletion revision', async (t) => {
  const { f, owner, input, content } = await publishedFixture(t)
  const connections = f.connections
  f.advance(31 * 60000)
  assert.deepEqual(await owner.openResult(input), { title: 'Atlas', content })
  await assert.rejects(owner.openResult({ ...input, resultId: 'forged' }), /result-unavailable/)
  await assert.rejects(owner.openResult({ ...input, messageId: 'forged' }), /binding-conflict/)
  f.setPage({ revision: 'r2' })
  await assert.rejects(owner.openResult(input), /source-invalidated/)
  f.setPage({ revision: 'r1' })
  f.setFingerprint('other-account')
  await assert.rejects(owner.openResult(input), /context|grant/)
  f.setFingerprint('context-1')
  const wrongTarget = f.recreate({ manifest: { ...f.manifest, targetEpoch: 'new-epoch' } })
  await assert.rejects(wrongTarget.openResult(input), /binding-conflict/)
  const unavailablePage = f.recreate({ currentPage: () => null })
  await assert.rejects(unavailablePage.openResult(input), /source-invalidated/)
  const excludedEvidence = f.recreate({ projectEvidence: () => null })
  await assert.rejects(excludedEvidence.openResult(input), /source-invalidated/)
  const db = new DatabaseSync(join(f.directory, 'evidence.sqlite'))
  db.exec('UPDATE evidence_privacy SET revision = revision + 1 WHERE id=1')
  db.close()
  await assert.rejects(owner.openResult(input), /action-invalidated/)
  assert.equal(f.connections, connections)
})

test('RPA4 withheld completion is never promoted by historical opening', async (t) => {
  const { f, owner, input, completed } = await publishedFixture(t, 'withheld')
  const connections = f.connections
  await assert.rejects(owner.openResult(input), /result-unavailable/)
  f.advance(31 * 60000)
  await assert.rejects(owner.openResult(input), /result-unavailable/)
  assert.deepEqual(f.resident.initiatives.action(input.actionId), completed)
  assert.equal(f.connections, connections)
})

test('RPA4 privacy invalidation during held historical read fences equal-returning context', async (t) => {
  const { f, owner, grant, input } = await publishedFixture(t)
  const connections = f.connections
  await owner.revokeGrant(grant.id)
  let finish!: (snapshot: AgentContextSnapshot) => void
  f.setRead(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const pending = owner.openResult(input)
  void pending.catch(() => {})
  assert.equal(typeof finish, 'function')
  await owner.invalidate()
  finish(f.snapshot())
  await assert.rejects(pending, /invalidated/)
  assert.equal(f.connections, connections)
})

test('RPA4 failed privacy write after pause still fences historical result and candidate access', async (t) => {
  const { f, owner, grant, input } = await publishedFixture(t)
  const connections = f.connections
  await owner.revokeGrant(grant.id)
  const revoke = f.resident.initiatives.revokeGrant.bind(f.resident.initiatives)
  f.resident.initiatives.revokeGrant = () => {
    throw new Error('injected-privacy-write-failure')
  }
  await assert.rejects(owner.invalidate(), /injected-privacy-write-failure/)
  assert.equal(f.resident.initiatives.action(input.actionId)?.invalidated, false)
  await assert.rejects(owner.openResult(input), /invalidated|unavailable/)
  assert.deepEqual(owner.candidateSourceIds(), [])
  const preview = await owner.previewGrant()
  await owner.confirmGrant(preview.token)
  await assert.rejects(owner.openResult(input), /invalidated|unavailable/)
  assert.equal(f.connections, connections)
  f.resident.initiatives.revokeGrant = revoke
})

test('RPA4 published silent completion retains completed status without inventing a result after expiry, pause and regrant', async (t) => {
  const { f, owner, grant, input, completed } = await publishedFixture(t, 'publish', true)
  const connections = f.connections
  const status = () =>
    owner.enrichSnapshot(f.resident.conversation(null)).messages.find((m) => m.id === input.messageId)!.briefingAction!
  assert.equal(status().state, 'completed')
  f.advance(31 * 60000)
  assert.equal(status().state, 'completed')
  await owner.revokeGrant(grant.id)
  assert.equal(status().state, 'completed')
  const preview = await owner.previewGrant()
  await owner.confirmGrant(preview.token)
  assert.equal(status().state, 'completed')
  assert.equal(status().result, undefined)
  await assert.rejects(owner.openResult(input), /result-unavailable/)
  assert.deepEqual(f.resident.initiatives.action(input.actionId), completed)
  assert.equal(f.connections, connections)
})

test('RPA4 privacy write failure fences older published generation during held read despite explicit regrant', async (t) => {
  const { f, owner, input } = await publishedFixture(t)
  const preview = await owner.previewGrant()
  await owner.confirmGrant(preview.token)
  assert.equal(f.resident.initiatives.grants()[0]?.generation, 2)
  const connections = f.connections
  let finish!: (value: AgentContextSnapshot) => void
  f.setRead(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const pending = owner.openResult(input)
  void pending.catch(() => {})
  assert.equal(typeof finish, 'function')
  const revoke = f.resident.initiatives.revokeGrant.bind(f.resident.initiatives)
  f.resident.initiatives.revokeGrant = () => {
    throw new Error('injected-privacy-write-failure')
  }
  await assert.rejects(owner.invalidate(), /injected-privacy-write-failure/)
  assert.equal(f.resident.initiatives.action(input.actionId)?.invalidated, false)
  assert.deepEqual(owner.candidateSourceIds(), [])
  f.setRead(async () => f.snapshot())
  const next = await owner.previewGrant()
  await owner.confirmGrant(next.token)
  finish(f.snapshot())
  await assert.rejects(pending, /invalidated|unavailable/)
  await assert.rejects(owner.openResult(input), /invalidated|unavailable/)
  assert.equal(f.connections, connections)
  f.resident.initiatives.revokeGrant = revoke
})

test('RPA4 failed pause write fences new execution in owner while historical published result remains readable', async (t) => {
  const { f, owner, grant, input, content } = await publishedFixture(t)
  const connections = f.connections
  const pause = f.resident.initiatives.pauseGrant.bind(f.resident.initiatives)
  f.resident.initiatives.pauseGrant = () => {
    throw new Error('injected-pause-write-failure')
  }
  await assert.rejects(owner.revokeGrant(grant.id), /injected-pause-write-failure/)
  assert.equal(f.resident.initiatives.grant(grant.id)?.enabled, true)
  assert.deepEqual(owner.candidateSourceIds(), [])
  assert.deepEqual(await owner.openResult(input), { title: 'Atlas', content })
  assert.equal(f.connections, connections)
  f.resident.initiatives.pauseGrant = pause
})

test('RPA5 paused historical context survives real store reopen without new host effects', async (t) => {
  const { f, owner, completed, grant, input, content } = await publishedFixture(t)
  await owner.revokeGrant(grant.id)
  await owner.dispose()
  f.reopenStores()
  let reads = 0
  f.setRead(async () => {
    reads += 1
    return f.snapshot()
  })
  const reopened = f.recreate()
  const before = { actions: f.resident.initiatives.all(), wire: structuredClone(f.wire), connections: f.connections }
  const context = await reopened.prepareChatContext()
  const reference = { ...input, resultHash: completed.resultHash! }
  assert.deepEqual(context.references, [reference])
  assert.deepEqual(context.briefings, [
    { reference, content, sources: JSON.parse(completed.envelope.preparedInput.prompt).sources },
  ])
  assert.equal(reads, 1)
  context.assertCurrent()
  reopened.assertReplyReferences(context.references)
  assert.deepEqual(f.resident.initiatives.all(), before.actions)
  assert.deepEqual(f.wire, before.wire)
  assert.equal(f.connections, before.connections)
  assert.deepEqual(f.evidence.listWorkItems(), [])
})

test('RPA5 empty, prepared, withheld and silent results supply no context or reads', async (t) => {
  const empty = setup(t)
  empty.setRead(async () => {
    throw new Error('must-not-read')
  })
  assert.deepEqual((await empty.owner.prepareChatContext()).references, [])
  empty.owner.assertReplyReferences([])
  const pending = await publishedFixture(t, 'withheld')
  pending.f.setRead(async () => {
    throw new Error('must-not-read')
  })
  assert.deepEqual((await pending.owner.prepareChatContext()).briefings, [])
  const silent = await publishedFixture(t, 'publish', true)
  silent.f.setRead(async () => {
    throw new Error('must-not-read')
  })
  assert.deepEqual((await silent.owner.prepareChatContext()).references, [])
  const prepared = setup(t)
  await prepared.grant()
  const delivered = prepared.delivered()
  await prepared.owner.consider(delivered.decision, delivered.messageId)
  assert.deepEqual((await prepared.owner.prepareChatContext()).references, [])
})

test('RPA5 exact references reject unknown, changed, duplicate and malformed bindings', async (t) => {
  const { owner } = await publishedFixture(t)
  const context = await owner.prepareChatContext()
  const reference = context.references[0]!
  for (const bad of [
    { ...reference, actionId: 'unknown' },
    { ...reference, messageId: 'other' },
    { ...reference, resultId: 'other' },
    { ...reference, resultHash: 'a'.repeat(64) },
    { ...reference, extra: true },
    { ...reference, resultHash: null },
  ])
    assert.throws(() => owner.assertReplyReferences([bad as typeof reference]))
  assert.throws(() => owner.assertReplyReferences([reference, reference]))
  assert.throws(() => owner.assertReplyReferences(null as never))
})

test('RPA5 unavailable before read is omitted; invalidation during read rejects even after equal regrant', async (t) => {
  const { f, owner } = await publishedFixture(t)
  f.setFingerprint('other')
  assert.deepEqual((await owner.prepareChatContext()).references, [])
  f.setFingerprint('context-1')
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  f.setRead(async () => {
    entered()
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return f.snapshot()
  })
  const pending = owner.prepareChatContext()
  await started
  await owner.invalidate()
  release()
  await assert.rejects(pending, /invalidated/)
  f.setRead(async () => f.snapshot())
  const preview = await owner.previewGrant()
  await owner.confirmGrant(preview.token)
  assert.deepEqual((await owner.prepareChatContext()).references, [])
})

test('RPA5 source changed during fresh read refuses context rather than returning an old result', async (t) => {
  const { f, owner } = await publishedFixture(t)
  f.setRead(async () => {
    f.setPage({ revision: 'r2', content: 'changed' })
    return f.snapshot()
  })
  await assert.rejects(owner.prepareChatContext(), /invalidated|changed/)
})

test('RPA5 prepared guard owns detached refs and rechecks source, account and evidence deletion', async (t) => {
  const { f, owner } = await publishedFixture(t)
  const context = await owner.prepareChatContext()
  const refs = structuredClone(context.references)
  context.references.length = 0
  context.briefings.length = 0
  context.assertCurrent()
  f.setFingerprint('other')
  assert.throws(context.assertCurrent, /changed|invalidated|unavailable/)
  assert.throws(() => owner.assertReplyReferences(refs), /changed|invalidated|unavailable/)
  f.setFingerprint('context-1')
  f.setPage({ revision: 'r2' })
  assert.throws(context.assertCurrent, /changed|invalidated|unavailable/)
  f.setPage({ revision: 'r1' })
  f.evidence.deleteSession('day')
  assert.throws(context.assertCurrent, /changed|invalidated|conflict/)
})

async function multiplePublishedFixture(t: { after(fn: () => void): void }, contents: string[]) {
  const ids = contents.map((_, i) => `screen-${i}`)
  const f = setup(t, ids)
  let owner = f.owner
  const completed = []
  for (let index = 0; index < contents.length; index += 1) {
    if (index % 2 === 0) {
      const preview = await owner.previewGrant()
      await owner.confirmGrant(preview.token)
    }
    const delivered = f.delivered(ids[index])
    const id = (await owner.consider(delivered.decision, delivered.messageId))!
    await owner.dispose()
    completed.push(completeFixture(f, id, contents[index]!))
    const first = Math.floor((index + 1) / 2) * 2
    owner = f.recreate({
      manifest: {
        ...f.manifest,
        slots: [first, first + 1].map((i) => {
          const jobId = `followup-${i}`
          const directory = `${f.manifest.root}/jobs/${createHash('sha256').update(jobId).digest('hex').slice(0, 24)}`
          return { jobId, directory, workspace: `${directory}/workspace`, endpoint: `tcp://127.0.0.1:${47940 + i}` }
        }),
      },
    })
  }
  return { f, owner, completed }
}

test('RPA5 selects latest three exact results and validates Personal only once', async (t) => {
  const { f, owner, completed } = await multiplePublishedFixture(t, ['one', 'two', 'three', 'four'])
  let reads = 0
  f.setRead(async () => {
    reads += 1
    return f.snapshot()
  })
  const context = await owner.prepareChatContext()
  assert.deepEqual(
    context.briefings.map((entry) => entry.content),
    ['four', 'three', 'two']
  )
  assert.deepEqual(
    context.references.map((entry) => entry.resultHash),
    completed
      .slice(1)
      .reverse()
      .map((entry) => entry.resultHash)
  )
  assert.equal(reads, 1)
  context.assertCurrent()
})

test('RPA5 byte and character bounds omit whole result plus provenance, never partial evidence', async (t) => {
  const { owner, completed } = await multiplePublishedFixture(t, [
    'older',
    'x'.repeat(16300),
    'y'.repeat(16300),
    '€'.repeat(5400),
  ])
  const context = await owner.prepareChatContext()
  assert.deepEqual(
    context.briefings.map((entry) => entry.content),
    ['€'.repeat(5400), 'y'.repeat(16300), 'older']
  )
  assert.ok(JSON.stringify(context.briefings).length <= 48000)
  assert.ok(Buffer.byteLength(JSON.stringify(context.briefings)) <= 48000)
  for (const entry of context.briefings) {
    const stored = completed.find((action) => action.envelope.actionId === entry.reference.actionId)!
    assert.deepEqual(entry.sources, JSON.parse(stored.envelope.preparedInput.prompt).sources)
    assert.equal(entry.content, stored.result!.content)
  }
})

test('RPA5 fresh source unavailable omits unchanged history, but changed account during read rejects', async (t) => {
  const { f, owner } = await publishedFixture(t)
  f.setRead(async () => ({ ...f.snapshot(), state: 'error' }))
  const absent = await owner.prepareChatContext()
  assert.deepEqual(absent.references, [])
  assert.deepEqual(absent.briefings, [])
  absent.assertCurrent()
  f.setRead(async () => {
    f.setFingerprint('changed-during-read')
    return f.snapshot()
  })
  await assert.rejects(owner.prepareChatContext(), /changed|invalidated|unavailable/)
})

test('RPA5 exact result hash detects changed stored content and foreign target owner rejects refs', async (t) => {
  const { f, owner, input, completed } = await publishedFixture(t)
  const context = await owner.prepareChatContext()
  const foreign = f.recreate({ manifest: { ...f.manifest, targetId: 'other-mini' } })
  assert.throws(() => foreign.assertReplyReferences(context.references), /binding-conflict/)
  assert.deepEqual((await foreign.prepareChatContext()).briefings, [])
  const changed = { ...completed.result!, content: 'Unverified replacement' }
  const db = new DatabaseSync(join(f.directory, 'resident.sqlite'))
  try {
    db.prepare('UPDATE assistant_initiative_action SET result_json=? WHERE action_id=?').run(
      JSON.stringify(changed),
      input.actionId
    )
  } finally {
    db.close()
  }
  assert.throws(context.assertCurrent, /result-unavailable/)
  assert.throws(() => owner.assertReplyReferences(context.references), /result-unavailable/)
  assert.deepEqual((await owner.prepareChatContext()).briefings, [])
})
