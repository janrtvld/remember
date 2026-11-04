import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  canonicalBriefingJson,
  hashBriefingValue,
  validateBriefingDescriptor,
  validateBriefingObservation,
  validateBriefingResult,
  validateBriefingSpec,
} from './briefing-protocol.mjs'

const h = (s) => createHash('sha256').update(s).digest('hex')
const canonical = (v) =>
  JSON.stringify(
    v && typeof v === 'object'
      ? Array.isArray(v)
        ? v.map((x) => JSON.parse(canonical(x)))
        : Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, JSON.parse(canonical(v[k]))])
          )
      : v
  )
export function fixture() {
  const packet = { sources: [{ sourceId: 'evidence:1', revision: h('fact'), text: 'fact' }] }
  const directory = `/private/tmp/briefing-test/jobs/${h('job-a').slice(0, 24)}`
  const spec = {
    version: 1,
    preparedInput: {
      prompt: JSON.stringify(packet),
      systemPrompt: 'Make a bounded private briefing.',
      model: 'gpt-5.6-luna',
      effort: 'low',
      threadId: null,
      tools: [],
      maxInputBytes: 49152,
      maxOutputBytes: 16384,
      maxDurationMs: 120000,
    },
    sourcePacketHash: h(canonical(packet)),
    deadlineAt: 2000000000000,
    outputBasename: 'briefing.md',
    workspace: `${directory}/workspace`,
  }
  const descriptor = {
    version: 1,
    actionId: 'action-a',
    jobId: 'job-a',
    assistantMessageId: 'message-a',
    targetId: 'mini',
    targetEpoch: 'generation-1',
    root: '/private/tmp/briefing-test',
    directory,
    workspace: spec.workspace,
    inputHash: h(canonical(spec)),
    authorityHash: h('authority'),
  }
  const receipt = {
    version: 1,
    resultId: 'result-a',
    descriptorHash: h(canonical(descriptor)),
    actionId: 'action-a',
    jobId: 'job-a',
    inputHash: descriptor.inputHash,
    authorityHash: descriptor.authorityHash,
    basename: 'briefing.md',
    contentHash: h('# Briefing\n'),
    byteLength: 11,
    createdAt: 100,
    verifiedAt: 101,
  }
  const observation = {
    version: 1,
    sessionId: 'session-a',
    descriptor,
    phase: 'completed',
    createdAt: 90,
    updatedAt: 102,
    cursor: 3,
    events: [{ seq: 3, type: 'completed', at: 102, data: {} }],
    execution: {
      invocationId: 'invocation-a',
      pid: 123,
      providerThreadId: 'thread-a',
      exit: { code: 0, signal: null, at: 99 },
    },
    permission: null,
    writeIntent: { contentHash: receipt.contentHash, byteLength: 11, createdAt: 100, state: 'verified' },
    receipt,
    completion: 'briefing',
    error: null,
  }
  return { packet, spec, descriptor, receipt, observation }
}
test('canonical exact bound JSON and hash, detached spec/descriptor', () => {
  const { spec, descriptor } = fixture()
  assert.equal(canonicalBriefingJson({ b: 1, a: 2 }), '{"a":2,"b":1}')
  assert.equal(hashBriefingValue(spec), descriptor.inputHash)
  assert.deepEqual(validateBriefingSpec(spec), spec)
  assert.deepEqual(validateBriefingDescriptor(descriptor, spec), descriptor)
})
test('source packet and input hash cannot drift', () => {
  const { spec, descriptor } = fixture()
  assert.throws(() => validateBriefingSpec({ ...spec, sourcePacketHash: h('other') }), /briefing-/)
  assert.throws(() => validateBriefingDescriptor({ ...descriptor, inputHash: h('other') }, spec), /briefing-/)
})
test('canonical paths and exact keyset reject remap or model tool', () => {
  const { spec, descriptor } = fixture()
  for (const patch of [
    { workspace: '/tmp/else' },
    { directory: '/tmp/else' },
    { unknown: true },
    { root: '/private/tmp/../else' },
  ])
    assert.throws(() => validateBriefingDescriptor({ ...descriptor, ...patch }), /briefing-/)
  assert.throws(
    () => validateBriefingSpec({ ...spec, preparedInput: { ...spec.preparedInput, tools: ['shell'] } }),
    /briefing-/
  )
})
test('bounded spec and unknown prepared fields reject', () => {
  const { spec } = fixture()
  for (const patch of [{ maxOutputBytes: 16385 }, { maxDurationMs: 120001 }, { threadId: 'reuse' }, { extra: 'grant' }])
    assert.throws(
      () => validateBriefingSpec({ ...spec, preparedInput: { ...spec.preparedInput, ...patch } }),
      /briefing-/
    )
})
test('completed observation requires genuine exit/verified matching receipt', () => {
  const { descriptor, observation } = fixture()
  assert.deepEqual(validateBriefingObservation(observation, descriptor), observation)
  for (const patch of [
    { execution: { ...observation.execution, exit: null } },
    { receipt: null },
    { completion: null },
    { updatedAt: 1 },
  ])
    assert.throws(() => validateBriefingObservation({ ...observation, ...patch }, descriptor), /briefing-/)
})
test('silent completion has no receipt; unknown may retain receipt without completion', () => {
  const { descriptor, observation } = fixture()
  assert.equal(
    validateBriefingObservation({ ...observation, completion: 'silent', receipt: null, writeIntent: null }, descriptor)
      .completion,
    'silent'
  )
  assert.equal(
    validateBriefingObservation(
      { ...observation, phase: 'unknown', completion: null, error: 'receipt-before-completion' },
      descriptor
    ).phase,
    'unknown'
  )
})
test('events ordered unique and cursor bound, historical assignment refused', () => {
  const { descriptor, observation } = fixture()
  assert.throws(
    () =>
      validateBriefingObservation(
        { ...observation, events: [...observation.events, ...observation.events] },
        descriptor
      ),
    /briefing-/
  )
  assert.throws(() => validateBriefingObservation(observation, { ...descriptor, actionId: 'other' }), /briefing-/)
  assert.throws(() => validateBriefingObservation({ ...observation, cursor: 2 }, descriptor), /briefing-/)
})
test('result verifies exact bytes/identity, no path or inferred receipt', () => {
  const { descriptor, receipt } = fixture()
  assert.equal(
    validateBriefingResult({ version: 1, receipt, content: '# Briefing\n' }, descriptor).receipt.contentHash,
    receipt.contentHash
  )
  for (const v of [
    { version: 1, receipt, content: 'changed' },
    { version: 1, receipt: null, content: '# Briefing\n' },
    { version: 1, receipt, content: '# Briefing\n', path: '/tmp/other' },
  ])
    assert.throws(() => validateBriefingResult(v, descriptor), /briefing-/)
})
