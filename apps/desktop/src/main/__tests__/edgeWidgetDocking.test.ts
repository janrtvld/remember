import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { edgeWidgetBounds, edgeWidgetDropTarget } from '@remember/shared'

describe('edge widget docking', () => {
  it('places each edge inside an offset secondary display work area', () => {
    const area = { x: -1728, y: 811, width: 1728, height: 1084 }
    assert.deepEqual(edgeWidgetBounds(area, 'left'), { x: -1728, y: 1233, width: 360, height: 240 })
    assert.deepEqual(edgeWidgetBounds(area, 'right'), { x: -360, y: 1233, width: 360, height: 240 })
    assert.deepEqual(edgeWidgetBounds(area, 'bottom'), { x: -1044, y: 1655, width: 360, height: 240 })
  })

  it('selects the nearest allowed edge and leaves the center and top available for cancellation', () => {
    const area = { width: 1920, height: 1080 }
    for (const [point, expected] of [
      [{ x: 12, y: 540 }, 'left'],
      [{ x: 1908, y: 540 }, 'right'],
      [{ x: 960, y: 1068 }, 'bottom'],
      [{ x: 1850, y: 1070 }, 'bottom'],
      [{ x: 960, y: 540 }, null],
      [{ x: 960, y: 10 }, null],
    ] as const)
      assert.equal(edgeWidgetDropTarget(point, area), expected)
  })
})
