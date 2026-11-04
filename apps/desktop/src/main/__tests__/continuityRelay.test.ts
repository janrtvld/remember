import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runContinuityRelay } from '../../../scripts/continuityRelay'
import { hashDeliveryPayload, type RelayDeliveryPage } from '../continuityRelayStore'

const script = fileURLToPath(new URL('../../../scripts/continuityRelay.ts', import.meta.url))

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'remember-relay-process-'))
  const data = join(root, 'synthetic-profile')
  const state = join(root, 'consumer')
  const cli = join(root, 'synthetic-remember.mjs')
  mkdirSync(data)
  const source = join(data, 'fixture.json')
  writeFileSync(source, JSON.stringify({ revision: 1, lifecycle: 'open' }))
  writeFileSync(
    cli,
    `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
const data = process.env.REMEMBER_DATA_DIR;
const fixture = JSON.parse(fs.readFileSync(path.join(data, 'fixture.json'), 'utf8'));
const args = process.argv.slice(2);
if(args[0]==='source' && fixture.delayMs) await new Promise(resolve=>setTimeout(resolve,fixture.delayMs));
const isDay=fixture.sourceKind==='day';
const ref = {kind:isDay?'day':'work_item',id:'synthetic-item'};
const item = isDay?{id:ref.id,local_day:'2026-10-16',started_at:1,updated_at:fixture.revision,memory_json:JSON.stringify(fixture.memory??{summary:'Stable day summary'}),sourceRef:ref}:{id:ref.id,title:'Synthetic item only'+(fixture.pages?' page '+fixture.activePage:''),lifecycle:fixture.lifecycle,status:'todo',sourceRef:ref,...(fixture.context?{context:fixture.context}:{})};
const snapshot = {dataDirectory:data,observedAt:Date.now(),inbox:{items:isDay?[]:[item]},capture:{availability:'unknown'},processing:{persisted:{days:[{latestEvidenceAt:100,memoryCoveredThrough:50,...(isDay?{sourceRef:ref}:{})}]}}};
let out;
if(args[0]==='status') out={dataDirectory:data};
else if(args[0]==='now') out=snapshot;
else if(args[0]==='inbox'&&args[1]==='list') out={items:!isDay&&fixture.lifecycle==='open'?[item]:[],count:!isDay&&fixture.lifecycle==='open'?1:0,hasMore:false};
else if(args[0]==='inbox'&&args[1]==='read') out={item,facts:[],observations:[],sources:[]};
else if(args[0]==='source') out={sourceRef:ref,kind:ref.kind,id:ref.id,availability:'available',record:item};
else if(args[0]==='changes') {
 const i=args.indexOf('--since');const before=i<0?null:args[i+1];const cursor='cursor-'+fixture.revision;
 if(fixture.pages) {
  if(before===fixture.failAtCursor) throw new Error('synthetic source temporarily unavailable');
  const index=before===null?0:Number(before.replace('cursor-',''));const next='cursor-'+Math.min(index+1,fixture.pages);
  fs.writeFileSync(path.join(data,'fixture.json'),JSON.stringify({...fixture,activePage:Math.min(index+1,fixture.pages)}));
  out={baseline:before===null,observedAt:Date.now(),nextCursor:next,checkpoint:next,hasMore:index+1<fixture.pages,changes:index<fixture.pages?[{sourceRef:ref,kind:ref.kind,id:ref.id,operation:'updated'}]:[]};
 } else out={baseline:before===null,observedAt:Date.now(),nextCursor:cursor,checkpoint:cursor,hasMore:false,changes:before&&before!==cursor?[{sourceRef:ref,kind:ref.kind,id:ref.id,operation:'updated'}]:[]};
} else throw new Error('unexpected fixture command '+args.join(' '));
process.stdout.write(JSON.stringify(out));
`
  )
  chmodSync(cli, 0o700)
  const base = ['--state-dir', state, '--data-dir', data, '--cli', cli, '--consumer-id', 'synthetic-parent']
  const invoke = (command: string, args: string[] = [], expectSuccess = true) => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', script, command, ...base, ...args], {
      encoding: 'utf8',
      timeout: 15_000,
    })
    assert.equal(result.error, undefined)
    if (expectSuccess) assert.equal(result.status, 0, result.stderr)
    else assert.notEqual(result.status, 0)
    return JSON.parse(expectSuccess ? result.stdout : result.stderr.trim().split('\n').at(-1) || '{}')
  }
  return { root, data, state, source, invoke, base }
}

