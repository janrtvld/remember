import assert from 'node:assert/strict'
import { test } from 'node:test'
import { selectAgentEvidence } from '../residentAgentPrivacy'

const settings = {
  excludePasswordManagers: true,
  excludePrivateBrowsing: true,
  appCaptureMode: 'exclude' as const,
  excludedAppBundleIds: ['com.private'],
  includedAppBundleIds: [],
  websiteCaptureMode: 'exclude' as const,
  excludedWebsites: ['private.example'],
  includedWebsites: [],
}

test('current exclusions and authentication metadata remove previously stored content before model selection', () => {
  const result = selectAgentEvidence(
    [
      {
        kind: 'context' as const,
        evidenceId: 'private-app',
        appName: 'Private',
        bundleId: 'com.private',
        text: 'hidden',
      },
      {
        kind: 'context' as const,
        evidenceId: 'private-domain',
        appName: 'Safari',
        text: 'hidden',
        url: 'https://private.example/doc',
      },
      {
        kind: 'context' as const,
        evidenceId: 'login',
        appName: 'Safari',
        text: 'hidden',
        url: 'https://accounts.google.com/',
      },
      {
        kind: 'context' as const,
        evidenceId: 'password',
        appName: 'Safari',
        text: 'hidden',
        windowTitle: 'Wachtwoord invoeren',
      },
      {
        kind: 'context' as const,
        evidenceId: 'private-window',
        appName: 'Safari',
        text: 'hidden',
        windowTitle: 'Privévenster',
      },
      { kind: 'context' as const, evidenceId: 'allowed', appName: 'Notes', text: 'Release by Friday' },
    ],
    settings
  )
  assert.deepEqual(
    result.evidence.map((entry) => entry.evidenceId),
    ['allowed']
  )
  assert.equal(result.omittedCount, 5)
})

test('selected speech/context preserve identity while redacting known tokens and URL queries', () => {
  const result = selectAgentEvidence(
    [
      { kind: 'speech' as const, evidenceId: 'spoken', text: 'Bearer secretABC_123 should not leave', timestamp: 17 },
      {
        kind: 'context' as const,
        evidenceId: 'screen',
        appName: 'Notes',
        text: 'https://example.test/?token=secret-value',
        url: 'https://example.test/doc?query=private#fragment',
        timestamp: 18,
      },
    ],
    settings
  )
  assert.equal(result.evidence[0]?.text, 'Bearer [redacted] should not leave')
  assert.equal(result.evidence[0]?.timestamp, 17)
  assert.equal(result.evidence[1]?.url, 'https://example.test/doc')
  assert.ok(!JSON.stringify(result).includes('secret'))
})

test('macOS login and lock surfaces never enter a model prompt through direct provenance resolution', () => {
  const result = selectAgentEvidence(
    [
      {
        kind: 'context' as const,
        text: 'Sensitive lock screen',
        appName: 'loginwindow',
        bundleId: 'com.apple.loginwindow',
      },
      { kind: 'context' as const, text: 'Sensitive login screen', appName: 'Lock Screen' },
      { kind: 'context' as const, text: 'Work document', appName: 'Notes', bundleId: 'com.apple.Notes' },
    ],
    settings
  )
  assert.deepEqual(
    result.evidence.map((entry) => entry.text),
    ['Work document']
  )
  assert.equal(result.omittedCount, 2)
})
