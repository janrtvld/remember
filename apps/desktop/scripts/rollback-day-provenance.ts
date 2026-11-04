import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { restoreInlineWorkdayMemory } from '../src/main/dailyReview/workdayMemory'

const path = process.argv[2]
if (!path)
  throw new Error('Usage: rollback-day-provenance.ts /absolute/path/to/evidence.sqlite (Remember must be closed)')
const database = new DatabaseSync(resolve(path), { open: true })
try {
  console.log(JSON.stringify({ restoredDays: restoreInlineWorkdayMemory(database), schemaVersion: 16 }))
} finally {
  database.close()
}
