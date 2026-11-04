import assert from 'node:assert/strict'
import { renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DictationRecorderEvent } from '@remember/shared'
import type { ElectronApplication, Page } from 'playwright-core'

export async function verifyWidgetLevelUpdates(electron: ElectronApplication, runDirectory: string, checks: string[]) {
  const proof = await electron.evaluate(async ({ BrowserWindow, ipcMain, systemPreferences }) => {
    const window = BrowserWindow.getAllWindows().find((window) => window.getTitle() === 'Remember widget')
    if (!window) throw new Error('Missing widget')
    const { event, payload } = await new Promise<{
      event: Electron.IpcMainEvent
      payload: Extract<DictationRecorderEvent, { type: 'level' }>
    }>((resolve, reject) => {
      const channel = 'remember:dictation-recorder:event'
      const subscription = {
        onLevel(event: Electron.IpcMainEvent, payload: DictationRecorderEvent) {
          if (payload.type !== 'level') return
          clearTimeout(timeout)
          ipcMain.removeListener(channel, subscription.onLevel)
          resolve({ event, payload })
        },
      }
      const timeout = setTimeout(() => {
        ipcMain.removeListener(channel, subscription.onLevel)
        reject(new Error('No active dictation audio levels'))
      }, 5_000)
      ipcMain.on(channel, subscription.onLevel)
    })
    const originalPermission = systemPreferences.getMediaAccessStatus
    const originalSend = window.webContents.send
    let permissionReads = 0
    let widgetUpdates = 0
    try {
      systemPreferences.getMediaAccessStatus = (...args) => {
        permissionReads++
        return originalPermission.apply(systemPreferences, args)
      }
      window.webContents.send = (channel, ...args) => {
        if (channel === 'remember:edge-widget:changed') widgetUpdates++
        originalSend.call(window.webContents, channel, ...args)
      }
      const startedAt = performance.now()
      for (let index = 1; index <= 100; index++) {
        ipcMain.emit('remember:dictation-recorder:event', event, { ...payload, level: index / 1_000 })
      }
      const changedUpdates = widgetUpdates
      for (let index = 0; index < 100; index++) {
        ipcMain.emit('remember:dictation-recorder:event', event, { ...payload, level: 0.1 })
      }
      return {
        fixture: '200 synchronous level events through the active isolated recorder IPC sender',
        durationMs: performance.now() - startedAt,
        permissionReads,
        changedUpdates,
        duplicateUpdates: widgetUpdates - changedUpdates,
      }
    } finally {
      systemPreferences.getMediaAccessStatus = originalPermission
      window.webContents.send = originalSend
    }
  })
  writeFileSync(join(runDirectory, 'widget-level-performance.json'), JSON.stringify(proof, null, 2))
  assert.equal(proof.permissionReads, 0, 'Waveform updates must reuse capture state instead of polling permissions')
  assert(proof.changedUpdates >= 99, 'Changed levels must still reach the widget')
  assert.equal(proof.duplicateUpdates, 0, 'Identical widget state must not be rebroadcast')
  checks.push('200 waveform events avoid permission polling and suppress identical widget broadcasts')
}

export async function revealWidgetActions(widget: Page) {
  await widget.mouse.move(180, 10)
  await widget.locator('.edge-widget-handle').hover()
  await widget.waitForFunction(() => document.querySelector('.edge-widget')?.getAttribute('data-expanded') === 'true')
}

export async function readyWidget(electron: ElectronApplication, target: Page) {
  let widget = electron.windows().find((page) => page.url().includes('/edge-widget/'))
  for (let attempt = 0; !widget && attempt < 100; attempt++) {
    await target.waitForTimeout(100)
    widget = electron.windows().find((page) => page.url().includes('/edge-widget/'))
  }
  assert(widget, 'A setup-complete native widget must exist')
  await widget.waitForFunction(() => window.rememberWidget !== undefined)
  await widget.getByRole('button', { name: 'Open Remember agent' }).waitFor()
  await widget.addStyleTag({ content: 'nextjs-portal { display: none; }' })
  return widget
}

async function assertWidgetHidden(electron: ElectronApplication) {
  assert.equal(
    await electron.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.getTitle() === 'Remember widget')
    ),
    false,
    'Incomplete setup must not leave a native widget window'
  )
}

