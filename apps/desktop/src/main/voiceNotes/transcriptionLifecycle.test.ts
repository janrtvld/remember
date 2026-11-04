import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTranscriptionLifecycle } from './transcriptionLifecycle'

describe('transcription worker lifecycle', () => {
  it('reports only unresolved decoded chunks, including the pending speech tail', () => {
    const lifecycle = createTranscriptionLifecycle<object>()
    const worker = {}
    const interruptions: string[][] = []
    lifecycle.subscribe((chunkIds) => interruptions.push(chunkIds))
    lifecycle.track(worker, 'ready')
    lifecycle.track(worker, 'pending-tail')
    lifecycle.track(worker, 'pending-tail')
    lifecycle.resolve(worker, ['ready'])
    lifecycle.interrupt(worker)
    lifecycle.interrupt(worker)
    assert.deepEqual(interruptions, [['pending-tail']])
  })

  it('does not interrupt replacement-worker chunks when the old worker exits late', () => {
    const lifecycle = createTranscriptionLifecycle<object>()
    const oldWorker = {}
    const newWorker = {}
    const interruptions: string[][] = []
    lifecycle.subscribe((chunkIds) => interruptions.push(chunkIds))
    lifecycle.track(oldWorker, 'old-tail')
    lifecycle.interrupt(oldWorker)
    lifecycle.track(newWorker, 'new-tail')
    lifecycle.resolve(oldWorker, ['new-tail'])
    lifecycle.interrupt(oldWorker)
    assert.deepEqual(interruptions, [['old-tail']])
    lifecycle.interrupt(newWorker)
    assert.deepEqual(interruptions, [['old-tail'], ['new-tail']])
  })

  it('clears retired state before notifying listeners', () => {
    const lifecycle = createTranscriptionLifecycle<object>()
    const worker = {}
    const interruptions: string[][] = []
    lifecycle.subscribe((chunkIds) => {
      interruptions.push(chunkIds)
      lifecycle.interrupt(worker)
    })
    lifecycle.track(worker, 'tail')
    lifecycle.interrupt(worker)
    assert.deepEqual(interruptions, [['tail']])
  })

  it('stops delivering notifications after the listener unsubscribes', () => {
    const lifecycle = createTranscriptionLifecycle<object>()
    const worker = {}
    const interruptions: string[][] = []
    const unsubscribe = lifecycle.subscribe((chunkIds) => interruptions.push(chunkIds))
    unsubscribe()
    lifecycle.track(worker, 'tail')
    lifecycle.interrupt(worker)
    assert.deepEqual(interruptions, [])
  })
})
