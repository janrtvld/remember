import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type EdgeWidgetEdge, edgeWidgetBounds } from '@remember/shared'
import type { ElectronApplication, Page } from 'playwright-core'
import { readyWidget } from './edgeWidget'

declare global {
  var qaWidgetCursor: { x: number; y: number }
  var qaWidgetOriginalCursor: () => Electron.Point
}

export async function edgeWidgetDockingQa({
  launch,
  closeElectron,
  getElectron,
  runDirectory,
  checks,
}: {
  launch: () => Promise<Page>
  closeElectron: () => Promise<void>
  getElectron: () => ElectronApplication | undefined
  runDirectory: string
  checks: string[]
}) {
  let target = await launch()
  let electron = getElectron()
  assert(electron)
  let widget = await readyWidget(electron, target)
  const dragEvents: unknown[] = []
  await widget.exposeFunction('qaDragEvent', (event: unknown) => dragEvents.push(event))
  await widget.evaluate(() => {
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture', 'resize']) {
      window.addEventListener(
        type,
        (event) => {
          void (window as unknown as { qaDragEvent: (event: unknown) => Promise<void> }).qaDragEvent({
            type,
            target: event.target instanceof Element ? event.target.className : null,
            x: event instanceof PointerEvent ? event.clientX : null,
            y: event instanceof PointerEvent ? event.clientY : null,
            buttons: event instanceof PointerEvent ? event.buttons : null,
            width: innerWidth,
            height: innerHeight,
          })
        },
        true
      )
    }
    window.rememberWidget?.onState((state) => {
      void (window as unknown as { qaDragEvent: (event: unknown) => Promise<void> }).qaDragEvent({
        docking: state.docking,
      })
    })
  })
  const display = await electron.evaluate(({ screen }) => {
    const display = screen.getPrimaryDisplay()
    globalThis.qaWidgetOriginalCursor = screen.getCursorScreenPoint
    globalThis.qaWidgetCursor = {
      x: display.bounds.x + display.bounds.width / 2,
      y: display.bounds.y + display.bounds.height / 2,
    }
    screen.getCursorScreenPoint = () => globalThis.qaWidgetCursor
    return display
  })
  const proof: unknown[] = []
  async function cursor(x: number, y: number) {
    assert(electron)
    await electron.evaluate(
      (_, point) => {
        globalThis.qaWidgetCursor = point
      },
      { x, y }
    )
  }
  async function docked(edge: EdgeWidgetEdge) {
    await widget.waitForFunction((edge) => {
      return (
        document.querySelector('.edge-widget')?.getAttribute('data-edge') === edge &&
        document.querySelector('.edge-widget-root')?.getAttribute('data-docking') === 'false'
      )
    }, edge)
    assert(electron)
    const native = await electron.evaluate(({ BrowserWindow, globalShortcut }) => {
      const window = BrowserWindow.getAllWindows().find((window) => window.getTitle() === 'Remember widget')
      if (!window) throw new Error('Missing widget')
      return {
        bounds: window.getBounds(),
        focused: window.isFocused(),
        escape: globalShortcut.isRegistered('Escape'),
        hiddenInMissionControl: window.isHiddenInMissionControl(),
      }
    })
    assert.deepEqual(native.bounds, edgeWidgetBounds(display.workArea, edge))
    assert.equal(native.focused, false)
    assert.equal(native.escape, false)
    assert.equal(native.hiddenInMissionControl, true)
    assert.equal((await target.evaluate(() => window.remember.getSettings())).edgeWidgetEdge, edge)
    proof.push({ edge, ...native })
  }
  async function begin() {
    await widget.mouse.move(180, 10)
    await widget.waitForTimeout(220)
    const handle = await widget.locator('.edge-widget-handle').boundingBox()
    assert(handle)
    assert(electron)
    const bounds = await electron.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.getTitle() === 'Remember widget')
        ?.getBounds()
    )
    assert(bounds)
    const x = handle.x + handle.width / 2
    const y = handle.y + handle.height / 2
    await cursor(bounds.x + x, bounds.y + y)
    await widget.mouse.move(x, y)
    await widget.waitForTimeout(250)
    proof.push({
      before: { x, y, bounds, handle },
      state: await widget.evaluate(() => window.rememberWidget?.getState()),
    })
    await widget.screenshot({ path: join(runDirectory, 'widget-before-drag.png') })
    await widget.mouse.down()
    await widget.mouse.move(x - 10, y - 10)
    await widget.waitForFunction(
      () => document.querySelector('.edge-widget-root')?.getAttribute('data-docking') === 'true'
    )
    const fullscreen = await electron.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.getTitle() === 'Remember widget')
        ?.getBounds()
    )
    assert.deepEqual(fullscreen, display.bounds, 'Placement overlay must cover the active display')
  }
  async function moveTo(x: number, y: number, edge: EdgeWidgetEdge | null) {
    await cursor(display.bounds.x + x, display.bounds.y + y)
    await widget.mouse.move(x, y)
    await widget.waitForFunction(
      (edge) =>
        (document.querySelector('.edge-widget-drop-target[data-selected="true"]')?.getAttribute('data-edge') ??
          null) === edge,
      edge
    )
  }
  try {
    await widget.waitForTimeout(400)
    for (const edge of ['left', 'right', 'bottom'] as const) {
      await begin()
      await moveTo(
        edge === 'left' ? 12 : edge === 'right' ? display.bounds.width - 12 : display.bounds.width / 2,
        edge === 'bottom' ? display.bounds.height - 12 : display.bounds.height / 2,
        edge
      )
      await widget.waitForTimeout(200)
      await widget.screenshot({ path: join(runDirectory, `widget-placement-${edge}.png`) })
      await widget.mouse.up()
      await docked(edge)
      await widget.locator('.edge-widget-handle').hover()
      await widget.waitForTimeout(220)
      await widget.screenshot({ path: join(runDirectory, `widget-docked-${edge}.png`) })
      const box = await widget.locator('.edge-widget').boundingBox()
      assert(box)
      const point = {
        x: edge === 'left' ? 0 : edge === 'right' ? 359 : box.x + box.width / 2,
        y: edge === 'bottom' ? 239 : box.y + box.height / 2,
      }
      await widget.mouse.move(point.x, point.y)
      await widget.waitForTimeout(350)
      assert.equal(await widget.locator('.edge-widget').getAttribute('data-expanded'), 'true')
      assert.equal(
        await widget.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[data-widget-hit]'), point),
        true,
        `${edge} edge gap must retain native hit testing`
      )
      await widget.mouse.move(180, 10)
      await widget.waitForTimeout(350)
      assert.equal(await widget.locator('.edge-widget').getAttribute('data-expanded'), 'false')
    }
    checks.push('Widget stays expanded in the gap at each screen edge and collapses after leaving the hover area')
    checks.push(
      'Real pointer gestures dock the native widget left, right, and bottom; full-display overlay stays non-focused and Escape is released afterward'
    )
    await begin()
    await moveTo(display.bounds.width / 2, display.bounds.height / 2, null)
    await widget.mouse.up()
    await docked('bottom')
    await begin()
    await moveTo(12, display.bounds.height / 2, 'left')
    await widget.keyboard.press('Escape')
    await widget.mouse.up()
    await docked('bottom')
    checks.push('Dropping away from an edge and pressing Escape both cancel placement without changing the saved edge')
    await widget.locator('.edge-widget-handle').hover()
    await widget.getByRole('button', { name: 'Open Remember agent', exact: true }).click()
    await target.waitForURL('**/assistant/')
    await target.locator('#assistant-message').waitFor()
    assert.equal((await widget.evaluate(() => window.rememberWidget?.getState()))?.docking, null)
    checks.push('Hover reveals the controls and clicking the agent opens its composer without entering placement mode')
    if (process.argv.includes('--mission-control')) {
      await widget.mouse.move(180, 10)
      await widget.waitForTimeout(250)
      const bounds = edgeWidgetBounds(display.workArea, 'bottom')
      const region = `-R${bounds.x},${bounds.y},${bounds.width},${bounds.height}`
      execFileSync('/usr/sbin/screencapture', ['-x', region, join(runDirectory, 'widget-before-mission-control.png')])
      execFileSync('/usr/bin/open', ['-a', 'Mission Control'])
      try {
        await widget.waitForTimeout(800)
        execFileSync('/usr/sbin/screencapture', ['-x', region, join(runDirectory, 'widget-in-mission-control.png')])
      } finally {
        execFileSync('/usr/bin/osascript', ['-e', 'tell application "System Events" to key code 53'])
        await widget.waitForTimeout(800)
      }
      execFileSync('/usr/sbin/screencapture', ['-x', region, join(runDirectory, 'widget-after-mission-control.png')])
      await docked('bottom')
      checks.push(
        'Opened and closed macOS Mission Control; saved before, during, and after screen crops for visual verification'
      )
    }
  } finally {
    writeFileSync(join(runDirectory, 'widget-drag-events.json'), JSON.stringify(dragEvents, null, 2))
    writeFileSync(join(runDirectory, 'widget-docking-proof.json'), JSON.stringify(proof, null, 2))
    await electron.evaluate(({ screen }) => {
      screen.getCursorScreenPoint = globalThis.qaWidgetOriginalCursor
    })
  }
  await closeElectron()
  target = await launch()
  electron = getElectron()
  assert(electron)
  widget = await readyWidget(electron, target)
  assert.equal((await target.evaluate(() => window.remember.getSettings())).edgeWidgetEdge, 'bottom')
  const restored = await electron.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows().find((window) => window.getTitle() === 'Remember widget')
    if (!window) throw new Error('Missing widget')
    return {
      bounds: window.getBounds(),
      workArea: screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea,
    }
  })
  assert.deepEqual(restored.bounds, edgeWidgetBounds(restored.workArea, 'bottom'))
  proof.push({ restart: restored })
  checks.push('Bottom docking survives a complete Electron restart and uses the current active display work area')
  writeFileSync(join(runDirectory, 'widget-docking-proof.json'), JSON.stringify(proof, null, 2))
}
