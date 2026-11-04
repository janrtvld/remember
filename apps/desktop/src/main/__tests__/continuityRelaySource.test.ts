import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { authenticationSurfaceMetadata, createRememberRelaySource } from '../continuityRelaySource'

const profile = '/synthetic/remember-profile'
const cliPath = '/synthetic/remember'
const cacheDirectory = '/synthetic/relay-cache'
const observedAt = Date.parse('2026-10-16T10:00:00Z')
type RecordValue = Record<string, unknown>
type Ref = { kind: string; id: string }

function fixture(fixtureOptions: { inboxList?: (offset: number, fallback: RecordValue) => RecordValue } = {}) {
  const calls: string[][] = []
  const records = new Map<string, RecordValue>()
  const details = new Map<string, RecordValue>()
  const openItems: RecordValue[] = []
  const failures = new Set<string>()
  const snapshot = {
    dataDirectory: profile,
    observedAt,
    capture: { availability: 'unknown', status: 'unknown', reason: 'Synthetic disconnected capture' },
    processing: {
      live: null,
      persisted: {
        days: [{ id: 'day-1', sourceRef: ref('day', 'day-1'), memoryCoveredThrough: observedAt - 120_000 }],
      },
    },
    recentDays: [{ sourceRef: ref('day', 'day-1') }],
    recentActivity: [{ sourceRef: ref('context', 'context-1'), preview: true, text: 'Truncated' }] as RecordValue[],
    recentAgentMessages: [],
    inbox: { items: [] as RecordValue[] },
  }
  const state = {
    profile,
    snapshot,
    page: {
      baseline: false,
      changes: [] as RecordValue[],
      nextCursor: 'cursor-2',
      checkpoint: 'cursor-2' as string | null,
      hasMore: false,
      observedAt,
    },
  }
  records.set('day:day-1', { id: 'day-1', memory_json: '{"currentFocus":"Synthetic work"}' })
  records.set('context:context-1', { id: 'context-1', text: 'The full synthetic original beyond the preview.' })
  const source = createRememberRelaySource({
    cliPath,
    dataDirectory: profile,
    cacheDirectory,
    excludedThreadIds: ['relay-session'],
    execute: async (file, args, options) => {
      assert.equal(file, cliPath)
      assert.equal(options.env.REMEMBER_AGENT, 'codex')
      assert.equal(options.env.REMEMBER_DATA_DIR, profile)
      assert.equal(options.env.REMEMBER_CONTINUITY_DIR, cacheDirectory)
      assert.equal(args.at(-1), '--json')
      calls.push(args)
      const command = args.slice(0, -1).join(' ')
      if (failures.has(command)) throw new Error('Synthetic source unavailable')
      let result: unknown
      if (args[0] === 'status') result = { dataDirectory: state.profile }
      else if (args[0] === 'now') result = state.snapshot
      else if (args[0] === 'changes') {
        result = args.includes('--since')
          ? state.page
          : { baseline: true, changes: [], nextCursor: 'baseline-1', hasMore: false, observedAt }
      } else if (args[0] === 'source') {
        const sourceRef = ref(args[2], args[3])
        const key = `${sourceRef.kind}:${sourceRef.id}`
        const record = records.get(key) ?? null
        result = { sourceRef, availability: record ? 'available' : 'not_found', record, ...details.get(key) }
      } else if (args[0] === 'inbox' && args[1] === 'list') {
        const offset = Number(args[args.indexOf('--offset') + 1])
        // Small fake pages exercise full pagination without hundreds of synthetic items.
        const items = openItems.slice(offset, offset + 1)
        const fallback = { items, count: openItems.length, hasMore: offset + items.length < openItems.length }
        result = fixtureOptions.inboxList?.(offset, fallback) ?? fallback
      } else if (args[0] === 'inbox') result = openItems.find((item) => item.id === args[2])
      else throw new Error(`Unexpected synthetic command: ${command}`)
      return { stdout: JSON.stringify(result) }
    },
  })
  return { source, calls, records, details, openItems, failures, state }
}

function ref(kind: string, id: string) {
  return { kind, id }
}

function delta(sourceRef: Ref, operation = 'updated') {
  return { sourceRef, operation }
}

