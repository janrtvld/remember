import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readPcmWavInfo } from '../../src/main/dailyReview/pcmWav'

export function inspectEvidence(profile: string) {
  const root = join(profile, 'daily-review')
  const databasePath = join(root, 'evidence.sqlite')
  if (!existsSync(databasePath)) throw new Error(`Missing evidence database: ${databasePath}`)
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    database.exec('PRAGMA busy_timeout = 5000')
    const counts = Object.fromEntries(
      ['workday', 'context_evidence', 'audio_evidence', 'conversation_episode', 'manual_meeting'].map((table) => [
        table,
        database.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count,
      ])
    )
    const audio = database
      .prepare(`SELECT id, workday_id, source, started_at, duration_ms, average_level, status, capture_outcome,
      capture_epoch_id, capture_sequence, captured_sample_count FROM audio_evidence ORDER BY started_at`)
      .all()
    const wavs: { path: string; bytes: number; sha256: string; durationMs: number }[] = []
    function visit(directory: string) {
      if (!existsSync(directory)) return
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) visit(path)
        else if (entry.isFile() && entry.name.endsWith('.wav')) {
          const data = readFileSync(path)
          const info = readPcmWavInfo(path)
          wavs.push({
            path: relative(root, path),
            bytes: data.length,
            sha256: createHash('sha256').update(data).digest('hex'),
            durationMs: (info.sampleCount / info.sampleRate) * 1_000,
          })
        }
      }
    }
    visit(join(root, 'conversation-audio'))
    return {
      integrity: database.prepare('PRAGMA quick_check').all(),
      foreignKeyViolations: database.prepare('PRAGMA foreign_key_check').all(),
      counts,
      audio,
      wavs,
      meetings: database
        .prepare('SELECT id, title, notes, status, episode_id, started_at, ended_at FROM manual_meeting')
        .all(),
    }
  } finally {
    database.close()
  }
}
