import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { readyWidget, revealWidgetActions, verifyWidgetCoreNavigation } from './edgeWidget'

declare global {
  var qaWidgetMenu: Electron.Menu | null
}

export async function edgeWidgetMenuQa({
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
  async function start() {
    const target = await launch()
    const electron = getElectron()
    assert(electron)
    await electron.evaluate(({ Menu }) => {
      const original = Menu.buildFromTemplate
      globalThis.qaWidgetMenu = null
      Menu.buildFromTemplate = (template) => {
        const menu = original(template)
        globalThis.qaWidgetMenu = menu
        return menu
      }
    })
    return { target, electron }
  }
  let { target, electron } = await start()
  let widget = await readyWidget(electron, target)
  const widgetUrl = widget.url()
  await Promise.all([widget.waitForEvent('load'), widget.evaluate(() => window.location.reload())])
  widget = await readyWidget(electron, target)
  assert.equal(widget.url(), widgetUrl)
  checks.push('Renderer-initiated reload restores the same native widget and its preload bridge')
  async function hidden() {
    assert.equal(
      await electron.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.getTitle() === 'Remember widget')
      ),
      false
    )
  }
  async function menu(selector = '.edge-widget-handle') {
    await electron.evaluate(() => {
      globalThis.qaWidgetMenu = null
    })
    await widget.mouse.move(180, 10)
    await widget.waitForTimeout(250)
    if (selector !== '.edge-widget-handle') await revealWidgetActions(widget)
    await widget.locator(selector).first().click({ button: 'right' })
    let labels: string[] | undefined
    for (let attempt = 0; !labels && attempt < 30; attempt++) {
      labels = await electron.evaluate(() => globalThis.qaWidgetMenu?.items.map((item) => item.label))
      if (!labels) await target.waitForTimeout(100)
    }
    assert(labels, 'Right-click must open a native menu')
    assert.equal((await widget.evaluate(() => window.rememberWidget?.getState()))?.docking, null)
    return labels
  }
  async function choose(label: string) {
    // Inspect the real native menu, then invoke its item rather than sending OS-wide keystrokes.
    await electron.evaluate(({ BrowserWindow }, label) => {
      const menu = globalThis.qaWidgetMenu
      const item = menu?.items.find((item) => item.label === label)
      if (!menu || !item) throw new Error(`Missing menu item: ${label}`)
      menu.closePopup()
      item.click(item, BrowserWindow.getFocusedWindow(), {} as Electron.KeyboardEvent)
    }, label)
  }
  async function enableInSettings() {
    await target.goto(`${new URL(target.url()).origin}/settings/`)
    const toggle = target.getByRole('switch', { name: 'Screen widget', exact: true })
    await toggle.waitFor()
    assert.equal(await toggle.getAttribute('aria-checked'), 'false')
    await toggle.click()
    widget = await readyWidget(electron, target)
    const settings = await target.evaluate(() => window.remember.getSettings())
    assert.equal(settings.edgeWidgetEnabled, true)
    assert.equal(settings.edgeWidgetHiddenUntil, null)
  }

  await target.evaluate(() =>
    window.remember.updateSettings({
      audioCaptureEnabled: true,
      capturePaused: true,
      capturePauseSources: ['audio'],
      capturePausedUntil: null,
    })
  )
  async function conversationMenu() {
    await revealWidgetActions(widget)
    await widget.getByRole('button', { name: 'Audio capture · always on' }).click()
    assert.deepEqual(await electron.evaluate(() => globalThis.qaWidgetMenu?.items.map((item) => item.label)), [
      'Pause…',
      'Pause for 1 hour',
      '',
      'Preferences…',
    ])
  }
  await conversationMenu()
  const pauseStarted = Date.now()
  await choose('Pause for 1 hour')
  await target.waitForFunction(async () => (await window.remember.getSettings()).capturePausedUntil !== null)
  const paused = await target.evaluate(() => window.remember.getSettings())
  assert.deepEqual(paused.capturePauseSources, ['audio'])
  assert(paused.capturePausedUntil && paused.capturePausedUntil >= pauseStarted + 3_600_000)
  assert.equal(paused.audioCaptureEnabled, true)
  await conversationMenu()
  await choose('Pause…')
  await target.getByRole('heading', { name: 'Set pause', exact: true }).waitFor()
  assert(new URL(target.url()).pathname === '/exclusions/')
  await target.keyboard.press('Escape')
  await conversationMenu()
  await choose('Preferences…')
  await target.getByRole('heading', { name: 'Conversation preferences', exact: true }).waitFor()
  assert(new URL(target.url()).pathname === '/conversations/')
  await target.screenshot({ path: join(runDirectory, 'widget-conversation-preferences.png') })
  await target.keyboard.press('Escape')
  await target.waitForFunction(() => !new URLSearchParams(location.search).has('preferences'))
  await target.evaluate(() => window.remember.updateSettings({ audioCaptureEnabled: false }))
  await revealWidgetActions(widget)
  await widget.getByRole('button', { name: 'Start conversation' }).waitFor()
  checks.push(
    'Always-on conversation menu pauses audio for one hour and opens the pause dialog and conversation preferences; disabled capture exposes Start conversation'
  )

  await verifyWidgetCoreNavigation(electron, target, widget, runDirectory, checks)

  const labels = await menu()
  assert.deepEqual(labels, ['Dictate', 'Notes', '', 'Hide for 1 hour', 'Hide forever', '', 'Settings…'])
  const bounds = await electron.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.getTitle() === 'Remember widget')
      ?.getBounds()
  )
  assert(bounds)
  await target.waitForTimeout(300)
  execFileSync('/usr/sbin/screencapture', [
    '-x',
    `-R${bounds.x},${bounds.y},${bounds.width},${bounds.height + 80}`,
    join(runDirectory, 'widget-context-menu.png'),
  ])
  await choose('Notes')
  await target.waitForURL('**/notes/')
  await target.getByRole('heading', { name: 'Conversations', exact: true }).waitFor()
  assert.equal(await target.getByRole('tab', { name: 'Notes', exact: true }).getAttribute('aria-selected'), 'true')
  const dictationStatus = (await widget.evaluate(() => window.rememberWidget?.getState()))?.dictation?.status
  assert(!['starting', 'recording', 'transcribing'].includes(dictationStatus ?? ''))
  assert.deepEqual(await menu(), labels)
  checks.push('The native Notes menu opens the Notes tab within Conversations without starting a recording')
  await choose('Settings…')
  await target.waitForURL('**/settings/')
  assert.equal(
    await target.getByRole('switch', { name: 'Screen widget', exact: true }).getAttribute('aria-checked'),
    'true'
  )
  checks.push('Right-click opens a native menu without starting placement; Settings opens the widget preference')

  assert.deepEqual(await menu('.edge-widget-action'), labels)
  const beforeHide = Date.now()
  await choose('Hide for 1 hour')
  await hidden()
  await target.waitForFunction(() => document.querySelector('[role="switch"][aria-checked="false"]') !== null)
  assert.equal(
    await target.getByRole('switch', { name: 'Screen widget', exact: true }).getAttribute('aria-checked'),
    'false'
  )
  const until = (await target.evaluate(() => window.remember.getSettings())).edgeWidgetHiddenUntil
  assert(until && until >= beforeHide + 3_600_000 && until < Date.now() + 3_600_000)
  await closeElectron()
  ;({ target, electron } = await start())
  await hidden()
  assert.equal((await target.evaluate(() => window.remember.getSettings())).edgeWidgetHiddenUntil, until)
  await enableInSettings()
  checks.push('One-hour hide works from a widget control, persists through restart, and can be cancelled in Settings')

  await menu()
  await choose('Hide forever')
  await hidden()
  await closeElectron()
  ;({ target, electron } = await start())
  await hidden()
  assert.equal((await target.evaluate(() => window.remember.getSettings())).edgeWidgetEnabled, false)
  await enableInSettings()
  checks.push('Hide forever persists through restart; the Settings switch restores the widget')

  await target.evaluate(() => window.remember.updateSettings({ edgeWidgetHiddenUntil: Date.now() + 1_500 }))
  await hidden()
  widget = await readyWidget(electron, target)
  assert.equal((await target.evaluate(() => window.remember.getSettings())).edgeWidgetHiddenUntil, null)
  assert.equal(
    await target.getByRole('switch', { name: 'Screen widget', exact: true }).getAttribute('aria-checked'),
    'true'
  )
  checks.push('The actual native snooze timer restores the widget automatically at a shortened test deadline')

  await target.evaluate(() => window.remember.updateSettings({ edgeWidgetHiddenUntil: Date.now() + 3_600_000 }))
  await hidden()
  await electron.evaluate(({ powerMonitor }) => {
    const original = Date.now
    Date.now = () => original() + 3_600_001
    try {
      powerMonitor.emit('resume')
    } finally {
      Date.now = original
    }
  })
  widget = await readyWidget(electron, target)
  assert.equal((await target.evaluate(() => window.remember.getSettings())).edgeWidgetHiddenUntil, null)
  checks.push('A simulated wake after the deadline restores the widget and clears the persisted snooze')
  writeFileSync(
    join(runDirectory, 'widget-menu-proof.json'),
    JSON.stringify(
      {
        labels,
        until,
        checks,
        boundary:
          'Real native menu and IPC; menu item selection is invoked programmatically. Sleep uses a process-local clock fixture.',
      },
      null,
      2
    )
  )
}