describe('Remember relay source adapter', () => {
  it('establishes the baseline before hydrating full context, coverage and all open Inbox pages', async () => {
    const { source, calls, records, openItems, state } = fixture()
    for (const id of ['item-1', 'item-2']) {
      openItems.push({
        id,
        lifecycle: 'open',
        sourceRef: ref('work_item', id),
        observations: [{ sourceRef: ref('work_item_observation', `blocked-${id}`) }],
      })
      records.set(`work_item:${id}`, { id, lifecycle: 'open', status: 'in_progress' })
      records.set(`work_item_observation:blocked-${id}`, { id: `blocked-${id}`, kind: 'blocked', dismissed_at: null })
    }
    const page = await source.readPage(null)
    assert.deepEqual(
      calls.slice(0, 3).map((args) => args[0]),
      ['status', 'changes', 'now']
    )
    assert.equal(page.baseline, true)
    assert.equal(page.synthetic, false)
    assert.equal(page.cursorBefore, null)
    assert.equal(page.cursorAfter, 'baseline-1')
    assert.equal(page.hasMore, false)
    assert.deepEqual(page.snapshot.capture, state.snapshot.capture)
    assert.deepEqual(page.snapshot.processing, state.snapshot.processing)
    assert.equal(page.snapshot.observedAt, observedAt)
    assert.equal(page.changes.filter((change) => change.sourceRef.kind === 'day').length, 1)
    assert.equal(page.changes.filter((change) => change.sourceRef.kind === 'work_item').length, 2)
    assert.equal(page.changes.filter((change) => change.sourceRef.kind === 'work_item_observation').length, 2)
    assert.equal(
      page.changes.find((change) => change.sourceRef.id === 'context-1')?.record?.text,
      'The full synthetic original beyond the preview.'
    )
    assert.ok(page.changes.every((change) => change.historicalVersionGuaranteed === false))
    assert.ok(page.changes.every((change) => change.changeObservedAt === observedAt))
    assert.ok(page.changes.every((change) => change.readAt >= observedAt))
  })

  it('validates the exact profile on every page and refuses a changed profile before polling', async () => {
    const { source, calls, state } = fixture()
    await source.readPage('cursor-1')
    state.profile = '/synthetic/different-profile'
    await assert.rejects(source.readPage('cursor-2'), /profile mismatch/)
    assert.equal(calls.filter((args) => args[0] === 'status').length, 2)
    assert.equal(calls.filter((args) => args[0] === 'changes').length, 1)
  })

  it('reconciles an offset-scan deletion race without missing the unchanged remaining item', async () => {
    const itemA = { id: 'item-a', sourceRef: ref('work_item', 'item-a'), updatedAt: observedAt }
    const itemB = { id: 'item-b', sourceRef: ref('work_item', 'item-b'), updatedAt: observedAt }
    const listings = [
      { items: [itemA], count: 2, hasMore: true },
      { items: [], count: 1, hasMore: false },
      { items: [itemB], count: 1, hasMore: false },
      { items: [itemB], count: 1, hasMore: false },
    ]
    const offsets: number[] = []
    const { source, records, openItems, calls, state } = fixture({
      inboxList: (offset) => {
        offsets.push(offset)
        const listing = listings.shift()
        assert.ok(listing)
        return listing
      },
    })
    state.snapshot.inbox.items.push(itemA)
    openItems.push(itemB)
    records.set('work_item:item-b', { id: 'item-b', lifecycle: 'open', status: 'in_progress' })
    const page = await source.readPage(null)
    assert.deepEqual(offsets, [0, 1, 0, 0])
    assert.equal(page.changes.find((change) => change.sourceRef.id === 'item-b')?.record?.lifecycle, 'open')
    assert.equal(page.changes.find((change) => change.sourceRef.id === 'item-a')?.availability, 'not_found')
    const firstHydration = calls.findIndex((args) => args[0] === 'inbox' && args[1] === 'read')
    assert.equal(calls.slice(0, firstHydration).filter((args) => args[1] === 'list').length, 4)
    assert.deepEqual((page.snapshot.openInbox as RecordValue).consistency, {
      matchingScans: 2,
      scanCount: 3,
      atomicSnapshot: false,
      note: 'Two complete observed listings matched; detailed source reads may reflect later changes.',
    })
  })

  it('rejects an unstable baseline when versions keep changing across complete scans', async () => {
    let revision = 0
    const { source, calls } = fixture({
      inboxList: () => ({
        items: [{ id: 'item-a', sourceRef: ref('work_item', 'item-a'), updatedAt: observedAt + revision++ }],
        count: 1,
        hasMore: false,
      }),
    })
    await assert.rejects(source.readPage(null), /baseline-unstable/)
    assert.equal(revision, 4)
    assert.ok(!calls.some((args) => args[0] === 'source' || (args[0] === 'inbox' && args[1] === 'read')))
  })

  it('fails closed on snapshot profile mismatch', async () => {
    const { source, state } = fixture()
    state.snapshot.dataDirectory = '/synthetic/other-profile'
    await assert.rejects(source.readPage('cursor-1'), /snapshot profile mismatch/)
  })

  it('returns only the requested page and leaves cursor persistence to the consumer', async () => {
    const { source, state, calls, records } = fixture()
    state.page.hasMore = true
    state.page.checkpoint = null
    state.page.changes = [delta(ref('focus', 'focus-1'))]
    records.set('focus:focus-1', { id: 'focus-1', started_at: observedAt, application_id: 1 })
    const page = await source.readPage('cursor-1')
    assert.equal(page.hasMore, true)
    assert.equal(page.cursorBefore, 'cursor-1')
    assert.equal(page.cursorAfter, 'cursor-2')
    assert.equal(page.changes[0].sourceRef.kind, 'focus')
    assert.equal(calls.filter((args) => args[0] === 'changes').length, 1)
    assert.ok(calls.find((args) => args[0] === 'changes')?.includes('200'))
  })

  it('aborts a page on source failure and can retry the same cursor', async () => {
    const { source, state, failures, calls } = fixture()
    state.page.changes = [delta(ref('context', 'context-1'))]
    failures.add('source read context context-1')
    await assert.rejects(source.readPage('cursor-1'), /Synthetic source unavailable/)
    failures.clear()
    const page = await source.readPage('cursor-1')
    assert.equal(page.cursorBefore, 'cursor-1')
    assert.equal(page.changes.length, 1)
    assert.deepEqual(
      calls.filter((args) => args[0] === 'changes').map((args) => args[args.indexOf('--since') + 1]),
      ['cursor-1', 'cursor-1']
    )
  })

  it('returns explicit deletion and disappeared-source tombstones without failing a page', async () => {
    const { source, state, calls } = fixture()
    state.page.changes = [delta(ref('context', 'removed'), 'deleted'), delta(ref('audio', 'excluded'), 'updated')]
    const page = await source.readPage('cursor-1')
    assert.deepEqual(
      page.changes.map(({ operation, availability, record, readContentHash }) => ({
        operation,
        availability,
        record,
        readContentHash,
      })),
      ['deleted', 'updated'].map((operation) => ({
        operation,
        availability: 'not_found',
        record: null,
        readContentHash: null,
      }))
    )
    assert.ok(!calls.some((args) => args[0] === 'source' && args[3] === 'removed'))
  })

  it('preserves complete source details and hashes current records canonically', async () => {
    const { source, records, details } = fixture()
    records.set('conversation:conversation-1', { id: 'conversation-1', nested: { second: 2, first: 1 } })
    details.set('conversation:conversation-1', {
      analyses: [{ summary: 'Full analysis' }],
      speechSegments: [{ text: 'Full' }],
    })
    const first = await source.lookup('conversation', 'conversation-1')
    records.set('conversation:conversation-1', { nested: { first: 1, second: 2 }, id: 'conversation-1' })
    const second = await source.lookup('conversation', 'conversation-1')
    assert.equal(first.readContentHash, second.readContentHash)
    assert.deepEqual(first.sourceDetails?.analyses, [{ summary: 'Full analysis' }])
    assert.equal(second.historicalVersionGuaranteed, false)
    records.set('conversation:conversation-1', { id: 'conversation-1', text: 'Later correction' })
    const corrected = await source.lookup('conversation', 'conversation-1')
    assert.notEqual(first.readContentHash, corrected.readContentHash)
  })

  it('marks known nonhuman relay sessions and structured envelopes while keeping human intent', async () => {
    const { source, records } = fixture()
    records.set('agent_event:relay', {
      role: 'assistant',
      session_id: 'relay-session',
      content: 'Processed the batch.',
    })
    records.set('agent_event:human', {
      role: 'user',
      session_id: 'relay-session',
      content: 'Please change the actual design.',
    })
    records.set('agent_event:other', {
      role: 'assistant',
      session_id: 'real-work-session',
      content: 'Completed a feature.',
    })
    records.set('context:protocol', {
      text: JSON.stringify({ kind: 'remember.context.batch', runId: 'synthetic-run', batchId: 'synthetic-run:1' }),
    })
    records.set('agent_event:protocol', {
      content: JSON.stringify({ kind: 'remember.context.batch', runId: 'synthetic-run', batchId: 'synthetic-run:1' }),
    })
    records.set('context:ordinary', {
      text: 'I am designing a remember.context.batch API, with runId and batchId fields. This is actual engineering work.',
    })
    for (const [kind, id] of [
      ['agent_event', 'relay'],
      ['agent_event', 'protocol'],
    ]) {
      const change = await source.lookup(kind, id)
      assert.equal(change.origin, 'relay')
      assert.equal(change.eligibleForWorkUpdate, false)
      assert.ok(change.record)
    }
    for (const [kind, id] of [
      ['agent_event', 'human'],
      ['agent_event', 'other'],
      ['context', 'ordinary'],
      ['context', 'protocol'],
    ]) {
      const change = await source.lookup(kind, id)
      assert.equal(change.origin, 'source')
      assert.equal(change.eligibleForWorkUpdate, true)
    }
  })

  it('labels exact excluded-thread surface provenance while preserving human intent and raw content', async () => {
    const { source, records } = fixture()
    records.set('context:own-thread', {
      id: 'own-thread',
      role: 'user',
      thread_id: 'relay-session',
      text: 'Human correction: the project is completed, not blocked.',
    })
    records.set('context:own-url', {
      id: 'own-url',
      url: 'https://chatgpt.com/c/relay-session',
      text: 'Human and assistant messages share this visible surface.',
    })
    records.set('context:codex-url', { url: 'codex://threads/relay-session', text: 'Current task.' })
    const ownThread = await source.lookup('context', 'own-thread')
    assert.equal(ownThread.selfEcho?.classification, 'confirmed')
    assert.equal(ownThread.selfEcho?.basis, 'exact_thread_metadata')
    assert.equal(ownThread.selfEcho?.scope, 'surface_provenance_only')
    assert.equal(ownThread.selfEcho?.threadId, 'relay-session')
    assert.equal(ownThread.eligibleForWorkUpdate, true)
    assert.equal(ownThread.origin, 'source')
    assert.deepEqual(ownThread.record, records.get('context:own-thread'))
    for (const id of ['own-url', 'codex-url']) {
      const change = await source.lookup('context', id)
      assert.equal(change.selfEcho?.classification, 'confirmed')
      assert.equal(change.selfEcho?.basis, 'exact_thread_url')
      assert.equal(change.eligibleForWorkUpdate, true)
      assert.deepEqual(change.record, records.get(`context:${id}`))
    }
  })

  it('keeps ambiguous full chat snapshots and short reconnect fragments explicitly uncertain', async () => {
    const { source, records } = fixture()
    const fragments = [
      { trigger: 'app-change', text: 'Synthetic human and assistant conversation. '.repeat(300) },
      { trigger: 'content-change:new-visible-text', text: 'Working\nSynthetic project, Active' },
      { trigger: 'content-change:new-visible-text', text: 'Reconnect' },
      { trigger: 'content-change:new-visible-text', text: 'Reconnecting…' },
    ]
    for (const [index, fragment] of fragments.entries()) {
      const record = {
        id: `chat-fragment-${index}`,
        application_id: 6,
        focus_segment_id: 'synthetic-focus',
        window_title: 'ChatGPT',
        url: 'app://-/index.html',
        ...fragment,
      }
      records.set(`context:${record.id}`, record)
      const change = await source.lookup('context', record.id)
      assert.deepEqual(change.selfEcho, {
        classification: 'uncertain',
        basis: 'no_exact_thread_identity',
        scope: 'surface_provenance_only',
      })
      assert.equal(change.eligibleForWorkUpdate, true)
      assert.deepEqual(change.record, record)
    }
  })

  it('does not confirm another project chat or a lookalike thread URL as own relay work', async () => {
    const { source, records } = fixture()
    for (const [id, metadata] of [
      ['other-project', { url: 'https://chatgpt.com/c/other-project', window_title: 'ChatGPT' }],
      ['lookalike-host', { url: 'https://chatgpt.com.example.test/c/relay-session' }],
      ['lookalike-id', { threadId: 'relay-session-extra' }],
    ] as const) {
      records.set(`context:${id}`, { ...metadata, text: 'Real project work and human instructions.' })
      const change = await source.lookup('context', id)
      assert.notEqual(change.selfEcho?.classification, 'confirmed')
      assert.equal(change.origin, 'source')
      assert.equal(change.eligibleForWorkUpdate, true)
      assert.equal(change.record?.text, 'Real project work and human instructions.')
    }
  })

  it('keeps conflicting explicit thread identities uncertain', async () => {
    const { source, records } = fixture()
    records.set('context:conflict', {
      thread_id: 'another-project',
      url: 'https://chatgpt.com/c/relay-session',
      text: 'Mixed identity metadata must not prove this is the relay conversation.',
    })
    const change = await source.lookup('context', 'conflict')
    assert.equal(change.selfEcho?.classification, 'uncertain')
    assert.equal(change.selfEcho?.basis, 'conflicting_thread_identity')
    assert.equal(change.eligibleForWorkUpdate, true)
  })

  it('labels an embedded structured relay example as uncertain without dropping mixed human prose', async () => {
    const { source, records } = fixture()
    const text =
      'Please review this protocol example in the other project.\n```json\n' +
      JSON.stringify({ kind: 'remember.context.batch', runId: 'synthetic', batchId: 'synthetic:1' }, null, 2) +
      '\n```\nHuman correction: keep the actual project open.'
    records.set('context:mixed-example', { text, window_title: 'ChatGPT' })
    const change = await source.lookup('context', 'mixed-example')
    assert.equal(change.selfEcho?.classification, 'uncertain')
    assert.equal(change.selfEcho?.basis, 'embedded_relay_marker')
    assert.equal(change.eligibleForWorkUpdate, true)
    assert.equal(change.record?.text, text)
  })

  it('preserves exact protocol JSON and delegation examples captured in another project chat', async () => {
    const { source, records } = fixture()
    const texts = [
      JSON.stringify({ kind: 'remember.context.batch', runId: 'synthetic', batchId: 'synthetic:1' }),
      '<codex_delegation><source_thread_id>relay-session</source_thread_id><input>Example only</input></codex_delegation>',
    ]
    for (const [index, text] of texts.entries()) {
      records.set(`context:quoted-protocol-${index}`, {
        url: 'https://chatgpt.com/c/other-project',
        text,
      })
      const change = await source.lookup('context', `quoted-protocol-${index}`)
      assert.equal(change.selfEcho?.classification, 'uncertain')
      assert.equal(change.origin, 'source')
      assert.equal(change.eligibleForWorkUpdate, true)
      assert.equal(change.record?.text, text)
    }
  })

  it('does not add uncertain chat labels to unrelated ordinary context', async () => {
    const { source, records } = fixture()
    records.set('context:editor', { window_title: 'Editor', text: 'Ordinary engineering work.' })
    const change = await source.lookup('context', 'editor')
    assert.equal(change.selfEcho, undefined)
    assert.equal(change.eligibleForWorkUpdate, true)
  })

  it('inherits relay attribution for spans from the exact parent event', async () => {
    const { source, records } = fixture()
    records.set('agent_event:event-1', { role: 'assistant', session_id: 'relay-session', content: 'Applied ACK.' })
    records.set('agent_span:span-1', { id: 'span-1', event_id: 'event-1', status: 'completed' })
    const span = await source.lookup('agent_span', 'span-1')
    assert.equal(span.origin, 'relay')
    assert.equal(span.eligibleForWorkUpdate, false)
    assert.equal(span.record?.status, 'completed')
  })

  it('recognizes a whole known delegation wrapper without treating ordinary user messages as relay output', async () => {
    const { source, records } = fixture()
    const wrapper =
      '<codex_delegation><source_thread_id>relay-session</source_thread_id><input>' +
      '{"kind":"remember.context.ack","batchId":"batch-1"}\nApply this ACK and rearm.' +
      '</input></codex_delegation>'
    records.set('agent_event:delegation', { role: 'user', session_id: 'relay-session', content: wrapper })
    records.set('agent_event:human-quote', {
      role: 'user',
      session_id: 'relay-session',
      content: `Please explain this delegation format: ${wrapper}`,
    })
    records.set('agent_event:unknown-delegation', {
      role: 'user',
      content: wrapper.replace('<source_thread_id>relay-session', '<source_thread_id>another-task'),
    })
    assert.equal((await source.lookup('agent_event', 'delegation')).eligibleForWorkUpdate, false)
    assert.equal((await source.lookup('agent_event', 'human-quote')).eligibleForWorkUpdate, true)
    assert.equal((await source.lookup('agent_event', 'unknown-delegation')).eligibleForWorkUpdate, true)
  })

  it('recognizes actual batch and ACK envelopes without a proof-run identifier', async () => {
    const { source, records } = fixture()
    const envelopes = [
      {
        kind: 'remember.context.batch',
        schemaVersion: 1,
        batchId: 'batch-1',
        sequence: 1,
        consumerId: 'synthetic-consumer',
        profileId: profile,
        payloadHash: 'synthetic-hash',
      },
      {
        kind: 'remember.context.ack',
        batchId: 'batch-1',
        sequence: 1,
        consumerId: 'synthetic-consumer',
        payloadHash: 'synthetic-hash',
      },
      {
        kind: 'remember.context.acknowledged',
        acknowledged: true,
        duplicate: false,
        batchId: 'batch-1',
        sequence: 1,
        appliedSequence: 1,
      },
      { kind: 'remember.context.waiting', checkedAt: observedAt, rearmRequired: true, status: {} },
    ]
    for (const [index, envelope] of envelopes.entries()) {
      records.set(`context:protocol-${index}`, { text: JSON.stringify(envelope) })
      records.set(`agent_event:protocol-${index}`, { content: JSON.stringify(envelope) })
      const change = await source.lookup('context', `protocol-${index}`)
      assert.equal(change.origin, 'source')
      assert.equal(change.eligibleForWorkUpdate, true)
      assert.equal(change.selfEcho?.classification, 'uncertain')
      const event = await source.lookup('agent_event', `protocol-${index}`)
      assert.equal(event.origin, 'relay')
      assert.equal(event.eligibleForWorkUpdate, false)
    }
    records.set('context:human-with-example', {
      text: `Please fix the batch format in this example: ${JSON.stringify(envelopes[0])}`,
    })
    assert.equal((await source.lookup('context', 'human-with-example')).eligibleForWorkUpdate, true)
  })

  it('fresh checks keep unknown capture and lagging interpretation visible without a delta call', async () => {
    const { source, calls, state } = fixture()
    assert.deepEqual(await source.fresh(), state.snapshot)
    assert.deepEqual(
      calls.map((args) => args[0]),
      ['status', 'now']
    )
  })

  it('omits authentication previews and skips their full source lookup before transport', async () => {
    const { source, calls, state, records } = fixture()
    state.snapshot.recentActivity = [
      {
        id: 'context-auth',
        sourceRef: ref('context', 'context-auth'),
        applicationId: 33,
        windowTitle: 'Login',
        url: 'https://example.test/login?synthetic-private-query=1',
        text: 'SYNTHETIC_AUTH_BODY',
        timestamp: observedAt,
      },
    ]
    state.page.changes = [delta(ref('context', 'context-auth'))]
    records.set('context:context-auth', { text: 'SYNTHETIC_FULL_AUTH_BODY' })
    const page = await source.readPage('cursor-1')
    const change = page.changes[0]
    assert.ok(!calls.some((args) => args[0] === 'source' && args[3] === 'context-auth'))
    assert.equal(change.origin, 'source')
    assert.equal(change.eligibleForWorkUpdate, false)
    assert.equal(change.record?.applicationId, 33)
    assert.equal(change.record?.omissionReason, 'authentication_surface')
    assert.equal(change.selfEcho, undefined)
    assert.equal(change.redaction?.detection, 'preview_metadata')
    assert.ok(change.redaction?.omittedFields.includes('text'))
    assert.doesNotMatch(JSON.stringify(page), /SYNTHETIC_AUTH_BODY|SYNTHETIC_FULL_AUTH_BODY|synthetic-private-query/)
    assert.deepEqual((page.snapshot.privacyOmissions as RecordValue[])[0].sourceRef, ref('context', 'context-auth'))
    assert.deepEqual(page.snapshot.capture, state.snapshot.capture)
    assert.deepEqual(page.snapshot.processing, state.snapshot.processing)
  })

  it('omits a source body based on returned metadata when no prelookup metadata exists', async () => {
    const { source, records, calls } = fixture()
    records.set('context:old-auth', {
      id: 'old-auth',
      application_id: 33,
      window_title: 'Sign in — Example',
      url: 'https://example.test/session/sign-in',
      text: 'SYNTHETIC_OLD_AUTH_BODY',
      focused_element_json: '{"synthetic":"private-field"}',
      timestamp: observedAt,
    })
    const change = await source.lookup('context', 'old-auth')
    assert.equal(calls.filter((args) => args[0] === 'source').length, 1)
    assert.equal(change.redaction?.detection, 'source_metadata')
    assert.equal(change.record?.timestamp, observedAt)
    assert.equal(change.record?.contentOmitted, true)
    assert.doesNotMatch(JSON.stringify(change), /SYNTHETIC_OLD_AUTH_BODY|private-field|https:|Sign in/)
  })

  it('preserves engineering context, same-app work and human corrections without a broad app filter', async () => {
    const { source, records } = fixture()
    records.set('context:engineering', {
      id: 'engineering',
      application_id: 33,
      window_title: 'Login.tsx — Visual Studio Code',
      url: 'https://example.test/docs/auth',
      text: 'Review the login implementation.',
    })
    records.set('work_item:login-fix', { id: 'login-fix', title: 'Login', lifecycle: 'completed', status: 'completed' })
    const engineering = await source.lookup('context', 'engineering')
    const correction = await source.lookup('work_item', 'login-fix')
    assert.equal(engineering.eligibleForWorkUpdate, true)
    assert.equal(engineering.record?.text, 'Review the login implementation.')
    assert.equal(correction.eligibleForWorkUpdate, true)
    assert.equal(correction.record?.lifecycle, 'completed')
  })

  it('uses only surface metadata for authentication classification', () => {
    const bodyMustNotBeRead = {
      window_title: 'Editor',
      url: 'https://example.test/docs/auth',
      get text() {
        throw new Error('Body inspection is forbidden')
      },
    }
    assert.equal(authenticationSurfaceMetadata(bodyMustNotBeRead), false)
    for (const metadata of [
      { windowTitle: 'Login' },
      { window: 'Inloggen' },
      { url: 'https://example.test/en/users/sign_in' },
      { url: 'https://login.example.test/' },
      { url: 'https://example.test/oauth2/authorize' },
    ]) {
      assert.equal(authenticationSurfaceMetadata(metadata), true)
    }
    assert.equal(authenticationSurfaceMetadata({ title: 'Login' }), true)
    assert.equal(authenticationSurfaceMetadata({ title: 'Login implementation plan' }), false)
  })

  it('omits URL userinfo and sensitive parameter names without inspecting parameter values', () => {
    for (const url of [
      'https://synthetic-user@example.test/',
      'https://synthetic-user:synthetic-password@example.test/',
      'https://example.test/callback?access_token=',
      'https://example.test/callback?ID_TOKEN=synthetic',
      'https://example.test/callback?refresh_token=synthetic',
      'https://example.test/callback?client_secret=synthetic',
      'https://example.test/callback?password=synthetic',
    ]) {
      assert.equal(authenticationSurfaceMetadata({ url }), true)
    }
    assert.equal(authenticationSurfaceMetadata({ url: 'https://example.test/docs/login?topic=password' }), false)
  })

  it('recognizes precise authentication hosts and versioned routes while preserving documentation articles', () => {
    for (const url of [
      'https://accounts.google.com/v3/signin/identifier',
      'https://accounts.google.com/',
      'https://appleid.apple.com/',
      'https://example.test/v3/signin',
      'https://example.test/en/v2.0/auth/authorize',
    ]) {
      assert.equal(authenticationSurfaceMetadata({ url }), true)
    }
    for (const url of [
      'https://example.test/docs/login',
      'https://example.test/docs/v3/signin',
      'https://accounts.google.com.example.test/docs/login',
    ]) {
      assert.equal(authenticationSurfaceMetadata({ url }), false)
    }
  })

  it('recognizes exact macOS loginwindow app and window metadata without scanning text', async () => {
    for (const metadata of [
      { window_title: 'loginwindow' },
      { windowTitle: 'loginwindow' },
      { application: 'loginwindow' },
      { applicationName: 'loginwindow' },
      { applicationBundleId: 'com.apple.loginwindow' },
      { bundle_id: 'com.apple.loginwindow' },
      { appId: 'com.apple.loginwindow' },
    ]) {
      assert.equal(authenticationSurfaceMetadata(metadata), true)
    }
    assert.equal(authenticationSurfaceMetadata({ text: 'loginwindow' }), false)
    assert.equal(authenticationSurfaceMetadata({ window_title: 'loginwindow architecture documentation' }), false)
    assert.equal(authenticationSurfaceMetadata({ bundle_id: 'com.example.loginwindow-docs' }), false)
    const { source, records } = fixture()
    records.set('context:mac-login', {
      id: 'mac-login',
      window_title: 'loginwindow',
      text: 'SYNTHETIC_MAC_LOGIN_BODY',
    })
    const change = await source.lookup('context', 'mac-login')
    assert.equal(change.record?.omissionReason, 'authentication_surface')
    assert.equal(change.eligibleForWorkUpdate, false)
    assert.doesNotMatch(JSON.stringify(change), /SYNTHETIC_MAC_LOGIN_BODY/)
  })

  it('does not retain a stale authentication preview after the source is corrected', async () => {
    const { source, state, records } = fixture()
    state.page.changes = [delta(ref('context', 'context-1'))]
    state.snapshot.recentActivity = [{ sourceRef: ref('context', 'context-1'), windowTitle: 'Login' }]
    assert.equal((await source.readPage('cursor-1')).changes[0].eligibleForWorkUpdate, false)
    state.snapshot.recentActivity = [{ sourceRef: ref('context', 'context-1'), windowTitle: 'Editor' }]
    records.set('context:context-1', { id: 'context-1', window_title: 'Editor', text: 'Corrected ordinary work.' })
    const page = await source.readPage('cursor-2')
    assert.equal(page.changes[0].eligibleForWorkUpdate, true)
    assert.equal(page.changes[0].record?.text, 'Corrected ordinary work.')
  })

  it('requires explicit absolute paths and an isolated cache outside the source profile', () => {
    for (const cache of [profile, `${profile}/.continuity`, 'relative-cache']) {
      assert.throws(() =>
        createRememberRelaySource({ cliPath, dataDirectory: profile, cacheDirectory: cache, excludedThreadIds: [] })
      )
    }
  })

  it('cancels in-flight hydration without returning a partially processed page', async () => {
    const controller = new AbortController()
    const calls: string[] = []
    let notifyHydration: () => void = () => {}
    const hydrationStarted = new Promise<void>((resolve) => {
      notifyHydration = resolve
    })
    const source = createRememberRelaySource({
      cliPath,
      dataDirectory: profile,
      cacheDirectory,
      excludedThreadIds: [],
      signal: controller.signal,
      execute: async (_file, args, options) => {
        assert.equal(options.signal, controller.signal)
        calls.push(args[0])
        if (args[0] === 'source') {
          return new Promise((_, reject) => {
            options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
            notifyHydration()
          })
        }
        const result =
          args[0] === 'changes'
            ? {
                baseline: false,
                changes: [delta(ref('context', 'context-1'))],
                nextCursor: 'cursor-2',
                hasMore: false,
                observedAt,
              }
            : { dataDirectory: profile }
        return { stdout: JSON.stringify(result) }
      },
    })
    const page = source.readPage('cursor-1')
    await hydrationStarted
    controller.abort(new Error('Synthetic cancelled hydration'))
    await assert.rejects(page, /Synthetic cancelled hydration/)
    await assert.rejects(source.fresh(), /Synthetic cancelled hydration/)
    assert.deepEqual(calls, ['status', 'changes', 'now', 'source'])
  })
})
