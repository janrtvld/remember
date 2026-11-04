import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatAssistantTimestamp } from './assistantTimestamp'

test('relative dates follow local calendar days, including New Year and daylight saving', () => {
  const now = new Date(2026, 0, 1, 0, 5).getTime()
  assert.equal(formatAssistantTimestamp(now, 'en-US', now), '12:05 AM')
  assert.equal(formatAssistantTimestamp(new Date(2026, 0, 1, 14, 29).getTime(), 'en-US', now), '2:29 PM')
  assert.equal(formatAssistantTimestamp(new Date(2026, 0, 1, 14, 29).getTime(), 'nl-NL', now), '14:29')
  assert.match(formatAssistantTimestamp(new Date(2025, 11, 31, 23, 55).getTime(), 'en-US', now), /^Yesterday, /)
  assert.match(formatAssistantTimestamp(new Date(2025, 11, 30, 12).getTime(), 'en-US', now), /2025/)
  const spring = new Date(2026, 2, 30, 0, 5).getTime()
  assert.match(formatAssistantTimestamp(new Date(2026, 2, 29, 0, 5).getTime(), 'nl-NL', spring), /^Gisteren, /)
  assert.doesNotMatch(formatAssistantTimestamp(new Date(2026, 2, 28, 12).getTime(), 'nl-NL', spring), /2026/)
})
