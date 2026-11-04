import { createHash } from 'node:crypto'
import { posix } from 'node:path'

export const BRIEFING_PROTOCOL = 'remember-private-briefing-v1'
export const BRIEFING_LIMITS = Object.freeze({
  inputBytes: 49152,
  outputBytes: 16384,
  rpcBytes: 65536,
  maxEvents: 512,
  maxDurationMs: 120000,
  leaseMs: 3000,
})
const phases = new Set(['accepted', 'executing', 'awaiting-write-permission', 'completed', 'stopped', 'unknown'])
const fail = (reason = 'invalid') => {
  throw new Error(`briefing-${reason}`)
}
export const hashBriefingText = (value) => createHash('sha256').update(value).digest('hex')
export function canonicalBriefingJson(value, maxBytes = BRIEFING_LIMITS.rpcBytes) {
  const seen = new Set()
  let nodes = 0
  const walk = (v, depth) => {
    if (++nodes > 10000 || depth > 20) fail('json-bound')
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return v
    if (typeof v === 'string') {
      if (Buffer.byteLength(v) > maxBytes) fail('json-bound')
      return v
    }
    if (
      typeof v !== 'object' ||
      seen.has(v) ||
      (!Array.isArray(v) && ![null, Object.prototype].includes(Object.getPrototypeOf(v)))
    )
      fail('json-invalid')
    seen.add(v)
    const result = Array.isArray(v)
      ? v.map((x) => walk(x, depth + 1))
      : Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, walk(v[k], depth + 1)])
        )
    seen.delete(v)
    return result
  }
  const result = JSON.stringify(walk(value, 0))
  if (Buffer.byteLength(result) > maxBytes) fail('json-bound')
  return result
}
export const hashBriefingValue = (value) => hashBriefingText(canonicalBriefingJson(value))
const clone = (value) => JSON.parse(canonicalBriefingJson(value))
function obj(v, keys) {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(v, k))
  )
    fail('keys-invalid')
  return v
}
function str(v, max = 200) {
  if (
    typeof v !== 'string' ||
    !v.trim() ||
    Buffer.byteLength(v) > max ||
    [...v].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    fail('string-invalid')
}
function digest(v) {
  if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) fail('digest-invalid')
}
function time(v) {
  if (!Number.isSafeInteger(v) || v < 0) fail('time-invalid')
}
function filePath(v) {
  str(v, 2000)
  if (!v.startsWith('/') || v === '/' || posix.normalize(v) !== v || v.endsWith('/') || v.includes('\\'))
    fail('path-invalid')
}
function bytes(v) {
  if (!Number.isSafeInteger(v) || v < 1 || v > BRIEFING_LIMITS.outputBytes) fail('output-bound')
}
export function validateBriefingSpec(value) {
  const s = obj(clone(value), [
    'version',
    'preparedInput',
    'sourcePacketHash',
    'deadlineAt',
    'outputBasename',
    'workspace',
  ])
  if (s.version !== 1 || s.outputBasename !== 'briefing.md') fail('spec-invalid')
  filePath(s.workspace)
  time(s.deadlineAt)
  digest(s.sourcePacketHash)
  const p = obj(s.preparedInput, [
    'prompt',
    'systemPrompt',
    'model',
    'effort',
    'threadId',
    'tools',
    'maxInputBytes',
    'maxOutputBytes',
    'maxDurationMs',
  ])
  if (typeof p.prompt !== 'string' || typeof p.systemPrompt !== 'string' || !p.systemPrompt.trim())
    fail('prompt-invalid')
  if (p.threadId !== null || !Array.isArray(p.tools) || p.tools.length !== 0) fail('tools-forbidden')
  str(p.model, 100)
  if (!/^[a-zA-Z0-9._-]+$/.test(p.model) || !['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(p.effort))
    fail('model-invalid')
  for (const [key, max] of [
    ['maxInputBytes', BRIEFING_LIMITS.inputBytes],
    ['maxOutputBytes', BRIEFING_LIMITS.outputBytes],
    ['maxDurationMs', BRIEFING_LIMITS.maxDurationMs],
  ])
    if (!Number.isSafeInteger(p[key]) || p[key] < 1 || p[key] > max) fail('limit-invalid')
  if (Buffer.byteLength(`${p.systemPrompt}\n${p.prompt}`) > p.maxInputBytes) fail('input-bound')
  let packet
  try {
    packet = JSON.parse(p.prompt)
  } catch {
    fail('packet-invalid')
  }
  if (
    !packet ||
    typeof packet !== 'object' ||
    !Array.isArray(packet.sources) ||
    packet.sources.length < 1 ||
    packet.sources.length > 8 ||
    hashBriefingValue(packet) !== s.sourcePacketHash
  )
    fail('packet-invalid')
  const ids = new Set()
  for (const source of packet.sources) {
    if (!source || typeof source !== 'object') fail('source-invalid')
    str(source.sourceId, 100)
    digest(source.revision)
    if (
      typeof source.text !== 'string' ||
      !source.text.trim() ||
      hashBriefingText(source.text) !== source.revision ||
      ids.has(source.sourceId)
    )
      fail('source-invalid')
    ids.add(source.sourceId)
  }
  return s
}
export function validateBriefingSlot(value) {
  const d = obj(clone(value), ['version', 'targetId', 'targetEpoch', 'root', 'directory', 'workspace', 'jobId'])
  if (d.version !== 1) fail('slot-version')
  for (const k of ['jobId', 'targetId', 'targetEpoch']) str(d[k])
  for (const k of ['root', 'directory', 'workspace']) filePath(d[k])
  if (
    d.directory !== `${d.root}/jobs/${hashBriefingText(d.jobId).slice(0, 24)}` ||
    d.workspace !== `${d.directory}/workspace`
  )
    fail('slot-path')
  return d
}
export function validateBriefingDescriptor(value, spec) {
  const d = obj(clone(value), [
    'version',
    'actionId',
    'jobId',
    'assistantMessageId',
    'targetId',
    'targetEpoch',
    'root',
    'directory',
    'workspace',
    'inputHash',
    'authorityHash',
  ])
  if (d.version !== 1) fail('descriptor-version')
  for (const k of ['actionId', 'jobId', 'assistantMessageId', 'targetId', 'targetEpoch']) str(d[k])
  for (const k of ['root', 'directory', 'workspace']) filePath(d[k])
  digest(d.inputHash)
  digest(d.authorityHash)
  if (
    d.directory !== `${d.root}/jobs/${hashBriefingText(d.jobId).slice(0, 24)}` ||
    d.workspace !== `${d.directory}/workspace`
  )
    fail('descriptor-path')
  if (spec) {
    const s = validateBriefingSpec(spec)
    if (s.workspace !== d.workspace || hashBriefingValue(s) !== d.inputHash) fail('descriptor-input')
  }
  return d
}
export function validateBriefingReceipt(value, descriptor) {
  const r = obj(clone(value), [
    'version',
    'resultId',
    'descriptorHash',
    'actionId',
    'jobId',
    'inputHash',
    'authorityHash',
    'basename',
    'contentHash',
    'byteLength',
    'createdAt',
    'verifiedAt',
  ])
  if (r.version !== 1 || r.basename !== 'briefing.md') fail('receipt-invalid')
  for (const k of ['resultId', 'actionId', 'jobId']) str(r[k])
  for (const k of ['descriptorHash', 'inputHash', 'authorityHash', 'contentHash']) digest(r[k])
  bytes(r.byteLength)
  time(r.createdAt)
  time(r.verifiedAt)
  if (r.verifiedAt < r.createdAt) fail('clock-regression')
  if (descriptor) {
    const d = validateBriefingDescriptor(descriptor)
    if (
      r.descriptorHash !== hashBriefingValue(d) ||
      ['actionId', 'jobId', 'inputHash', 'authorityHash'].some((k) => r[k] !== d[k])
    )
      fail('receipt-binding')
  }
  return r
}
export function validateBriefingObservation(value, descriptor) {
  const o = obj(clone(value), [
    'version',
    'sessionId',
    'descriptor',
    'phase',
    'createdAt',
    'updatedAt',
    'cursor',
    'events',
    'execution',
    'permission',
    'writeIntent',
    'receipt',
    'completion',
    'error',
  ])
  if (o.version !== 1 || !phases.has(o.phase)) fail('observation-invalid')
  str(o.sessionId)
  o.descriptor = validateBriefingDescriptor(o.descriptor)
  if (
    descriptor &&
    canonicalBriefingJson(o.descriptor) !== canonicalBriefingJson(validateBriefingDescriptor(descriptor))
  )
    fail('observation-binding')
  time(o.createdAt)
  time(o.updatedAt)
  time(o.cursor)
  if (o.updatedAt < o.createdAt || o.cursor > BRIEFING_LIMITS.maxEvents) fail('observation-clock-cursor')
  if (!Array.isArray(o.events) || o.events.length > BRIEFING_LIMITS.maxEvents) fail('events-bound')
  let previous = 0
  for (const e of o.events) {
    obj(e, ['seq', 'type', 'at', 'data'])
    time(e.seq)
    time(e.at)
    str(e.type, 80)
    if (e.seq <= previous || e.seq > o.cursor || !e.data || typeof e.data !== 'object' || Array.isArray(e.data))
      fail('event-invalid')
    previous = e.seq
  }
  if (o.execution !== null) {
    const x = obj(o.execution, ['invocationId', 'pid', 'providerThreadId', 'exit'])
    str(x.invocationId)
    if (x.pid !== null && (!Number.isSafeInteger(x.pid) || x.pid <= 0)) fail('execution-pid')
    if (x.providerThreadId !== null) str(x.providerThreadId)
    if (x.exit !== null) {
      obj(x.exit, ['code', 'signal', 'at'])
      time(x.exit.at)
      if (x.exit.code !== null && (!Number.isSafeInteger(x.exit.code) || x.exit.code < 0 || x.exit.code > 255))
        fail('execution-exit')
      if (x.exit.signal !== null) str(x.exit.signal, 32)
      if (x.exit.code === null && x.exit.signal === null) fail('execution-exit')
      if (x.pid === null) fail('execution-exit-without-pid')
    }
  }
  if (o.permission !== null) {
    const p = obj(o.permission, [
      'requestId',
      'nonce',
      'sessionId',
      'contentHash',
      'byteLength',
      'leaseMs',
      'createdAt',
    ])
    for (const k of ['requestId', 'nonce', 'sessionId']) str(p[k])
    digest(p.contentHash)
    bytes(p.byteLength)
    time(p.createdAt)
    if (p.leaseMs !== 3000 || p.sessionId !== o.sessionId || o.phase !== 'awaiting-write-permission')
      fail('permission-invalid')
  }
  if (o.writeIntent !== null) {
    const w = obj(o.writeIntent, ['contentHash', 'byteLength', 'createdAt', 'state'])
    digest(w.contentHash)
    bytes(w.byteLength)
    time(w.createdAt)
    if (!['reserved', 'consumed', 'verified'].includes(w.state)) fail('write-state')
  }
  if (o.receipt !== null) {
    o.receipt = validateBriefingReceipt(o.receipt, o.descriptor)
    if (
      !o.writeIntent ||
      o.writeIntent.state !== 'verified' ||
      o.writeIntent.contentHash !== o.receipt.contentHash ||
      o.writeIntent.byteLength !== o.receipt.byteLength
    )
      fail('receipt-intent')
  }
  if (o.completion !== null && !['briefing', 'silent'].includes(o.completion)) fail('completion-invalid')
  if (o.error !== null) str(o.error, 200)
  if (o.phase === 'completed') {
    if (
      !o.execution?.exit ||
      o.execution.exit.code !== 0 ||
      o.execution.exit.signal !== null ||
      !o.execution.providerThreadId ||
      o.permission ||
      o.error
    )
      fail('completion-execution')
    if (o.completion === 'briefing' ? !o.receipt : o.completion !== 'silent' || o.receipt || o.writeIntent)
      fail('completion-receipt')
  } else if (o.completion !== null) fail('premature-completion')
  if (
    o.permission &&
    (!o.writeIntent ||
      o.writeIntent.state !== 'reserved' ||
      o.permission.contentHash !== o.writeIntent.contentHash ||
      o.permission.byteLength !== o.writeIntent.byteLength)
  )
    fail('permission-intent')
  return o
}
export function validateBriefingResult(value, descriptor) {
  const r = obj(clone(value), ['version', 'receipt', 'content'])
  if (r.version !== 1 || typeof r.content !== 'string') fail('result-invalid')
  r.receipt = validateBriefingReceipt(r.receipt, descriptor)
  if (Buffer.byteLength(r.content) !== r.receipt.byteLength || hashBriefingText(r.content) !== r.receipt.contentHash)
    fail('result-content')
  return r
}
