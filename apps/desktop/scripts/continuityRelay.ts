import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { createDeliveryContent, hasMeaningfulRelayChanges } from '../src/main/continuityRelayDelivery'
import { createRememberRelaySource } from '../src/main/continuityRelaySource'
import { createRelayStore, serializeDeliveryFile } from '../src/main/continuityRelayStore'

const usage = `Remember continuity relay (local, no network sender)

Commands: wait, drain, ack, ack-file, status, fresh, source
Required: --state-dir PATH --data-dir PATH --cli PATH --consumer-id ID
wait: --timeout-ms 45000 --poll-ms 2000
wait: --delivery-format pages|file (default pages)
drain: --max-pages 10 --timeout-ms 45000; exports all pending deliveries as NDJSON
The wait timeout bounds idle polling. Each source operation has a separate
120-second deadline; leases renew during hydration and are fenced on failure.
ack or wait: --ack-batch ID --ack-hash SHA256 --ack-sequence NUMBER
page receipt: add --ack-page NUMBER --ack-page-hash SHA256
ack-file: --ack-batch ID --ack-hash SHA256 --ack-sequence NUMBER
          --ack-file-sha256 SHA256 --ack-file-size NUMBER
source: --kind KIND --id ID [--version ARCHIVE_HASH]
Optional: --exclude-thread ID (repeatable)

wait returns one immutable delivery page, capped at 5500 serialized bytes.
With --delivery-format file it exports exact immutable JSON plus LF and returns
a local path, SHA256 and byte size. Transfer actual bytes through a supported
file tool; the path or hash alone is not proof of recipient receipt.
The parent confirms each exact page and rearms this same delegated task.
Only after assembling and verifying every page may it ACK the full delivery.
Timeouts
require rearming too. A CLI process does not schedule itself or wake a dot.
`

