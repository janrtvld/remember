import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ContextCaptureEvent } from '../context'
import { isPassiveContext } from '../contextActivity'
import { ContextSnapshotCompactor } from '../contextCompaction'

function event(timestamp: number, text: string, overrides: Partial<ContextCaptureEvent> = {}): ContextCaptureEvent {
  return {
    timestamp,
    appName: 'Dia',
    bundleId: 'company.thebrowser.dia',
    windowTitle: 'Remember',
    text,
    textSource: 'accessibility',
    trigger: 'change',
    monitorName: '',
    screenshotPath: '/never/persist-this.png',
    ...overrides,
  }
}

describe('ContextSnapshotCompactor', () => {
  it('stores a full first snapshot and removes screenshot paths', () => {
    const compactor = new ContextSnapshotCompactor()
    const result = compactor.compact(event(1_000, 'Title\nBody'))

    assert.equal(result?.text, 'Title\nBody')
    assert.equal(result?.screenshotPath, '')
  })

  it('drops identical heartbeats and stores only newly visible lines', () => {
    const compactor = new ContextSnapshotCompactor()
    compactor.compact(event(1_000, 'Title\nBody'))

    assert.equal(compactor.compact(event(31_000, 'Title\nBody', { trigger: 'heartbeat' })), null)
    assert.equal(compactor.compact(event(60_000, 'Title\nBody\nNew decision'))?.text, 'New decision')
  })

  it('writes another full checkpoint after fifteen minutes', () => {
    const compactor = new ContextSnapshotCompactor()
    compactor.compact(event(1_000, 'Title\nBody'))

    const result = compactor.compact(event(1_000 + 15 * 60_000, 'Title\nUpdated body'))
    assert.equal(result?.text, 'Title\nUpdated body')
  })

  it('keeps passive screen changes without treating them as input activity', () => {
    const compactor = new ContextSnapshotCompactor()
    compactor.compact(event(1_000, 'Meeting agenda', { inputIdleSeconds: 0 }))

    const passive = compactor.compact(event(301_000, 'Meeting agenda', { inputIdleSeconds: 300 }))
    assert.ok(passive)
    assert.equal(passive.appName, 'Dia')
    assert.equal(passive.text, '')
    assert.equal(isPassiveContext(passive), true)

    const newSlide = compactor.compact(
      event(331_000, 'Meeting agenda\nJan: review proposal tomorrow', { inputIdleSeconds: 330 })
    )
    assert.equal(newSlide?.text, 'Jan: review proposal tomorrow')
    assert.ok(newSlide && isPassiveContext(newSlide))
    assert.equal(
      compactor.compact(event(361_000, 'Meeting agenda\nJan: review proposal tomorrow', { inputIdleSeconds: 360 })),
      null
    )

    const resumed = compactor.compact(
      event(362_000, 'Meeting agenda\nJan: review proposal tomorrow', { inputIdleSeconds: 0 })
    )
    assert.ok(resumed)
    assert.equal(resumed.text, '')
    assert.equal(isPassiveContext(resumed), false)
  })

  it('keeps independent state per app and window', () => {
    const compactor = new ContextSnapshotCompactor()
    compactor.compact(event(1_000, 'Same text'))

    const otherWindow = compactor.compact(event(2_000, 'Same text', { windowTitle: 'Another tab' }))
    assert.equal(otherWindow?.text, 'Same text')
  })

  it('keeps focus changes even when a known window has no new text', () => {
    const compactor = new ContextSnapshotCompactor()
    compactor.compact(event(1_000, 'Dia text'))
    compactor.compact(
      event(2_000, 'Cursor text', {
        appName: 'Cursor',
        bundleId: 'com.todesktop.230313mzl4w4u92',
        windowTitle: 'Editor',
      })
    )

    const returnedToDia = compactor.compact(event(3_000, 'Dia text'))
    assert.equal(returnedToDia?.appName, 'Dia')
    assert.equal(returnedToDia?.text, '')
    assert.equal(compactor.compact(event(4_000, 'Dia text', { trigger: 'heartbeat' })), null)
  })

  it('keeps and bounds a focused-control change inside the same window', () => {
    const compactor = new ContextSnapshotCompactor()
    compactor.compact(
      event(1_000, 'Editor', {
        focusedElement: { role: 'AXButton', title: 'Build', description: '', value: '' },
      })
    )

    const changed = compactor.compact(
      event(2_000, 'Editor', {
        url: `https://example.com/${'u'.repeat(9_000)}`,
        focusedElement: { role: 'AXTextField', title: 'Prompt', description: '', value: 'v'.repeat(3_000) },
      })
    )

    assert.equal(changed?.text, '')
    assert.equal(changed?.focusedElement?.title, 'Prompt')
    assert.equal(changed?.focusedElement?.value.length, 2_000)
    assert.equal(changed?.url?.length, 8_000)
  })

  it('can seed state when resuming an existing workday', () => {
    const compactor = new ContextSnapshotCompactor()
    compactor.reset([
      {
        id: 'context-1',
        ...event(1_000, 'Already stored'),
        screenshotPath: '',
      },
    ])

    const resumedFocus = compactor.compact(event(2_000, 'Already stored'))
    assert.equal(resumedFocus?.appName, 'Dia')
    assert.equal(resumedFocus?.text, '')
  })

  it('bounds one persisted snapshot', () => {
    const compactor = new ContextSnapshotCompactor()
    const result = compactor.compact(event(1_000, 'a'.repeat(50_000)))
    assert.equal(result?.text.length, 40_000)
  })
})
