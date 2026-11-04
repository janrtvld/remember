import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  isWikiSpaceColor,
  isWikiSpaceIcon,
  isWikiSpaceId,
  normalizeWikiSpaceDescription,
  normalizeWikiSpaceName,
} from '../wikiSpaceValidation'

describe('Wiki space validation', () => {
  it('accepts generated UUIDs and rejects cache-path input', () => {
    assert.equal(isWikiSpaceId('534c8242-179c-4e09-b379-e765f7edd076'), true)
    assert.equal(isWikiSpaceId('../../daily-review'), false)
    assert.equal(isWikiSpaceId('finance'), false)
  })

  it('normalizes safe display names and rejects empty or oversized names', () => {
    assert.equal(normalizeWikiSpaceName('  Finance\n Wiki  '), 'Finance Wiki')
    assert.equal(normalizeWikiSpaceName('   '), null)
    assert.equal(normalizeWikiSpaceName('x'.repeat(81)), null)
  })

  it('normalizes optional descriptions and rejects oversized values', () => {
    assert.equal(normalizeWikiSpaceDescription('  Shared\nproject context  '), 'Shared project context')
    assert.equal(normalizeWikiSpaceDescription('   '), '')
    assert.equal(normalizeWikiSpaceDescription('x'.repeat(281)), null)
  })

  it('accepts only supported space icons and colors', () => {
    assert.equal(isWikiSpaceIcon('lock'), true)
    assert.equal(isWikiSpaceIcon('calendar'), false)
    assert.equal(isWikiSpaceColor('purple'), true)
    assert.equal(isWikiSpaceColor('teal'), true)
    assert.equal(isWikiSpaceColor('orange'), true)
    assert.equal(isWikiSpaceColor('pink'), true)
    assert.equal(isWikiSpaceColor('slate'), true)
    assert.equal(isWikiSpaceColor('sky'), true)
    assert.equal(isWikiSpaceColor('blue'), false)
    assert.equal(isWikiSpaceColor('#0066ff'), false)
  })
})
