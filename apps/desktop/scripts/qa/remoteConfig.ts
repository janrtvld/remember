import assert from 'node:assert/strict'

export function qaSshTarget() {
  const target = process.env.REMEMBER_QA_SSH_TARGET
  assert(
    target && /^[A-Za-z0-9_][A-Za-z0-9_-]*@[A-Za-z0-9][A-Za-z0-9.-]*$/.test(target),
    'Set REMEMBER_QA_SSH_TARGET to the dedicated QA user@hostname before running a live remote scenario'
  )
  return target
}

export function qaRemoteWorkspace() {
  const workspace = process.env.REMEMBER_QA_REMOTE_WORKSPACE
  assert(
    typeof workspace === 'string' && workspace.startsWith('/') && workspace !== '/' && !/[\r\n\0]/.test(workspace),
    'Set REMEMBER_QA_REMOTE_WORKSPACE to an absolute dedicated QA workspace path on the remote computer'
  )
  return workspace
}