export async function verifyDisplayFollowing(
  electron: ElectronApplication,
  widget: Page,
  runDirectory: string,
  checks: string[]
) {
  await widget.mouse.move(10, 10)
  const proof = await electron.evaluate(async ({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows().find((window) => window.getTitle() === 'Remember widget')
    if (!window) throw new Error('Missing widget')
    const originalCursor = screen.getCursorScreenPoint
    const originalNearest = screen.getDisplayNearestPoint
    const originalSetBounds = window.setBounds.bind(window)
    const connectedDisplays = screen.getAllDisplays()
    const primary = screen.getPrimaryDisplay()
    const secondary = {
      ...primary,
      id: primary.id + 1,
      workArea: {
        ...primary.workArea,
        x: primary.workArea.x - primary.workArea.width,
        y: primary.workArea.y + 40,
      },
    }
    let displays = [primary, secondary]
    const moves: Electron.Rectangle[] = []
    const samples: Array<{
      name: string
      expected: Electron.Rectangle
      requested: Electron.Rectangle | undefined
      actual: Electron.Rectangle
    }> = []
    const layout = {
      center(display: typeof primary) {
        return {
          x: display.workArea.x + display.workArea.width / 2,
          y: display.workArea.y + display.workArea.height / 2,
        }
      },
      async sample(name: string, display: typeof primary) {
        await new Promise((resolve) => setTimeout(resolve, 400))
        const area = display.workArea
        samples.push({
          name,
          expected: {
            x: area.x + area.width - 360,
            y: area.y + Math.round((area.height - 240) / 2),
            width: 360,
            height: 240,
          },
          requested: moves.at(-1),
          actual: window.getBounds(),
        })
      },
    }
    let cursor = layout.center(primary)
    try {
      // Screen and pointer fixtures are scoped to this disposable Electron process.
      screen.getCursorScreenPoint = () => cursor
      window.setBounds = (bounds, animate) => {
        moves.push({ ...window.getBounds(), ...bounds })
        originalSetBounds(bounds, animate)
      }
      for (const display of connectedDisplays) {
        cursor = layout.center(display)
        await layout.sample(`connected display ${display.id}`, display)
      }
      screen.getDisplayNearestPoint = (point) =>
        displays.find(
          ({ workArea: area }) =>
            point.x >= area.x && point.x < area.x + area.width && point.y >= area.y && point.y < area.y + area.height
        ) ?? primary
      cursor = layout.center(primary)
      await layout.sample('primary', primary)
      cursor = layout.center(secondary)
      await layout.sample('pointer on secondary', secondary)
      secondary.workArea = {
        ...secondary.workArea,
        y: secondary.workArea.y + 24,
        height: secondary.workArea.height - 48,
        width: secondary.workArea.width - 80,
      }
      screen.emit('display-metrics-changed', {}, secondary, ['workArea'])
      await layout.sample('secondary work area changed', secondary)
      displays = [primary]
      screen.emit('display-removed', {}, secondary)
      await layout.sample('secondary disconnected', primary)
      const moveCount = moves.length
      await new Promise((resolve) => setTimeout(resolve, 600))
      const stableMoveCount = moves.length === moveCount
      displays = [primary, secondary]
      screen.emit('display-added', {}, secondary)
      await layout.sample('secondary reconnected', secondary)
      return {
        connectedDisplays: connectedDisplays.map(({ id, workArea }) => ({ id, workArea })),
        fixture:
          'Simulated cursor positions on connected displays, then simulated topology changes; actual native widget window',
        samples,
        stableMoveCount,
        sameWindow:
          !window.isDestroyed() &&
          BrowserWindow.getAllWindows().filter((item) => item.getTitle() === 'Remember widget').length === 1,
        focused: window.isFocused(),
      }
    } finally {
      screen.getCursorScreenPoint = originalCursor
      screen.getDisplayNearestPoint = originalNearest
      window.setBounds = originalSetBounds
      screen.emit('display-metrics-changed', {}, primary, ['workArea'])
    }
  })
  for (const sample of proof.samples) {
    assert.deepEqual(sample.requested ?? sample.actual, sample.expected, sample.name)
    if (sample.name.startsWith('connected display')) assert.deepEqual(sample.actual, sample.expected, sample.name)
  }
  assert.equal(proof.stableMoveCount, true, 'A stationary pointer must not repeatedly move the widget')
  assert.equal(proof.sameWindow, true)
  assert.equal(proof.focused, false)
  writeFileSync(join(runDirectory, 'widget-display-proof.json'), JSON.stringify(proof, null, 2))
  checks.push(
    'Native widget follows simulated pointer/display changes, work-area changes, disconnect and reconnect without recreating its window or taking focus'
  )
  checks.push(
    `Actual native widget bounds match the right edge on all ${proof.connectedDisplays.length} connected displays`
  )
}

export async function verifyWidgetCoreNavigation(
  electron: ElectronApplication,
  target: Page,
  widget: Page,
  runDirectory: string,
  checks: string[]
) {
  const before = {
    meeting: (await target.evaluate(() => window.remember.getState())).manualMeeting?.id ?? null,
    dictation: (await widget.evaluate(() => window.rememberWidget?.getState()))?.dictation?.status ?? null,
  }
  await revealWidgetActions(widget)
  assert.equal(await widget.getByRole('button', { name: /^(Questions|Dictate)$/ }).count(), 0)
  await widget.getByRole('button', { name: 'Open Remember agent', exact: true }).click()
  await target.waitForURL('**/assistant/')
  await target.locator('#assistant-message').waitFor()
  await target.screenshot({ path: join(runDirectory, 'widget-assistant.png') })

  await revealWidgetActions(widget)
  assert.equal(await widget.getByRole('button', { name: 'Voice note', exact: true }).isEnabled(), true)

  await target.evaluate(() => window.remember.updateSettings({ audioCaptureEnabled: false }))
  await revealWidgetActions(widget)
  const startConversation = widget.getByRole('button', { name: 'Start conversation', exact: true })
  await startConversation.waitFor()
  assert.equal(await startConversation.isEnabled(), true)
  const after = {
    meeting: (await target.evaluate(() => window.remember.getState())).manualMeeting?.id ?? null,
    dictation: (await widget.evaluate(() => window.rememberWidget?.getState()))?.dictation?.status ?? null,
  }
  assert.equal(after.meeting, before.meeting, 'Widget navigation must not start a manual meeting')
  const activeDictation = (status: string | null) => ['starting', 'recording', 'transcribing'].includes(status ?? '')
  assert.equal(
    activeDictation(after.dictation),
    activeDictation(before.dictation),
    'Widget navigation must not start dictation'
  )
  assert.equal(
    await electron.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.getTitle() === 'Remember widget')
        ?.isVisible()
    ),
    true
  )
  writeFileSync(join(runDirectory, 'widget-core-navigation.json'), JSON.stringify({ before, after }, null, 2))
  checks.push(
    'Widget opens the real agent composer and exposes Voice note without starting dictation or a manual meeting'
  )
  checks.push(
    'Widget exposes an enabled Start conversation control while audio is off; no recording is started in this navigation check. Questions and Dictate controls are absent'
  )
}