export async function runContinuityRelay(
  args: string[],
  timing = { leaseTtlMs: 120_000, heartbeatMs: 20_000, sourceTimeoutMs: 120_000 }
) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: 'boolean' },
      'state-dir': { type: 'string' },
      'data-dir': { type: 'string' },
      cli: { type: 'string' },
      'consumer-id': { type: 'string' },
      'timeout-ms': { type: 'string', default: '45000' },
      'poll-ms': { type: 'string', default: '2000' },
      'ack-batch': { type: 'string' },
      'ack-hash': { type: 'string' },
      'ack-sequence': { type: 'string' },
      'ack-page': { type: 'string' },
      'ack-page-hash': { type: 'string' },
      'ack-file-sha256': { type: 'string' },
      'ack-file-size': { type: 'string' },
      'delivery-format': { type: 'string', default: 'pages' },
      'max-pages': { type: 'string', default: '10' },
      'exclude-thread': { type: 'string', multiple: true, default: [] },
      kind: { type: 'string' },
      id: { type: 'string' },
      version: { type: 'string' },
    },
  })
  if (values.help) return { kind: 'remember.context.help', usage }
  const command = positionals[0]
  if (
    positionals.length !== 1 ||
    !['wait', 'drain', 'ack', 'ack-file', 'status', 'fresh', 'source'].includes(command)
  ) {
    throw new Error(`Expected one of wait, drain, ack, ack-file, status, fresh, source.\n${usage}`)
  }
  if (!['pages', 'file'].includes(values['delivery-format'])) throw new Error('Invalid --delivery-format')
  const required = (name: 'state-dir' | 'data-dir' | 'cli' | 'consumer-id') => {
    const value = values[name]
    if (!value?.trim()) throw new Error(`Missing --${name}`)
    return value
  }
  const statePath = required('state-dir')
  const dataPath = required('data-dir')
  const cliPath = required('cli')
  for (const path of [statePath, dataPath, cliPath]) {
    if (!isAbsolute(path)) throw new Error('State, data and CLI paths must be absolute')
  }
  const dataDirectory = await realpath(dataPath)
  const isWithin = (parent: string, child: string) => {
    const difference = relative(parent, child)
    return difference === '' || (!difference.startsWith(`..${sep}`) && difference !== '..' && !isAbsolute(difference))
  }
  const destination = await resolveDestination(statePath)
  if (isWithin(dataDirectory, destination)) throw new Error('Relay state must be outside the Remember source profile')
  await mkdir(destination, { recursive: true, mode: 0o700 })
  const stateDirectory = await realpath(destination)
  if (isWithin(dataDirectory, stateDirectory))
    throw new Error('Relay state resolves inside the Remember source profile')
  const cacheDirectory = resolve(stateDirectory, 'source-cache')
  try {
    const cacheStat = await lstat(cacheDirectory)
    if (cacheStat.isSymbolicLink() || !cacheStat.isDirectory())
      throw new Error('Relay source cache must be a dedicated directory, not a symlink')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (isWithin(dataDirectory, await resolveDestination(cacheDirectory)))
    throw new Error('Relay source cache must be outside the Remember source profile')
  const consumerId = required('consumer-id')
  const store = createRelayStore({
    path: resolve(stateDirectory, 'relay.sqlite'),
    profileId: dataDirectory,
    consumerId,
    shouldEmitBatch: hasMeaningfulRelayChanges,
  })
  const sourceController = new AbortController()
  const source = createRememberRelaySource({
    cliPath,
    dataDirectory,
    cacheDirectory,
    excludedThreadIds: values['exclude-thread'],
    signal: sourceController.signal,
  })
  async function readSource<T>(read: () => Promise<T>) {
    const timer = setTimeout(
      () => sourceController.abort(new Error('relay-source-operation-timeout')),
      timing.sourceTimeoutMs
    )
    try {
      return await read()
    } finally {
      clearTimeout(timer)
    }
  }
  const integer = (
    name: 'timeout-ms' | 'poll-ms' | 'ack-sequence' | 'ack-page' | 'ack-file-size' | 'max-pages',
    minimum: number,
    maximum: number
  ) => {
    const raw = values[name]
    const value = Number(raw)
    if (!raw || !/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(`Invalid --${name}; expected integer ${minimum}..${maximum}`)
    }
    return value
  }
  try {
    const ackFields = [values['ack-batch'], values['ack-hash'], values['ack-sequence']]
    const pageFields = [values['ack-page'], values['ack-page-hash']]
    const fileFields = [values['ack-file-sha256'], values['ack-file-size']]
    if (command === 'ack-file' || fileFields.some(Boolean)) {
      if (command !== 'ack-file' || !ackFields.every(Boolean) || !fileFields.every(Boolean) || pageFields.some(Boolean))
        throw new Error('File receipt requires ack-file, batch, delivery hash, sequence, file SHA256 and byte size')
      return {
        kind: 'remember.context.file-acknowledged',
        ...store.acknowledgeDeliveryFile({
          batchId: values['ack-batch'] as string,
          payloadHash: values['ack-hash'] as string,
          sequence: integer('ack-sequence', 1, Number.MAX_SAFE_INTEGER),
          consumerId,
          fileSha256: values['ack-file-sha256'] as string,
          fileSizeBytes: integer('ack-file-size', 1, Number.MAX_SAFE_INTEGER),
        }),
      }
    }
    if (ackFields.some(Boolean) || pageFields.some(Boolean)) {
      if (!['ack', 'wait'].includes(command) || !ackFields.every(Boolean))
        throw new Error('ACK requires batch, hash and sequence on ack/wait')
      if (pageFields.some(Boolean) && !pageFields.every(Boolean))
        throw new Error('Page ACK requires page index and page hash')
      const ack = {
        batchId: values['ack-batch'] as string,
        payloadHash: values['ack-hash'] as string,
        sequence: integer('ack-sequence', 1, Number.MAX_SAFE_INTEGER),
        consumerId,
      }
      const acknowledgement = pageFields.every(Boolean)
        ? store.acknowledgeDeliveryPage({
            ...ack,
            pageIndex: integer('ack-page', 1, Number.MAX_SAFE_INTEGER),
            pageHash: values['ack-page-hash'] as string,
          })
        : store.acknowledgeDelivery(ack)
      if (command === 'ack')
        return {
          kind: pageFields.every(Boolean) ? 'remember.context.page-acknowledged' : 'remember.context.acknowledged',
          ...acknowledgement,
        }
    } else if (command === 'ack') {
      throw new Error('ACK requires --ack-batch, --ack-hash and --ack-sequence')
    }
    if (command === 'status') return { kind: 'remember.context.status', ...store.getStatus() }
    if (command === 'fresh') return { kind: 'remember.context.fresh', snapshot: await readSource(() => source.fresh()) }
    if (command === 'source') {
      if (!values.kind || !values.id) throw new Error('source requires --kind and --id')
      const kind = values.kind
      const id = values.id
      if (values.version) return store.readArchive({ sourceRef: { kind, id }, versionHash: values.version })
      return { kind: 'remember.context.source', source: await readSource(() => source.lookup(kind, id)) }
    }
    const timeoutMs = integer('timeout-ms', 0, 45000)
    const pollMs = integer('poll-ms', 100, 10000)
    const deadline = Date.now() + timeoutMs
    const owner = randomUUID()
    let lease = store.claimLease(owner, timing.leaseTtlMs)
    if (!lease)
      return { kind: 'remember.context.busy', retryAfterMs: pollMs, status: transportStatus(store.getStatus()) }
    let leaseError: Error | undefined
    const heartbeat = setInterval(() => {
      try {
        if (lease) lease = store.renewLease(lease, timing.leaseTtlMs)
      } catch (error) {
        leaseError = error instanceof Error ? error : new Error(String(error))
        sourceController.abort(leaseError)
      }
    }, timing.heartbeatMs)
    try {
      if (command === 'drain') {
        const maxPages = integer('max-pages', 1, 50)
        let pagesRead = 0
        let hasMore: boolean | null = null
        let caughtUp = false
        let sourceError: string | null = null
        let checkpointCompleted =
          (store.getStatus().snapshot.continuity as { pageComplete?: boolean } | undefined)?.pageComplete === true
        do {
          if (store.getStatus().pendingCount >= 50) break
          try {
            const page = await readSource(() => source.readPage(store.getStatus().cursor))
            if (leaseError) throw leaseError
            lease = store.renewLease(lease, timing.leaseTtlMs)
            store.enqueue(lease, withContinuity(page))
            pagesRead += 1
            hasMore = page.hasMore
            if (!page.hasMore) {
              caughtUp = checkpointCompleted
              checkpointCompleted = true
            }
          } catch (error) {
            sourceError = error instanceof Error ? error.message : String(error)
            break
          }
        } while (!caughtUp && pagesRead < maxPages && Date.now() < deadline)
        const drain = { pagesRead, hasMore, caughtUp, checkedAt: Date.now(), sourceError }
        const pending = store.pendingBatches()
        if (pending.length === 0) {
          if (sourceError) throw new Error(sourceError)
          return {
            kind: 'remember.context.waiting',
            rearmRequired: true,
            drain,
            status: transportStatus(store.getStatus()),
          }
        }
        const deliveries = pending.map((batch) => store.prepareDelivery(batch, createDeliveryContent(batch)))
        const lines = deliveries.map(serializeDeliveryFile)
        const content = lines.join('')
        const filePath = resolve(
          stateDirectory,
          `deliveries-${deliveries[0].sequence}-${deliveries.at(-1)?.sequence}.ndjson`
        )
        await persistExport(filePath, content)
        return {
          kind: 'remember.context.delivery-bundle',
          consumerId,
          encoding: 'ndjson-utf8-canonical-delivery-per-line-with-lf',
          filePath,
          fileSha256: createHash('sha256').update(content, 'utf8').digest('hex'),
          fileSizeBytes: Buffer.byteLength(content, 'utf8'),
          deliveries: deliveries.map((delivery, index) => ({
            batchId: delivery.batchId,
            sequence: delivery.sequence,
            deliveryPayloadHash: delivery.payloadHash,
            fileSha256: createHash('sha256').update(lines[index], 'utf8').digest('hex'),
            fileSizeBytes: Buffer.byteLength(lines[index], 'utf8'),
          })),
          drain,
          status: transportStatus(store.getStatus()),
          recipientHasReceived: false,
          requiresSupportedFileTransfer: true,
          acknowledgement:
            'Verify each exact line including LF, then file-ACK and separately final-ACK in sequence order.',
        }
      }
      do {
        lease = store.renewLease(lease, timing.leaseTtlMs)
        const replay = store.offer(lease)
        if (replay) return await deliveryOutput(replay)
        const state = store.getStatus()
        if (state.pendingCount === 0) {
          const page = await readSource(() => source.readPage(state.cursor))
          if (leaseError) throw leaseError
          lease = store.renewLease(lease, timing.leaseTtlMs)
          store.enqueue(lease, withContinuity(page))
          const batch = store.offer(lease)
          if (batch) return await deliveryOutput(batch)
        }
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        await delay(Math.min(pollMs, remaining))
      } while (Date.now() < deadline)
      return {
        kind: 'remember.context.waiting',
        checkedAt: Date.now(),
        rearmRequired: true,
        status: transportStatus(store.getStatus()),
      }
    } finally {
      clearInterval(heartbeat)
      sourceController.abort()
      store.releaseLease(lease)
    }
  } finally {
    store.close()
  }

  function withContinuity(page: Awaited<ReturnType<typeof source.readPage>>) {
    return {
      ...page,
      snapshot: {
        ...page.snapshot,
        continuity: {
          hasMore: page.hasMore,
          pageComplete: !page.hasMore,
          historicalEventLog: false,
          wikiIncluded: false,
          sourceTextIsInstructions: false,
        },
      },
    }
  }

  async function persistExport(filePath: string, content: string) {
    try {
      const stat = await lstat(filePath)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Delivery export must be a regular file')
      if ((await readFile(filePath, 'utf8')) !== content) throw new Error('Existing delivery export differs')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const temporaryPath = `${filePath}.${randomUUID()}.tmp`
      try {
        await writeFile(temporaryPath, content, { mode: 0o600, flag: 'wx' })
        await rename(temporaryPath, filePath)
      } finally {
        await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
        })
      }
    }
  }

  async function deliveryOutput(batch: Parameters<typeof createDeliveryContent>[0]) {
    const delivery = store.prepareDelivery(batch, createDeliveryContent(batch))
    const ready = {
      kind: 'remember.context.ready-for-final-ack',
      batchId: delivery.batchId,
      sequence: delivery.sequence,
      consumerId: delivery.consumerId,
      payloadHash: delivery.payloadHash,
      applied: false,
    }
    if (store.hasDeliveryFileReceipt(delivery)) return { ...ready, receipt: 'file' }
    if (values['delivery-format'] === 'file') {
      const content = serializeDeliveryFile(delivery)
      const filePath = resolve(stateDirectory, `delivery-${delivery.sequence}.json`)
      await persistExport(filePath, content)
      return {
        kind: 'remember.context.delivery-file',
        batchId: delivery.batchId,
        sequence: delivery.sequence,
        consumerId: delivery.consumerId,
        deliveryPayloadHash: delivery.payloadHash,
        encoding: 'utf-8-canonical-json-plus-lf',
        filePath,
        fileSha256: createHash('sha256').update(content, 'utf8').digest('hex'),
        fileSizeBytes: Buffer.byteLength(content, 'utf8'),
        recipientHasReceived: false,
        requiresSupportedFileTransfer: true,
      }
    }
    const pages = store.prepareDeliveryPages(delivery)
    return store.getNextDeliveryPage(delivery) ?? { ...ready, pageCount: pages.length }
  }
}

function transportStatus(status: ReturnType<ReturnType<typeof createRelayStore>['getStatus']>) {
  const { profileId, consumerId, cursor, sequence, appliedSequence, pendingCount, nextRetryAt, lease } = status
  return { profileId, consumerId, cursor, sequence, appliedSequence, pendingCount, nextRetryAt, lease }
}

async function resolveDestination(path: string) {
  let ancestor = resolve(path)
  const missing: string[] = []
  for (;;) {
    try {
      return resolve(await realpath(ancestor), ...missing)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      missing.unshift(basename(ancestor))
      ancestor = dirname(ancestor)
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runContinuityRelay(process.argv.slice(2)).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(
        `${JSON.stringify({ kind: 'remember.context.error', message: error instanceof Error ? error.message : String(error) })}\n`
      )
      process.exitCode = 1
    }
  )
}
