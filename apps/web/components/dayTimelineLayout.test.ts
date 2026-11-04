import assert from 'node:assert/strict'
import test from 'node:test'
import type { CalendarBlock } from '@remember/shared'
import { createDayScheduleLayout, createRhythmEntries, formatLocalMinute, parseLocalTime } from './dayTimelineLayout'

function block(startTime: string, endTime: string, title = `${startTime}-${endTime}`): CalendarBlock {
  return { startTime, endTime, title, description: '' }
}

test('uses a stable workday scale and preserves a noon gap', () => {
  const layout = createDayScheduleLayout([block('09:15', '12:00'), block('13:00', '15:30')])
  assert.equal(layout.startMinute, 8 * 60)
  assert.equal(layout.endMinute, 18 * 60)
  assert.deepEqual(
    createRhythmEntries(layout)
      .filter((entry) => entry.type === 'gap')
      .map(({ startMinute, endMinute }) => [startMinute, endMinute]),
    [
      [12 * 60, 13 * 60],
      [15 * 60 + 30, 18 * 60],
    ]
  )
})

test('starts the day at the first visible block instead of calling pre-work time a break', () => {
  const layout = createDayScheduleLayout([block('08:18', '08:33')], {
    startMinute: 0,
    endMinute: 8 * 60 + 33,
  })

  assert.deepEqual(
    createRhythmEntries(layout).map((entry) => entry.type),
    ['block']
  )
})

test('puts overlapping blocks in separate lanes and adjacent blocks in one lane', () => {
  const layout = createDayScheduleLayout([block('09:00', '10:00'), block('09:30', '10:30'), block('10:30', '11:00')])
  assert.deepEqual(
    layout.blocks.map(({ lane, laneCount }) => [lane, laneCount]),
    [
      [0, 2],
      [1, 2],
      [0, 1],
    ]
  )
})

test('uses exact Remember session bounds instead of an 08:00–18:00 frame', () => {
  const layout = createDayScheduleLayout([block('09:47', '10:08')], {
    startMinute: 9 * 60 + 40,
    endMinute: 10 * 60 + 43,
  })

  assert.deepEqual([layout.startMinute, layout.endMinute], [9 * 60 + 40, 10 * 60 + 43])
  assert.deepEqual(
    createRhythmEntries(layout)
      .filter((entry) => entry.type === 'gap')
      .map(({ startMinute, endMinute }) => [startMinute, endMinute]),
    [[10 * 60 + 8, 10 * 60 + 43]]
  )
})

test('keeps short reading and context-switch gaps inside the surrounding flow', () => {
  const layout = createDayScheduleLayout([block('10:24', '10:28'), block('10:37', '10:45'), block('10:55', '11:05')], {
    startMinute: 10 * 60 + 23,
    endMinute: 11 * 60 + 5,
  })

  assert.deepEqual(
    createRhythmEntries(layout)
      .filter((entry) => entry.type === 'gap')
      .map(({ startMinute, endMinute }) => [startMinute, endMinute]),
    [[10 * 60 + 45, 10 * 60 + 55]]
  )
})

test('never draws a break through an overlapping visible summary', () => {
  const layout = createDayScheduleLayout(
    [
      block('12:25', '17:16', 'Broad generated summary'),
      block('12:49', '12:51', 'Last item before break'),
      block('13:46', '13:49', 'First item after break'),
    ],
    { startMinute: 12 * 60 + 25, endMinute: 13 * 60 + 49 }
  )

  assert.deepEqual(
    createRhythmEntries(layout)
      .filter((entry) => entry.type === 'gap')
      .map(({ startMinute, endMinute }) => [startMinute, endMinute]),
    []
  )
})

test('treats clock times as local wall time, including overnight and 24:00', () => {
  assert.equal(parseLocalTime('24:00'), 1440)
  assert.equal(parseLocalTime('24:01'), null)
  const layout = createDayScheduleLayout([block('23:30', '00:30')])
  assert.equal(layout.blocks[0].endMinute - layout.blocks[0].startMinute, 60)
  assert.equal(formatLocalMinute(layout.blocks[0].endMinute), '00:30')
})

test('keeps a zero-length source block from expanding into a 24-hour block', () => {
  const layout = createDayScheduleLayout([block('12:00', '12:00')])
  assert.equal(layout.blocks[0].endMinute - layout.blocks[0].startMinute, 1)
})

test('keeps an empty or sparse day on a readable full-day range', () => {
  const empty = createDayScheduleLayout([])
  assert.deepEqual([empty.startMinute, empty.endMinute], [8 * 60, 18 * 60])
  assert.deepEqual(createRhythmEntries(empty), [])

  const sparse = createDayScheduleLayout([block('14:00', '14:15')])
  assert.deepEqual([sparse.startMinute, sparse.endMinute], [8 * 60, 18 * 60])
})
