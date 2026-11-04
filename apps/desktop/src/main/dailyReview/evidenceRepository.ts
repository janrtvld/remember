import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { app } from 'electron'
import { EvidenceStore } from './evidenceStore'

export function dailyReviewDirectory() {
  return join(app.getPath('userData'), 'daily-review')
}

let evidenceStore: EvidenceStore | null = null

export function getEvidenceStore() {
  evidenceStore ??= new EvidenceStore(join(dailyReviewDirectory(), 'evidence.sqlite'))
  return evidenceStore
}

export function closeEvidenceStore() {
  evidenceStore?.close()
  evidenceStore = null
}

export function temporaryCaptureDirectory(sessionId: string, source: 'audio' | 'context') {
  const directory = join(dailyReviewDirectory(), 'temporary-capture', sessionId, source)
  mkdirSync(directory, { recursive: true })
  return directory
}

export function removeTemporaryCaptureFile(file: string) {
  const root = resolve(join(dailyReviewDirectory(), 'temporary-capture'))
  const target = resolve(file)
  if (target !== root && !target.startsWith(`${root}${sep}`)) return
  rmSync(target, { force: true })
}

export function clearTemporaryCapture() {
  const directory = join(dailyReviewDirectory(), 'temporary-capture')
  if (existsSync(directory)) rmSync(directory, { recursive: true, force: true })
}
