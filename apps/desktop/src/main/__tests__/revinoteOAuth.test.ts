import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { requestedRevinoteOAuthScopes } from '../revinoteOAuth'

describe('Revinote OAuth scopes', () => {
  it('keeps the existing connection compatible with a read-only server', () => {
    assert.deepEqual(requestedRevinoteOAuthScopes(['meetings:read']), ['meetings:read', 'offline_access'])
  })

  it('requests post-processing permission only when the server advertises it', () => {
    assert.deepEqual(requestedRevinoteOAuthScopes(['meetings:read', 'meetings:write']), [
      'meetings:read',
      'meetings:write',
      'offline_access',
    ])
  })
})
