import assert from 'node:assert/strict'
import { test } from 'node:test'
import { proactiveReviewMode, proactiveSourceAdmission } from '../proactiveSourceAdmission'

test('a fresh public installation reviews saved Day state independently of private files or QA flags', () => {
  assert.equal(proactiveReviewMode({ isPackaged: true }), 'day-sync')
  assert.equal(proactiveReviewMode({ isPackaged: false }), 'day-sync')
  for (const qaObservation of [true, false])
    for (const qaDaySync of [true, false])
      assert.equal(proactiveReviewMode({ isPackaged: true, qaObservation, qaDaySync }), 'day-sync')
})

test('raw observation replay remains explicit and limited to disposable unpackaged QA', () => {
  assert.equal(proactiveReviewMode({ isPackaged: false, qaObservation: true }), 'observations')
  assert.equal(proactiveReviewMode({ isPackaged: false, qaObservation: true, qaDaySync: true }), 'day-sync')
})

test('stored context and saved Notes keep the same source admission while physical capture is paused', () => {
  const paused = { policyAvailable: true, captureSourceAllowed: false }
  for (const kind of ['note', 'context'] as const) {
    assert.equal(proactiveSourceAdmission({ ...paused, kind }), true)
    assert.equal(proactiveSourceAdmission({ ...paused, kind, policyAvailable: false }), false)
  }
  assert.equal(proactiveSourceAdmission({ ...paused, kind: 'speech' }), false)
})

test('active speech still needs both capture admission and the current privacy/consent policy', () => {
  assert.equal(proactiveSourceAdmission({ kind: 'speech', policyAvailable: true, captureSourceAllowed: true }), true)
  assert.equal(proactiveSourceAdmission({ kind: 'speech', policyAvailable: false, captureSourceAllowed: true }), false)
  assert.equal(proactiveSourceAdmission({ kind: 'speech', policyAvailable: false, captureSourceAllowed: false }), false)
})
