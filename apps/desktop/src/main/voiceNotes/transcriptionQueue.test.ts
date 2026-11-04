import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTranscriptionQueue } from './transcriptionQueue'

describe('transcription queue', () => {
  it('prioritizes dictation without interrupting a running conversation or reordering peers', async () => {
    const enqueue = createTranscriptionQueue()
    const order: string[] = []
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = enqueue(async () => {
      order.push('running')
      await gate
    })
    const background = enqueue(async () => {
      order.push('background')
    })
    const dictated = enqueue(async () => {
      order.push('dictation')
    }, 'dictation')
    const secondDictation = enqueue(async () => {
      order.push('second-dictation')
    }, 'dictation')
    assert.deepEqual(order, ['running'])
    release()
    await Promise.all([first, background, dictated, secondDictation])
    assert.deepEqual(order, ['running', 'dictation', 'second-dictation', 'background'])
  })
  it('serializes speech recognition work and continues after a failed decode', async () => {
    const enqueue = createTranscriptionQueue()
    const order: string[] = []
    let finishFirst: () => void = () => undefined
    const firstGate = new Promise<void>((resolve) => {
      finishFirst = resolve
    })

    const first = enqueue(async () => {
      order.push('first-start')
      await firstGate
      order.push('first-end')
      throw new Error('decode-failed')
    })
    const second = enqueue(async () => {
      order.push('second')
      return 'done'
    })

    await Promise.resolve()
    assert.deepEqual(order, ['first-start'])
    finishFirst()
    await assert.rejects(first, /decode-failed/)
    assert.equal(await second, 'done')
    assert.deepEqual(order, ['first-start', 'first-end', 'second'])
  })
})
