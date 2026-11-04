import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication } from 'playwright-core'

declare global {
  var qaPrepareDayInputs: (dayId: string) => Promise<{ read: number; admitted: number; sources: number }>
}

export function installDayPreparationQa(desktop: string) {
  appendFileSync(
    join(desktop, 'src/main/index.ts'),
    `
import { getEvidenceStore as qaPreparationStore } from './dailyReview/evidenceRepository'
import { prepareDayAnalysisInputs as qaPrepareInputs } from './dailyReview/dayAnalysisProvenance'
import { getSettingsHealth as qaReadSettingsHealth } from './settings'
Object.assign(globalThis, { qaPrepareDayInputs: async (dayId: string) => {
  const store = qaPreparationStore()
  const day = store.readSessionHeaders().find((candidate) => candidate.id === dayId)
  if (!day) throw new Error('qa-preparation-day-missing')
  const evidence = await store.readAnalysisEvidence(dayId)
  const pending = qaPrepareInputs({ workdayId: dayId, startedAt: day.startedAt, coveredThrough: Date.now(), previousMemory: null, evidence, wikiPages: [], store })
  // A normal capture-state read refreshes the settings object, even when its policy is unchanged.
  qaReadSettingsHealth()
  const prepared = await pending
  return { read: evidence.length, admitted: prepared.evidence.length, sources: prepared.provenance.rawEvidenceIds.length }
} })
`
  )
}

export async function verifyDayPreparationQa(electron: ElectronApplication, dayId: string, checks: string[]) {
  const prepared = await electron.evaluate(async (_electron, id) => globalThis.qaPrepareDayInputs(id), dayId)
  assert(prepared.read > 0)
  assert(prepared.admitted > 0)
  assert.equal(prepared.sources, prepared.admitted)
  checks.push(
    'Async Day input preparation retains permitted sources and tolerates ordinary settings-health rereads without stale authorization'
  )
}
