import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { contextListSelection, selectListRange, toggleAllListSelection } from './listSelection'

describe('list selection', () => {
  const ids = ['first', 'second', 'third', 'last']

  it('selects all visible rows and clears them on the next select-all', () => {
    const selected = toggleAllListSelection(ids, [])
    assert.deepEqual(selected, ids)
    assert.deepEqual(toggleAllListSelection(ids, selected), [])
  })

  it('expands a partial selection and ignores filtered-out rows when toggling off', () => {
    assert.deepEqual(toggleAllListSelection(ids, ['second']), ids)
    assert.deepEqual(toggleAllListSelection(ids, [...ids, 'hidden']), [])
    assert.deepEqual(toggleAllListSelection([], ['hidden']), [])
  })

  it('selects the whole visible range in either direction', () => {
    assert.deepEqual(selectListRange(ids, 'second', 'last'), ['second', 'third', 'last'])
    assert.deepEqual(selectListRange(ids, 'last', 'second'), ['second', 'third', 'last'])
  })

  it('does not include stale or filtered-out items in a range', () => {
    assert.deepEqual(selectListRange(ids, 'removed', 'second'), ['second'])
    assert.deepEqual(selectListRange(ids, 'second', 'removed'), [])
  })

  it('keeps a bulk selection when its row is right-clicked', () => {
    assert.deepEqual(contextListSelection(['first', 'third'], 'third'), ['first', 'third'])
  })

  it('limits context actions to an unselected row when it is right-clicked', () => {
    assert.deepEqual(contextListSelection(['first', 'third'], 'second'), ['second'])
  })
})
