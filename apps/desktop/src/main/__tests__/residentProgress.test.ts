import assert from 'node:assert/strict'
import test from 'node:test'
import { residentProgressLabel } from '../residentProgress'

test('source progress distinguishes actual read operations without echoing arguments', () => {
  assert.equal(residentProgressLabel('remember_data', 'day_state', true), 'Ik haal je dagoverzicht op.')
  assert.equal(residentProgressLabel('remember_data', 'tasks', false), 'I’m checking the current state of your tasks.')
  assert.equal(residentProgressLabel('remember_data', 'private source text', true), null)
  assert.equal(residentProgressLabel('unknown-private-tool', 'read', true), null)
  assert.equal(
    residentProgressLabel('remember_archive', { secret: 'private' }, true),
    'Ik raadpleeg je opgeslagen gesprekken.'
  )
})
