import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isRemoteNetworkRequest } from '../offlineNetworkPolicy'

describe('offline network policy', () => {
  it('blocks remote network schemes while keeping local app traffic available', () => {
    for (const url of [
      'https://api.openai.com/v1/responses',
      'wss://api.anthropic.com/events',
      'https://www.googleapis.com/drive/v3/files',
      'ftp://example.com/file',
      'https://127.evil.com/looks-local',
    ]) {
      assert.equal(isRemoteNetworkRequest(url), true, url)
    }

    for (const url of [
      'http://localhost:3000/',
      'http://127.0.0.1:3210/',
      'http://127.42.0.8/',
      'http://[::1]:3000/',
      'remember-audio://conversation?id=local',
      'file:///Applications/Remember.app/index.html',
    ]) {
      assert.equal(isRemoteNetworkRequest(url), false, url)
    }
  })
})
