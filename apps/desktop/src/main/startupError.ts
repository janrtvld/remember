export type StartupErrorReason = 'archive-damaged' | 'data-version-unsupported' | 'startup-failed'

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : ''
}

export function startupErrorReason(error: unknown): StartupErrorReason {
  const message = errorMessage(error)
  if (message === 'evidence-archive-zero-byte') return 'archive-damaged'
  return /^unsupported-evidence-schema:\d+$/.test(message) ? 'data-version-unsupported' : 'startup-failed'
}

export function startupErrorPath(reason: StartupErrorReason) {
  if (reason === 'archive-damaged') return '/startup-error/archive/'
  return reason === 'data-version-unsupported' ? '/startup-error/data-version/' : '/startup-error/'
}
