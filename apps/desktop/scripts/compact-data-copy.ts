import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, existsSync, openSync, realpathSync, statfsSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { setImmediate } from 'node:timers/promises'
import { ProactiveDayStorage } from '../src/main/dailyReview/proactiveDayStorage'

const [inputArgument, outputArgument] = process.argv.slice(2)
if (!inputArgument || !outputArgument || process.argv.length !== 4) {
  throw new Error(
    'Usage: node --import tsx scripts/compact-data-copy.ts /path/to/evidence.sqlite /new/path/evidence.sqlite'
  )
}
const input = realpathSync(inputArgument)
const output = resolve(outputArgument)
if (output === input) throw new Error('copy-output-must-differ')
if (existsSync(output)) throw new Error('copy-output-already-exists')
const originalBytes = statSync(input).size
const disk = statfsSync(dirname(output), { bigint: true })
if (disk.bavail * disk.bsize < BigInt(originalBytes) * 3n + 256n * 1024n * 1024n) {
  throw new Error('insufficient-space-for-safe-compaction-copy')
}
closeSync(openSync(output, 'wx', 0o600))
const source = new DatabaseSync(input, { readOnly: true })
try {
  source.exec('BEGIN')
  source.prepare('SELECT count(*) FROM sqlite_master').get()
  await backup(source, output, { rate: 2048 })
  source.exec('COMMIT')
} finally {
  source.close()
}
chmodSync(output, 0o600)
const database = new DatabaseSync(output)
try {
  const version = Number(database.prepare('PRAGMA user_version').get()?.user_version)
  if (version !== 17 && version !== 18) throw new Error(`unsupported-copy-schema:${version}`)
  database.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON;')
  const storage = new ProactiveDayStorage(database)
  const snapshotHashes = () => {
    const hashes = new Map<string, string>()
    for (const row of database.prepare('SELECT id,snapshot_json FROM proactive_day_source').iterate()) {
      hashes.set(
        String(row.id),
        createHash('sha256')
          .update(JSON.stringify(storage.decode(String(row.snapshot_json))))
          .digest('hex')
      )
    }
    return hashes
  }
  const stateHash = () => {
    const digest = createHash('sha256')
    for (const table of [
      'workday',
      'context_evidence',
      'audio_evidence',
      'speech_segment',
      'proactive_event',
      'proactive_considered',
      'proactive_queue',
      'proactive_decision',
      'evidence_privacy',
    ]) {
      digest.update(table)
      for (const row of database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).iterate())
        digest.update(JSON.stringify(row))
    }
    return digest.digest('hex')
  }
  const beforeHashes = snapshotHashes()
  const beforeState = stateHash()
  const beforeSnapshotBytes = Number(
    database.prepare('SELECT sum(length(snapshot_json)) AS n FROM proactive_day_source').get()?.n ?? 0
  )
  let migrated = 0
  let batch = 0
  do {
    batch = storage.compactBatch()
    migrated += batch
    if (migrated > 0 && migrated % 64 === 0) console.log(JSON.stringify({ phase: 'compacting-copy', migrated }))
    await setImmediate()
  } while (batch > 0)
  assert.deepEqual(snapshotHashes(), beforeHashes)
  assert.equal(stateHash(), beforeState)
  database.exec('PRAGMA user_version=18; VACUUM;')
  assert.equal(database.prepare('PRAGMA quick_check').get()?.quick_check, 'ok')
  const afterSnapshotBytes = Number(
    database.prepare('SELECT sum(length(snapshot_json)) AS n FROM proactive_day_source').get()?.n ?? 0
  )
  const sharedPayloadBytes = Number(
    database.prepare('SELECT sum(length(compressed_json)) AS n FROM proactive_day_payload').get()?.n ?? 0
  )
  console.log(
    JSON.stringify(
      {
        output,
        originalBytes,
        compactedBytes: statSync(output).size,
        snapshotCount: beforeHashes.size,
        migrated,
        beforeSnapshotBytes,
        afterSnapshotBytes,
        sharedPayloadBytes,
        exactSnapshotHashesPreserved: true,
        exactSourcesDecisionsQueuesPrivacyPreserved: true,
        quickCheck: 'ok',
      },
      null,
      2
    )
  )
} finally {
  database.close()
}
