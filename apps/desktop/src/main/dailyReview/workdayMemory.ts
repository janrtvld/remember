import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { DayAnalysisProvenance, DayMemory } from '@remember/shared'
import { ProactiveDayStorage } from './proactiveDayStorage'

type StoredMemory = DayMemory & { _analysisProvenanceRef?: string }

export function prepareWorkdayMemory(memory: DayMemory | null) {
  if (!memory) return { json: null, provenance: null }
  const { analysisProvenance, ...summary } = memory
  if (!analysisProvenance) return { json: JSON.stringify(summary), provenance: null }
  const json = JSON.stringify(analysisProvenance)
  const id = createHash('sha256').update(json).digest('hex')
  return {
    json: JSON.stringify({ ...summary, _analysisProvenanceRef: id }),
    provenance: { id, json },
  }
}

export function readWorkdayMemory(database: DatabaseSync, json: string): DayMemory {
  const { _analysisProvenanceRef, ...memory } = JSON.parse(json) as StoredMemory
  // Inline provenance from earlier versions remains authoritative when present.
  if (memory.analysisProvenance || !_analysisProvenanceRef) return memory
  if (typeof _analysisProvenanceRef !== 'string') throw new Error('workday-analysis-provenance-invalid')
  const row = database
    .prepare('SELECT provenance_json FROM workday_analysis_provenance WHERE id = ?')
    .get(_analysisProvenanceRef)
  if (typeof row?.provenance_json !== 'string') throw new Error('workday-analysis-provenance-missing')
  return { ...memory, analysisProvenance: JSON.parse(row.provenance_json) as DayAnalysisProvenance }
}

export function pruneWorkdayProvenance(database: DatabaseSync, reference: unknown) {
  if (typeof reference !== 'string') return
  database
    .prepare(`DELETE FROM workday_analysis_provenance WHERE id = ? AND NOT EXISTS (
      SELECT 1 FROM workday WHERE json_extract(memory_json, '$._analysisProvenanceRef') = ?
    )`)
    .run(reference, reference)
}

/** Run only with Remember closed, before reinstalling a schema-16 build. */
export function restoreInlineWorkdayMemory(database: DatabaseSync) {
  const version = Number(database.prepare('PRAGMA user_version').get()?.user_version)
  if (version === 16) return 0
  if (version !== 17 && version !== 18) throw new Error(`unsupported-workday-memory-rollback:${version}`)
  database.exec('BEGIN IMMEDIATE')
  try {
    if (version === 18) new ProactiveDayStorage(database).restoreInline()
    const rows = database
      .prepare(
        "SELECT id, memory_json FROM workday WHERE json_type(memory_json, '$._analysisProvenanceRef') IS NOT NULL"
      )
      .all()
    const update = database.prepare('UPDATE workday SET memory_json = ? WHERE id = ?')
    for (const row of rows) {
      if (typeof row.memory_json !== 'string' || typeof row.id !== 'string')
        throw new Error('invalid-workday-memory-rollback-row')
      update.run(JSON.stringify(readWorkdayMemory(database, row.memory_json)), row.id)
    }
    database.exec('DROP TABLE workday_analysis_provenance; PRAGMA user_version = 16; COMMIT;')
    return rows.length
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}
