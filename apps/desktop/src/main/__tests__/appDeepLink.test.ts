import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseRememberDeepLink } from '../appDeepLink'

describe('Remember deep links', () => {
  it('can focus the current page without accepting route parameters', () => {
    assert.deepEqual(parseRememberDeepLink('remember://open'), { kind: 'activate' })
    assert.deepEqual(parseRememberDeepLink('remember-development://open'), { kind: 'activate' })
    assert.equal(parseRememberDeepLink('remember://open?next=/wiki'), null)
    assert.equal(parseRememberDeepLink('remember://open/settings'), null)
  })
  it('opens only the Wiki root', () => {
    assert.deepEqual(parseRememberDeepLink('remember://wiki'), { kind: 'renderer', rendererPath: '/wiki/' })
    assert.deepEqual(parseRememberDeepLink('remember://wiki/'), { kind: 'renderer', rendererPath: '/wiki/' })
    assert.deepEqual(parseRememberDeepLink('remember-development://wiki'), {
      kind: 'renderer',
      rendererPath: '/wiki/',
    })
  })

  it('rejects removed collaboration routes', () => {
    const token = 'a'.repeat(43)
    assert.equal(parseRememberDeepLink(`remember://wiki/join?invite=${token}`), null)
    assert.equal(parseRememberDeepLink(`remember://request?token=${token}`), null)
  })

  it('accepts only a state-bound Revinote OAuth callback', () => {
    assert.deepEqual(
      parseRememberDeepLink(
        'remember://revinote/callback?code=code_1&state=state_1&iss=https%3A%2F%2Fwww.revinote.com%2Fapi%2Fauth'
      ),
      {
        kind: 'revinote-oauth',
        code: 'code_1',
        state: 'state_1',
        issuer: 'https://www.revinote.com/api/auth',
        error: null,
      }
    )
    assert.equal(parseRememberDeepLink('remember://revinote/callback?code=code_1'), null)
    assert.equal(parseRememberDeepLink('remember://revinote/callback?code=code_1&state=state_1&next=/settings'), null)
  })

  it('rejects arbitrary routes and decorated URLs', () => {
    assert.equal(parseRememberDeepLink('remember://settings'), null)
    assert.equal(parseRememberDeepLink('remember://wiki/page'), null)
    assert.equal(parseRememberDeepLink('remember://wiki?next=/settings'), null)
    assert.equal(parseRememberDeepLink('remember-development://settings'), null)
    assert.equal(parseRememberDeepLink('https://remember.computer/wiki'), null)
    assert.equal(parseRememberDeepLink('not a url'), null)
  })
})
