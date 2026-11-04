import type { ProactiveSourceKind } from './proactiveStore'

/** Admission of stored evidence; this never starts or changes physical capture. */
export function proactiveSourceAdmission(input: {
  kind: ProactiveSourceKind
  policyAvailable: boolean
  captureSourceAllowed: boolean
}) {
  if (!input.policyAvailable) return false
  return input.kind === 'note' || input.kind === 'context' || input.captureSourceAllowed
}

/** Observation replay is a disposable native-QA mode; normal installations review saved Day state. */
export function proactiveReviewMode(input: { isPackaged: boolean; qaObservation?: boolean; qaDaySync?: boolean }) {
  return !input.isPackaged && input.qaObservation && !input.qaDaySync ? 'observations' : 'day-sync'
}