function pageAckArgs(page: RelayDeliveryPage) {
  return [
    '--ack-batch',
    page.batchId,
    '--ack-hash',
    page.deliveryPayloadHash,
    '--ack-sequence',
    String(page.sequence),
    '--ack-page',
    String(page.pageIndex),
    '--ack-page-hash',
    page.pageHash,
  ]
}

function receiveDelivery(f: ReturnType<typeof fixture>, first: RelayDeliveryPage) {
  const contents: string[] = []
  let page = first
  for (let index = 1; index <= first.pageCount; index += 1) {
    assert.equal(page.kind, 'remember.context.delivery-page')
    assert.equal(page.pageIndex, index)
    assert.ok(Buffer.byteLength(JSON.stringify(page), 'utf8') <= 5500)
    const { pageHash, ...payload } = page
    assert.equal(hashDeliveryPayload(payload), pageHash)
    contents.push(page.content)
    const response = f.invoke('wait', ['--timeout-ms', '0', ...pageAckArgs(page)])
    if (index < first.pageCount) page = response
    else assert.equal(response.kind, 'remember.context.ready-for-final-ack')
  }
  const delivery = JSON.parse(contents.join(''))
  const { payloadHash, ...payload } = delivery
  assert.equal(hashDeliveryPayload(payload), payloadHash)
  assert.equal(payloadHash, first.deliveryPayloadHash)
  return delivery
}