export async function edgeWidgetQa(
  electron: ElectronApplication,
  target: Page,
  runDirectory: string,
  checks: string[]
) {
  let widget = await readyWidget(electron, target)
  const origin = new URL(target.url()).origin
  await target.evaluate(() => window.remember.updateSettings({ privacyOnboardingCompleted: false }))
  await assertWidgetHidden(electron)
  await target.evaluate(() => window.remember.updateSettings({ privacyOnboardingCompleted: true }))
  widget = await readyWidget(electron, target)
  await target.goto(`${origin}/notes/`)
  const profile = await electron.evaluate(({ app }) => app.getPath('userData'))
  const tokens = join(profile, 'models', 'parakeet-tdt-0.6b-v3-int8', 'tokens.txt')
  renameSync(tokens, `${tokens}.qa-held`)
  try {
    await target.evaluate(() => window.remember.updateSettings({ interfaceLanguage: 'en' }))
    assert.equal((await target.evaluate(() => window.remember.getState())).modelDownloaded, false)
    await assertWidgetHidden(electron)
  } finally {
    renameSync(`${tokens}.qa-held`, tokens)
    await target.evaluate(() => window.remember.updateSettings({ interfaceLanguage: 'en' }))
  }
  widget = await readyWidget(electron, target)
  checks.push(
    'Native widget disappears during incomplete onboarding or missing model and returns only after setup is ready'
  )
  await electron.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((window) => window.getTitle() === 'Remember widget')
    if (!window) throw new Error('Missing widget')
    const original = window.setIgnoreMouseEvents.bind(window)
    Object.assign(window, { qaIgnoresMouse: true })
    window.setIgnoreMouseEvents = (ignore, options) => {
      Object.assign(window, { qaIgnoresMouse: ignore })
      original(ignore, options)
    }
  })
  const windowState = await electron.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows().find((window) => window.getTitle() === 'Remember widget')
    if (!window) throw new Error('Missing widget')
    return {
      bounds: window.getBounds(),
      workArea: screen.getDisplayMatching(window.getBounds()).workArea,
      alwaysOnTop: window.isAlwaysOnTop(),
      allWorkspaces: window.isVisibleOnAllWorkspaces(),
      visible: window.isVisible(),
      focused: window.isFocused(),
    }
  })
  assert.equal(windowState.alwaysOnTop, true)
  assert.equal(windowState.allWorkspaces, true)
  assert.equal(windowState.visible, true)
  assert.equal(windowState.focused, false, 'Showing the widget must not take focus')
  assert.equal(windowState.bounds.x + windowState.bounds.width, windowState.workArea.x + windowState.workArea.width)
  await widget.mouse.move(10, 10)
  await widget.waitForTimeout(250)
  await widget.screenshot({ path: join(runDirectory, 'widget-collapsed.png') })
  await revealWidgetActions(widget)
  await widget.waitForFunction(() => document.querySelector('.edge-widget')?.getAttribute('data-expanded') === 'true')
  await widget.getByRole('button', { name: 'Start conversation' }).hover()
  await widget.waitForTimeout(220)
  assert.equal(
    await electron.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((window) => window.getTitle() === 'Remember widget')
      return window && 'qaIgnoresMouse' in window ? window.qaIgnoresMouse : null
    }),
    false
  )
  await widget.screenshot({ path: join(runDirectory, 'widget-expanded.png') })
  await widget.mouse.move(10, 10)
  await widget.waitForFunction(() => document.querySelector('.edge-widget')?.getAttribute('data-expanded') === 'false')
  assert.equal(
    await electron.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((window) => window.getTitle() === 'Remember widget')
      return window && 'qaIgnoresMouse' in window ? window.qaIgnoresMouse : null
    }),
    true
  )
  checks.push('Transparent widget area passes mouse events through; hovering controls restores native hit testing')
  await target.evaluate(() => window.remember.updateSettings({ audioCaptureEnabled: true }))
  const audio = await target.evaluate(() => window.remember.getState())
  if (audio.microphonePermission === 'granted' && audio.systemAudioCheckStatus === 'ready') {
    await revealWidgetActions(widget)
    const subdued = widget.getByRole('button', { name: 'Audio capture · always on' })
    assert.equal(await subdued.getAttribute('aria-haspopup'), 'menu')
    await subdued.hover()
    await widget.waitForTimeout(220)
    await widget.screenshot({ path: join(runDirectory, 'widget-always-on.png') })
    checks.push('Always-on exposes audio pause controls without a manual recording starter')
  } else {
    await assertWidgetHidden(electron)
    checks.push(
      'Enabling always-on keeps the native widget hidden while audio permissions or verification remain incomplete'
    )
  }
  await target.evaluate(() => window.remember.updateSettings({ audioCaptureEnabled: false }))
  widget = await readyWidget(electron, target)

  await verifyDisplayFollowing(electron, widget, runDirectory, checks)
  await verifyWidgetCoreNavigation(electron, target, widget, runDirectory, checks)
  await target.goto(`${origin}/settings/`)

  await electron.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.getTitle() === 'Remember')
      ?.close()
  })
  const stillVisible = await electron.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.getTitle() === 'Remember widget')
      ?.isVisible()
  )
  assert.equal(stillVisible, true)
  await revealWidgetActions(widget)
  await widget.getByRole('button', { name: 'Open Remember agent', exact: true }).click()
  await target.waitForURL('**/assistant/')
  await target.locator('#assistant-message').waitFor()
  await target.goto(`${origin}/settings/`)
  await target.getByRole('switch', { name: 'Screen widget', exact: true }).click()
  if (!widget.isClosed()) await widget.waitForEvent('close')
  assert.equal((await target.evaluate(() => window.remember.getSettings())).edgeWidgetEnabled, false)
  writeFileSync(join(runDirectory, 'widget-proof.json'), JSON.stringify(windowState, null, 2))
  checks.push(
    'Native widget expands on hover, stays above other windows without taking focus, opens the agent, and survives closing the main window'
  )
  checks.push('Settings destroys the widget immediately')
}

/** Historical Questions widget scenario; excluded from the current core smoke flow. */
