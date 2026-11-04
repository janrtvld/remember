import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as native from '../briefingNativeCore'
import type { ProactiveSourceRef } from '../dailyReview/proactiveStore'
import { initiativeSourcesWithinScope, validateStandingGrantScope } from '../hostInitiativeProtocol'

const selection = (isPackaged: boolean, qaEnabled = false, qaManifestPath?: string) =>
  native.selectBriefingNativeResources({ isPackaged, qaEnabled, qaManifestPath })

test('packaged installations cannot activate remote briefing through QA flags or a manifest', () => {
  assert.throws(() => selection(true), /disabled/)
  assert.throws(() => selection(true, true, '/private/tmp/qa.json'), /disabled/)
})

test('unpackaged native QA requires explicit enablement and a canonical manifest path', () => {
  const qa = selection(false, true, '/private/tmp/qa.json')
  assert.equal(qa.version, 1)
  assert.equal(qa.promptBasename, 'prompt.v1.txt')
  assert.equal(qa.manifestPath, '/private/tmp/qa.json')
  assert.throws(() => selection(false), /disabled/)
  assert.throws(() => selection(false, true), /required/)
  assert.throws(() => selection(false, true, 'relative'), /invalid/)
})

const grant = {
  version: 2,
  installationId: 'own-installation',
  contextFingerprint: 'current',
  target: { targetId: 'mini', targetEpoch: 'one', root: '/private/tmp/own-mini' },
  capability: 'private-briefing-v1',
  screenApp: { bundleId: 'com.test.editor', label: 'Editor' },
  afterSequence: 1,
  personalSources: [{ spaceId: 'personal', slug: 'atlas', revision: 'r1' }],
  model: 'fake',
  effort: 'low',
  maxInputBytes: 48000,
  maxOutputBytes: 16384,
  maxDurationMs: 120000,
  outputBasename: 'briefing.md',
  expiresAt: 2000000,
  maxJobs: 2,
}

test('RPA7 scope rejects empty or hybrid grants, excess jobs and more than one Personal source', () => {
  assert.deepEqual(validateStandingGrantScope(grant), grant)
  for (const change of [
    { screenApp: { bundleId: '', label: 'Editor' } },
    { screenApp: { bundleId: '*', label: 'Editor' } },
    { evidenceSourceIds: [] },
    { maxJobs: 3 },
    { maxDurationMs: 120001 },
    { personalSources: [] },
    { personalSources: [...grant.personalSources, { spaceId: 'personal', slug: 'other', revision: 'r1' }] },
  ])
    assert.throws(() => validateStandingGrantScope({ ...grant, ...change }), /invalid/)
})

test('RPA7 private scope counts at most 11 exact screen refs plus its Personal page', () => {
  const scope = validateStandingGrantScope(grant)
  const reference = { kind: 'context', bundleId: 'com.test.editor', appName: 'arbitrary-label' } as ProactiveSourceRef
  assert.equal(initiativeSourcesWithinScope(scope, Array(11).fill(reference)), true)
  assert.equal(initiativeSourcesWithinScope(scope, Array(12).fill(reference)), false)
  for (const entry of [
    { ...reference, bundleId: undefined },
    { ...reference, bundleId: 'com.other' },
    { ...reference, kind: 'speech' },
    { ...reference, kind: 'note' },
  ])
    assert.equal(initiativeSourcesWithinScope(scope, [entry as ProactiveSourceRef]), false)
  assert.equal(initiativeSourcesWithinScope(scope, []), false)
})