test('exact file transfer has its own receipt and survives restart before a separate final ACK', () => {
  const f = fixture()
  try {
    writeFileSync(
      f.source,
      JSON.stringify({ revision: 1, lifecycle: 'open', context: 'Complete source text. '.repeat(1000) })
    )
    const offered = f.invoke('wait', ['--timeout-ms', '0', '--delivery-format', 'file'])
    assert.equal(offered.kind, 'remember.context.delivery-file')
    assert.equal(offered.recipientHasReceived, false)
    assert.equal(offered.requiresSupportedFileTransfer, true)
    const bytes = readFileSync(offered.filePath)
    assert.equal(bytes.at(-1), 10)
    assert.equal(bytes.length, offered.fileSizeBytes)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), offered.fileSha256)
    const delivery = JSON.parse(bytes.toString('utf8'))
    const { payloadHash, ...payload } = delivery
    assert.equal(hashDeliveryPayload(payload), payloadHash)
    assert.equal(payloadHash, offered.deliveryPayloadHash)
    const finalArgs = ['--ack-batch', offered.batchId, '--ack-hash', payloadHash, '--ack-sequence', '1']
    assert.equal(f.invoke('ack', finalArgs, false).kind, 'remember.context.error')
    const fileArgs = ['--ack-file-sha256', offered.fileSha256, '--ack-file-size', String(bytes.length)]
    assert.equal(
      f.invoke(
        'ack-file',
        [...finalArgs, '--ack-file-sha256', '0'.repeat(64), '--ack-file-size', String(bytes.length)],
        false
      ).kind,
      'remember.context.error'
    )
    assert.equal(
      f.invoke(
        'ack-file',
        [...finalArgs, '--ack-file-sha256', offered.fileSha256, '--ack-file-size', String(bytes.length - 1)],
        false
      ).kind,
      'remember.context.error'
    )
    assert.equal(f.invoke('ack', [...finalArgs, ...fileArgs], false).kind, 'remember.context.error')
    const receipt = f.invoke('ack-file', [...finalArgs, ...fileArgs])
    assert.equal(receipt.kind, 'remember.context.file-acknowledged')
    assert.equal(receipt.duplicate, false)
    assert.equal(receipt.readyForFinalAcknowledgement, true)
    assert.equal(f.invoke('status').appliedSequence, 0)
    const replay = f.invoke('wait', ['--timeout-ms', '0'])
    assert.equal(replay.kind, 'remember.context.ready-for-final-ack')
    assert.equal(replay.receipt, 'file')
    assert.equal(replay.applied, false)
    assert.equal(f.invoke('ack-file', [...finalArgs, ...fileArgs]).duplicate, true)
    assert.equal(f.invoke('ack', finalArgs).appliedSequence, 1)
    assert.equal(f.invoke('status').pendingCount, 0)
    assert.equal(f.invoke('ack-file', [...finalArgs, ...fileArgs]).duplicate, true)
    assert.deepEqual(readFileSync(offered.filePath), bytes, 'exported content stays immutable')
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('bounded backlog drain resumes partial failure and transfers ordered immutable NDJSON lines before ACK', () => {
  const f = fixture()
  try {
    writeFileSync(f.source, JSON.stringify({ revision: 1, lifecycle: 'open', pages: 3, failAtCursor: 'cursor-1' }))
    const partial = f.invoke('drain', ['--timeout-ms', '10000', '--max-pages', '10'])
    assert.equal(partial.kind, 'remember.context.delivery-bundle')
    assert.equal(partial.drain.pagesRead, 1)
    assert.match(partial.drain.sourceError, /synthetic source temporarily unavailable/)
    assert.equal(partial.deliveries.length, 1)
    assert.equal(partial.status.appliedSequence, 0)
    const firstBytes = readFileSync(partial.filePath)
    writeFileSync(f.source, JSON.stringify({ revision: 1, lifecycle: 'open', pages: 3 }))
    const limited = f.invoke('drain', ['--timeout-ms', '10000', '--max-pages', '1'])
    assert.equal(limited.drain.pagesRead, 1)
    assert.equal(limited.drain.hasMore, true)
    assert.equal(limited.drain.caughtUp, false)
    assert.equal(limited.deliveries.length, 2)
    const complete = f.invoke('drain', ['--timeout-ms', '10000', '--max-pages', '10'])
    assert.equal(complete.drain.pagesRead, 2, 'finish checkpoint, then check the newest checkpoint')
    assert.equal(complete.drain.hasMore, false)
    assert.equal(complete.drain.caughtUp, true)
    assert.equal(complete.drain.sourceError, null)
    assert.equal(complete.status.appliedSequence, 0)
    assert.deepEqual(
      complete.deliveries.map((d: { sequence: number }) => d.sequence),
      [1, 2, 3]
    )
    const bytes = readFileSync(complete.filePath)
    assert.equal(bytes.length, complete.fileSizeBytes)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), complete.fileSha256)
    const lines = bytes
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map((line) => Buffer.from(`${line}\n`))
    assert.deepEqual(lines[0], firstBytes, 'already offered delivery bytes remain immutable')
    for (const [index, line] of lines.entries()) {
      const entry = complete.deliveries[index]
      const delivery = JSON.parse(line.toString('utf8'))
      const { payloadHash, ...payload } = delivery
      assert.equal(hashDeliveryPayload(payload), payloadHash)
      assert.equal(payloadHash, entry.deliveryPayloadHash)
      assert.equal(line.length, entry.fileSizeBytes)
      assert.equal(createHash('sha256').update(line).digest('hex'), entry.fileSha256)
      const args = ['--ack-batch', entry.batchId, '--ack-hash', payloadHash, '--ack-sequence', String(entry.sequence)]
      f.invoke('ack-file', [...args, '--ack-file-sha256', entry.fileSha256, '--ack-file-size', String(line.length)])
      assert.equal(f.invoke('ack', args).appliedSequence, entry.sequence)
    }
    assert.equal(f.invoke('status').pendingCount, 0)
    assert.deepEqual(readFileSync(partial.filePath), firstBytes)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('metadata-only day changes advance source provenance without delivery or ACK, while a changed summary delivers', () => {
  const f = fixture()
  try {
    writeFileSync(f.source, JSON.stringify({ revision: 1, sourceKind: 'day' }))
    const baseline = f.invoke('wait', ['--timeout-ms', '0', '--delivery-format', 'file'])
    const args = ['--ack-batch', baseline.batchId, '--ack-hash', baseline.deliveryPayloadHash, '--ack-sequence', '1']
    f.invoke('ack-file', [
      ...args,
      '--ack-file-sha256',
      baseline.fileSha256,
      '--ack-file-size',
      String(baseline.fileSizeBytes),
    ])
    f.invoke('ack', args)
    writeFileSync(f.source, JSON.stringify({ revision: 2, sourceKind: 'day' }))
    const quiet = f.invoke('wait', ['--timeout-ms', '0', '--delivery-format', 'file'])
    assert.equal(quiet.kind, 'remember.context.waiting')
    const state = f.invoke('status')
    assert.equal(state.cursor, 'cursor-2')
    assert.equal(state.sequence, 1)
    assert.equal(state.appliedSequence, 1)
    assert.equal(state.pendingCount, 0)
    writeFileSync(
      f.source,
      JSON.stringify({ revision: 3, sourceKind: 'day', memory: { summary: 'A newly observed outcome' } })
    )
    const changed = f.invoke('wait', ['--timeout-ms', '0', '--delivery-format', 'file'])
    assert.equal(changed.kind, 'remember.context.delivery-file')
    assert.equal(changed.sequence, 2)
    const delivery = JSON.parse(readFileSync(changed.filePath, 'utf8'))
    assert.equal(delivery.content.dayMemory.memory.summary, 'A newly observed outcome')
    assert.equal(f.invoke('status').appliedSequence, 1)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('two process-delivered batches, lost ACK replay, idempotent ACK and corrected completed state', () => {
  const f = fixture()
  try {
    const firstPage = f.invoke('wait', ['--timeout-ms', '0'])
    assert.equal(firstPage.kind, 'remember.context.delivery-page')
    assert.equal(
      f.invoke(
        'ack',
        ['--ack-batch', firstPage.batchId, '--ack-hash', firstPage.deliveryPayloadHash, '--ack-sequence', '1'],
        false
      ).kind,
      'remember.context.error'
    )
    const replay = f.invoke('wait', ['--timeout-ms', '2000', '--poll-ms', '100'])
    assert.deepEqual(replay, firstPage, 'new process reoffers immutable page after unacknowledged delivery')
    const first = receiveDelivery(f, firstPage)
    assert.equal(first.kind, 'remember.context.delivery')
    assert.equal(first.sequence, 1)
    assert.equal(first.content.coverage.capture.availability, 'unknown')
    assert.equal(first.content.scope.acknowledges, 'this-projection-only')
    assert.equal(first.content.scope.rawRecordsFullyReadByRecipient, false)
    assert.equal(first.content.workItems[0].record.lifecycle, 'open')
    const wrongAck = f.invoke(
      'ack',
      ['--ack-batch', first.batchId, '--ack-hash', first.sourcePayloadHash, '--ack-sequence', '1'],
      false
    )
    assert.equal(wrongAck.kind, 'remember.context.error')
    assert.equal(f.invoke('status').appliedSequence, 0)
    const args = ['--ack-batch', first.batchId, '--ack-hash', first.payloadHash, '--ack-sequence', '1']
    assert.equal(f.invoke('ack', args).duplicate, false)
    assert.equal(f.invoke('ack', args).duplicate, true)
    writeFileSync(f.source, JSON.stringify({ revision: 2, lifecycle: 'completed' }))
    const second = receiveDelivery(f, f.invoke('wait', ['--timeout-ms', '0', ...args]))
    assert.equal(second.sequence, 2)
    assert.notEqual(second.batchId, first.batchId)
    assert.equal(
      second.content.workItems.find((c: { sourceRef: { id: string } }) => c.sourceRef.id === 'synthetic-item').record
        .lifecycle,
      'completed'
    )
    assert.equal(
      second.content.workItems.filter((item: { record: { lifecycle: string } }) => item.record.lifecycle === 'open')
        .length,
      0
    )
    const before = f.invoke('status')
    assert.equal(before.cursor, 'cursor-2')
    assert.equal(before.appliedSequence, 1)
    f.invoke('ack', ['--ack-batch', second.batchId, '--ack-hash', second.payloadHash, '--ack-sequence', '2'])
    const after = f.invoke('status')
    assert.equal(after.appliedSequence, 2)
    assert.equal(after.pendingCount, 0)
    assert.equal(after.appliedState.open.length, 0)
    assert.deepEqual(after.appliedDelivery, second, 'stored recipient state is exactly the received projection')
    assert.equal(f.invoke('wait', ['--timeout-ms', '0']).kind, 'remember.context.waiting')
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('source disconnect keeps durable cursor and backlog, then reconnect resumes', () => {
  const f = fixture()
  try {
    const first = receiveDelivery(f, f.invoke('wait', ['--timeout-ms', '0']))
    f.invoke('ack', ['--ack-batch', first.batchId, '--ack-hash', first.payloadHash, '--ack-sequence', '1'])
    const original = readFileSync(f.source, 'utf8')
    rmSync(f.source)
    assert.equal(f.invoke('wait', ['--timeout-ms', '0'], false).kind, 'remember.context.error')
    assert.equal(f.invoke('status').cursor, 'cursor-1')
    writeFileSync(f.source, original)
    assert.equal(f.invoke('wait', ['--timeout-ms', '0']).kind, 'remember.context.waiting')
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('relay refuses state inside the source profile', () => {
  const f = fixture()
  try {
    const result = f.invoke('status', ['--state-dir', join(f.data, 'forbidden')], false)
    assert.match(result.message, /outside the Remember source profile/)
    assert.equal(existsSync(join(f.data, 'forbidden')), false)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('relay refuses a source cache symlink before invoking the CLI or creating its database', () => {
  const f = fixture()
  try {
    mkdirSync(f.state)
    symlinkSync(f.data, join(f.state, 'source-cache'))
    rmSync(f.source)
    const result = f.invoke('wait', ['--timeout-ms', '0'], false)
    assert.match(result.message, /source cache.*not a symlink/)
    assert.equal(existsSync(join(f.state, 'relay.sqlite')), false)
    assert.equal(existsSync(f.source), false)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('a long hydration renews its lease and a whole-operation deadline cancels without cursor advancement', async () => {
  const f = fixture()
  try {
    writeFileSync(f.source, JSON.stringify({ revision: 1, lifecycle: 'open', delayMs: 600 }))
    const batch = await runContinuityRelay(['wait', ...f.base, '--timeout-ms', '0'], {
      leaseTtlMs: 250,
      heartbeatMs: 50,
      sourceTimeoutMs: 3000,
    })
    assert.equal(batch.kind, 'remember.context.delivery-page')
    const first = f.invoke('status')
    assert.equal(first.lease, null)
    assert.equal(first.cursor, 'cursor-1')
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
  const timeout = fixture()
  try {
    writeFileSync(timeout.source, JSON.stringify({ revision: 1, lifecycle: 'open', delayMs: 2000 }))
    await assert.rejects(
      runContinuityRelay(['wait', ...timeout.base, '--timeout-ms', '0'], {
        leaseTtlMs: 250,
        heartbeatMs: 50,
        sourceTimeoutMs: 500,
      }),
      /abort|timeout/i
    )
    const state = timeout.invoke('status')
    assert.equal(state.cursor, null)
    assert.equal(state.pendingCount, 0)
    assert.equal(state.lease, null)
  } finally {
    rmSync(timeout.root, { recursive: true, force: true })
  }
})

test('multipart delivery survives process restarts and keeps application pending until complete receipt', () => {
  const f = fixture()
  try {
    const context = '📎\n"\\'.repeat(900)
    writeFileSync(f.source, JSON.stringify({ revision: 1, lifecycle: 'open', context }))
    const page = f.invoke('wait', ['--timeout-ms', '0'])
    assert.ok(page.pageCount > 1)
    assert.equal(
      f.invoke('ack', [...pageAckArgs(page), '--ack-page-hash', 'wrong'], false).kind,
      'remember.context.error'
    )
    const delivery = receiveDelivery(f, page)
    assert.equal(delivery.content.workItems[0].record.context, context)
    assert.equal(f.invoke('status').appliedSequence, 0)
    assert.equal(f.invoke('ack', pageAckArgs(page)).duplicate, true)
    f.invoke('ack', ['--ack-batch', delivery.batchId, '--ack-hash', delivery.payloadHash, '--ack-sequence', '1'])
    assert.deepEqual(f.invoke('status').appliedDelivery, delivery)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})
