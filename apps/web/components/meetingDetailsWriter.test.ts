import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MeetingDetailsWriter } from './meetingDetailsWriter'

test('flush saves only the newest draft in a typing burst', async () => {
  const writes: string[] = []
  const writer = new MeetingDetailsWriter(
    async ({ notes }) => {
      writes.push(notes)
    },
    () => {}
  )
  writer.update('Title', 'a')
  writer.update('Title', 'ab')
  writer.update('Title', 'abc')
  assert.deepEqual(writes, [])
  await writer.flush()
  assert.deepEqual(writes, ['abc'])
})

test('a slow write cannot overwrite a newer draft and flush waits for both', async () => {
  const writes: string[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const writer = new MeetingDetailsWriter(
    async ({ notes }) => {
      writes.push(notes)
      if (notes === 'first') await gate
    },
    () => {}
  )
  writer.update('Title', 'first')
  const first = writer.flush()
  writer.update('Title', 'intermediate')
  writer.update('Title', 'last')
  const final = writer.flush()
  assert.deepEqual(writes, ['first'])
  release()
  await Promise.all([first, final])
  assert.deepEqual(writes, ['first', 'last'])
})

test('failed draft remains available for retry', async () => {
  let fail = true
  const errors: boolean[] = []
  const writes: string[] = []
  const writer = new MeetingDetailsWriter(
    async ({ notes }) => {
      if (fail) throw new Error('disk unavailable')
      writes.push(notes)
    },
    (failed) => errors.push(failed)
  )
  writer.update('Title', 'keep me')
  await assert.rejects(writer.flush(), /disk unavailable/)
  fail = false
  await writer.flush()
  assert.deepEqual(writes, ['keep me'])
  assert.deepEqual(errors, [true, false])
})

test('a newer draft recovers a failed in-flight write without saving stale content', async () => {
  let reject!: (error: Error) => void
  const gate = new Promise<void>((_, failure) => {
    reject = failure
  })
  const writes: string[] = []
  const writer = new MeetingDetailsWriter(
    async ({ notes }) => {
      if (notes === 'old') await gate
      writes.push(notes)
    },
    () => {}
  )
  writer.update('Title', 'old')
  const flushed = writer.flush()
  writer.update('Title', 'new')
  reject(new Error('temporary failure'))
  await flushed
  await writer.flush()
  assert.deepEqual(writes, ['new'])
})

test('transferring the final draft to Stop cannot resurrect a failed older autosave', async () => {
  let reject!: (error: Error) => void
  const gate = new Promise<void>((_, failure) => {
    reject = failure
  })
  const writes: string[] = []
  const errors: boolean[] = []
  const writer = new MeetingDetailsWriter(
    async ({ notes }) => {
      writes.push(notes)
      await gate
    },
    (failed) => errors.push(failed)
  )
  writer.update('Title', 'old')
  const oldWrite = writer.flush()
  writer.update('Title', 'final note owned by Stop')
  writer.cancelPending()
  reject(new Error('manual-meeting-not-active'))
  await oldWrite
  await writer.flush()
  assert.deepEqual(writes, ['old'])
  assert.deepEqual(errors, [])
})
