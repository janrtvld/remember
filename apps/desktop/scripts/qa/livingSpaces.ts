import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { type CaptureState, conversationReference, type WikiPage, type WikiSpace } from '@remember/shared'
import type { Page } from 'playwright-core'

interface SpaceQaOptions {
  target: Page
  runDirectory: string
  checks: string[]
}

interface QaSpace {
  spaceId: string
  spaceName: string
}

export interface SpaceRecordingQa extends QaSpace {
  meetingId: string
  pageSlug: string
  page: WikiPage
  started: CaptureState
}

async function waitForBridgeValue<T>(
  read: () => Promise<T>,
  matches: (value: T) => boolean,
  description: string
): Promise<T> {
  const deadline = Date.now() + 30_000
  while (true) {
    const value = await read()
    if (matches(value)) return value
    assert(Date.now() < deadline, `Timed out waiting for ${description}`)
    await delay(200)
  }
}

async function visibleEditor(target: Page) {
  const editor = target.getByRole('textbox', { name: 'Page content', exact: true })
  await editor.waitFor({ state: 'visible' })
  assert(await editor.isEditable(), 'The document body must be editable, not only its breadcrumb visible')
  return editor
}

async function openQaSpace(target: Page, space: QaSpace) {
  await target.getByRole('link', { name: space.spaceName, exact: true }).first().click()
  await target.waitForURL((url) => url.pathname === '/wiki/' && url.searchParams.get('space') === space.spaceId)
  await target.getByRole('heading', { name: space.spaceName, exact: true }).waitFor()
}

async function recordingPage(target: Page, recording: Pick<SpaceRecordingQa, 'spaceId' | 'pageSlug'>) {
  const pages = await target.evaluate((spaceId) => window.remember.listWikiPages(spaceId), recording.spaceId)
  const matches = pages.filter((page) => page.slug === recording.pageSlug)
  assert.equal(matches.length, 1, 'The Space must contain exactly one reference to this recording')
  return matches[0]
}

function recordingRow(target: Page, recording: Pick<SpaceRecordingQa, 'pageSlug'>) {
  return target.getByRole('main').locator(`a[href*="${encodeURIComponent(recording.pageSlug)}"]`)
}

export async function startSpaceRecordingQa(options: SpaceQaOptions & { space?: QaSpace }): Promise<SpaceRecordingQa> {
  const { target, runDirectory, checks } = options
  let space = options.space
  if (!space) {
    const spaceName = 'Native Space QA'
    await target.getByRole('link', { name: 'Create new space', exact: true }).click()
    const dialog = target.getByRole('dialog', { name: 'New space', exact: true })
    await dialog.getByLabel('Name', { exact: true }).fill(spaceName)
    await dialog.getByLabel('Description', { exact: true }).fill('Native recording and document continuity QA.')
    await dialog.getByRole('button', { name: 'Create space', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await target.getByRole('heading', { name: spaceName, exact: true }).waitFor()
    const overview = await target.evaluate(() => window.remember.getWikiOverview())
    const created = overview.spaces.filter((candidate) => candidate.name === spaceName)
    assert.equal(created.length, 1, 'Creating a Space through the UI must create exactly one local Space')
    space = { spaceId: created[0].id, spaceName }
    checks.push('A new private Space is created through the native renderer UI')
  } else {
    await openQaSpace(target, space)
  }

  const newButton = target.getByRole('button', { name: 'New', exact: true })
  await newButton.focus()
  await newButton.press('Enter')
  await target.getByRole('menu').waitFor({ state: 'visible' })
  await target.keyboard.press('Escape')
  await target.getByRole('menu').waitFor({ state: 'hidden' })
  assert(
    await newButton.evaluate((element) => element === document.activeElement),
    'Closing New must restore keyboard focus'
  )
  await newButton.press('Enter')
  await target.getByRole('menuitem', { name: 'Record conversation', exact: true }).click()
  const started = await waitForBridgeValue(
    () => target.evaluate(() => window.remember.getState()),
    (state) => state.manualMeeting?.status === 'recording',
    'a native recording to start'
  )
  assert(started.manualMeeting?.status === 'recording', `Space recording did not start: ${started.error}`)
  const meetingId = started.manualMeeting.id
  const pageSlug = `meetings/${meetingId}`
  await waitForBridgeValue(
    () => target.evaluate((spaceId) => window.remember.listWikiPages(spaceId), space.spaceId),
    (pages) => pages.some((page) => page.slug === pageSlug),
    'the recording source reference to be saved in its Space'
  )
  const page = await recordingPage(target, { spaceId: space.spaceId, pageSlug })
  const link = page.content.match(/^\[Open opname en transcript\]\(([^)]+)\)/)?.[1]
  assert(link, 'The new Space page must link to the original recording')
  const source = new URL(link, target.url())
  assert.equal(source.pathname, '/conversations/pending/')
  assert.equal(source.searchParams.get('meeting'), meetingId)
  assert.equal(source.searchParams.get('space'), space.spaceId)
  assert.equal(source.searchParams.get('document'), pageSlug)
  await target.getByRole('button', { name: 'Stop recording', exact: true }).waitFor()
  const recording = { ...space, meetingId, pageSlug, page, started }
  writeFileSync(join(runDirectory, `space-recording-${meetingId}-start.json`), JSON.stringify(recording, null, 2))
  await target.screenshot({ path: join(runDirectory, `space-recording-${meetingId}-active.png`) })
  checks.push('Space New → Record conversation starts a native meeting and persists one contextual source reference')
  return recording
}

export async function pauseResumeSpaceRecordingQa(options: SpaceQaOptions & { recording: SpaceRecordingQa }) {
  const { target, recording, checks } = options
  await target.getByRole('button', { name: 'Pause recording', exact: true }).click()
  await waitForBridgeValue(
    () => target.evaluate(() => window.remember.getState()),
    ({ manualMeeting }) => manualMeeting?.id === recording.meetingId && manualMeeting.pausedAt != null,
    'the same native recording to pause'
  )
  await target.getByRole('button', { name: 'Resume recording', exact: true }).click()
  await waitForBridgeValue(
    () => target.evaluate(() => window.remember.getState()),
    ({ manualMeeting }) =>
      manualMeeting?.id === recording.meetingId &&
      manualMeeting.status === 'recording' &&
      manualMeeting.pausedAt === null,
    'the same native recording to resume'
  )
  checks.push('The floating native recording controls pause and resume the same Space recording')
}

async function assertSpaceSource(
  options: SpaceQaOptions & { recording: SpaceRecordingQa; expectedTranscriptText?: string | RegExp }
) {
  const { target, recording, expectedTranscriptText } = options
  await target.waitForURL(
    (url) =>
      url.pathname === '/conversations/conversation/' &&
      url.searchParams.get('space') === recording.spaceId &&
      url.searchParams.get('document') === recording.pageSlug,
    { timeout: 60_000 }
  )
  const route = new URL(target.url())
  const days = await target.evaluate(() => window.remember.listDays())
  const dayId = route.searchParams.get('id') ?? recording.started.activeSessionId
  const day = days.find((candidate) => candidate.id === dayId)
  const conversation = day?.memory?.conversations.find((candidate) => candidate.manualMeetingId === recording.meetingId)
  assert(day && conversation, 'The visible source must resolve to this exact native manual meeting')
  assert.equal(route.searchParams.get('conversation'), conversationReference(conversation))
  await target
    .getByRole('navigation', { name: 'Breadcrumb', exact: true })
    .getByRole('link', { name: recording.spaceName, exact: true })
    .waitFor()
  if (expectedTranscriptText) {
    const transcript = target.getByRole('button', { name: 'Transcript', exact: true })
    await transcript.waitFor({ state: 'visible', timeout: 60_000 })
    if ((await transcript.getAttribute('aria-expanded')) !== 'true') await transcript.click()
    await target
      .getByRole('region', { name: 'Transcript', exact: true })
      .getByText(expectedTranscriptText, { exact: false })
      .first()
      .waitFor({ state: 'visible', timeout: 60_000 })
  }
  return { href: route.pathname + route.search, dayId: day.id, conversation }
}

export async function stopSpaceRecordingQa(
  options: SpaceQaOptions & {
    recording: SpaceRecordingQa
    expectedTranscriptText?: string | RegExp
    pauseResume?: boolean
  }
) {
  if (options.pauseResume !== false) await pauseResumeSpaceRecordingQa(options)
  await options.target.getByRole('button', { name: 'Stop recording', exact: true }).click()
  const source = await assertSpaceSource(options)
  await options.target.getByRole('button', { name: 'Stop recording', exact: true }).waitFor({ state: 'hidden' })
  await recordingPage(options.target, options.recording)
  const evidenceName = `space-recording-${options.recording.meetingId}-stopped`
  await options.target.screenshot({ path: join(options.runDirectory, `${evidenceName}.png`) })
  writeFileSync(join(options.runDirectory, `${evidenceName}.json`), JSON.stringify(source, null, 2))
  options.checks.push('Stopping through the native UI opens the exact conversation and retains its Space context')
  return source
}

export async function reopenSpaceRecordingQa(
  options: SpaceQaOptions & {
    recording: SpaceRecordingQa
    expectedTranscriptText?: string | RegExp
    phase?: 'before-restart' | 'after-restart' | 'after-discard'
  }
) {
  const { target, recording, runDirectory, checks } = options
  await target.evaluate(() => localStorage.removeItem('remember:active-meeting-space'))
  const page = await recordingPage(target, recording)
  await openQaSpace(target, recording)
  await target
    .getByRole('group', { name: 'Filter content', exact: true })
    .getByRole('button', { name: 'Conversations', exact: true })
    .click()
  const searchButton = target.getByRole('button', { name: 'Search this Space', exact: true })
  await searchButton.click()
  const search = target.getByRole('searchbox', { name: 'Search this Space', exact: true })
  await search.fill(page.title)
  await recordingRow(target, recording).waitFor({ state: 'visible' })
  assert.equal(
    await recordingRow(target, recording).count(),
    1,
    'The filtered Space must show this recording exactly once'
  )
  await search.press('Escape')
  await search.waitFor({ state: 'hidden' })
  assert(
    await searchButton.evaluate((element) => element === document.activeElement),
    'Closing search must restore keyboard focus'
  )
  await recordingRow(target, recording).click()
  const source = await assertSpaceSource(options)
  await target.getByRole('button', { name: 'Play', exact: true }).click()
  await target.waitForFunction(() => {
    const audio = document.querySelector('main audio')
    return audio instanceof HTMLAudioElement && !audio.paused && audio.currentTime > 0 && audio.duration > 0
  })
  await target.getByRole('button', { name: 'Pause', exact: true }).click()
  const phase = options.phase ?? 'after-restart'
  const evidenceName = `space-recording-${recording.meetingId}-${phase}`
  await target.screenshot({ path: join(runDirectory, `${evidenceName}.png`) })
  const viewport = await target.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  try {
    await target.setViewportSize({ width: 680, height: 800 })
    await target.getByRole('navigation', { name: 'Breadcrumb', exact: true }).waitFor({ state: 'visible' })
    await target.screenshot({ path: join(runDirectory, `${evidenceName}-narrow.png`) })
  } finally {
    await target.setViewportSize(viewport)
  }
  writeFileSync(join(runDirectory, `${evidenceName}.json`), JSON.stringify({ page, ...source }, null, 2))
  checks.push(
    `${phase}: the Space reference opens and plays the same native conversation without transient navigation storage`
  )
  if (options.expectedTranscriptText)
    checks.push('The real speech stimulus is visible inside the opened conversation transcript')
  return source
}

export async function discardSpaceRecordingQa(options: SpaceQaOptions & QaSpace & { ownNotes?: string }) {
  const recording = await startSpaceRecordingQa({ ...options, space: options })
  const { target, ownNotes, runDirectory, checks } = options
  if (ownNotes) {
    await recordingRow(target, recording).click()
    await target.waitForURL(
      (url) => url.pathname === '/conversations/pending/' && url.searchParams.get('meeting') === recording.meetingId
    )
    await target.getByRole('button', { name: `More options for ${recording.page.title}`, exact: true }).click()
    await target.getByRole('menuitem', { name: 'Open linked document', exact: true }).click()
    const editor = await visibleEditor(target)
    const selectionEvidence: unknown[] = []
    const recordSelection = async (phase: string) => {
      const state = await editor.evaluate((element) => {
        const selection = window.getSelection()
        let precedingText: string | null = null
        if (selection?.focusNode && element.contains(selection.focusNode)) {
          const preceding = document.createRange()
          preceding.selectNodeContents(element)
          preceding.setEnd(selection.focusNode, selection.focusOffset)
          precedingText = preceding.toString()
        }
        return {
          collapsed: selection?.isCollapsed ?? false,
          anchor: {
            node: selection?.anchorNode?.nodeName,
            text: selection?.anchorNode?.textContent,
            offset: selection?.anchorOffset,
          },
          focus: {
            node: selection?.focusNode?.nodeName,
            text: selection?.focusNode?.textContent,
            offset: selection?.focusOffset,
          },
          activeElement: {
            tag: document.activeElement?.tagName,
            role: document.activeElement?.getAttribute('role'),
            label: document.activeElement?.getAttribute('aria-label'),
            href: document.activeElement?.getAttribute('href'),
          },
          content: element.textContent ?? '',
          html: element.innerHTML,
          precedingText,
        }
      })
      selectionEvidence.push({ phase, ...state })
      writeFileSync(
        join(runDirectory, `space-recording-${recording.meetingId}-note-selection.json`),
        JSON.stringify(selectionEvidence, null, 2)
      )
      return state
    }
    await editor.focus()
    const initialSelection = await recordSelection('before-cursor-end')
    for (let step = 0; step <= initialSelection.content.length; step++) {
      await target.keyboard.press('ArrowRight', { delay: 50 })
    }
    const endSelection = await recordSelection('after-cursor-end')
    assert(
      endSelection.collapsed && endSelection.precedingText === endSelection.content,
      'Keyboard navigation must move the caret after the complete source link before inserting notes'
    )
    for (const phase of ['after-first-enter', 'after-second-enter']) {
      await target.keyboard.press('Enter', { delay: 50 })
      await recordSelection(phase)
      assert.equal(await editor.locator('a').count(), 1, 'Enter must preserve one complete source link')
      assert.equal(await editor.locator('a').innerText(), initialSelection.content)
    }
    await target.keyboard.insertText(ownNotes)
    await recordSelection('after-note')
    const noteParagraph = editor.locator('p').filter({ hasText: ownNotes })
    assert.equal(await noteParagraph.innerText(), ownNotes, 'The typed note must be a separate paragraph')
    assert.equal(await noteParagraph.locator('a').count(), 0, 'The typed note must not become part of the source link')
    await waitForBridgeValue(
      () => target.evaluate((spaceId) => window.remember.listWikiPages(spaceId), recording.spaceId),
      (pages) => pages.some((page) => page.slug === recording.pageSlug && page.content.includes(ownNotes)),
      'the typed human note to be saved'
    )
    const sourceLink = editor.getByRole('link', { name: 'Open opname en transcript', exact: true })
    await editor.focus()
    await target.keyboard.press('Tab')
    await recordSelection('after-source-tab')
    assert(
      await sourceLink.evaluate((element) => document.activeElement === element),
      'Tab from the editor must focus the source link before keyboard activation'
    )
    await target.keyboard.press('Enter')
    await target.waitForURL(
      (url) => url.pathname === '/conversations/pending/' && url.searchParams.get('meeting') === recording.meetingId
    )
    assert(
      (await recordingPage(target, recording)).content.includes(ownNotes),
      'Keyboard source navigation must preserve the human note'
    )
    checks.push('Enter on the edited document source link opens the native conversation and preserves the human note')
  }
  await target.getByRole('button', { name: 'Stop and delete recording', exact: true }).click()
  await waitForBridgeValue(
    () => target.evaluate(() => window.remember.getState()),
    (state) => state.manualMeeting?.id !== recording.meetingId,
    'the native recording to be discarded'
  )
  await target.getByRole('button', { name: 'Stop and delete recording', exact: true }).waitFor({ state: 'hidden' })
  await waitForBridgeValue(
    () => target.evaluate((spaceId) => window.remember.listWikiPages(spaceId), recording.spaceId),
    (pages) => {
      const page = pages.find((candidate) => candidate.slug === recording.pageSlug)
      return ownNotes
        ? Boolean(page?.content.includes(ownNotes) && page.content.includes('Recording discarded'))
        : !page
    },
    ownNotes
      ? 'the human note to remain with an explicit discarded recording marker'
      : 'the generated reference to disappear after discard'
  )
  const days = await target.evaluate(() => window.remember.listDays())
  assert(
    !days.some((day) =>
      day.memory?.conversations.some((conversation) => conversation.manualMeetingId === recording.meetingId)
    ),
    'A discarded recording must not become a saved conversation'
  )
  const pages = await target.evaluate((spaceId) => window.remember.listWikiPages(spaceId), recording.spaceId)
  if (ownNotes) {
    const preserved = pages.find((candidate) => candidate.slug === recording.pageSlug)
    assert(
      !preserved?.content.includes('Deze bron blijft lokaal beschikbaar voor de eigenaar.'),
      'A discarded recording must not retain the generated claim that its source remains available'
    )
  }
  await target.waitForURL((url) => url.pathname === '/wiki/' && url.searchParams.get('space') === recording.spaceId)
  await target.getByRole('heading', { name: recording.spaceName, exact: true }).waitFor()
  writeFileSync(
    join(runDirectory, `space-recording-${recording.meetingId}-discarded.json`),
    JSON.stringify({ recording, pages }, null, 2)
  )
  if (ownNotes) {
    const filters = target.getByRole('group', { name: 'Filter content', exact: true })
    await filters.getByRole('button', { name: 'Conversations', exact: true }).click()
    await recordingRow(target, recording).waitFor({ state: 'hidden' })
    await filters.getByRole('button', { name: 'Documents', exact: true }).click()
    await recordingRow(target, recording).waitFor({ state: 'visible' })
  }
  await target.screenshot({
    path: join(
      runDirectory,
      `space-recording-${recording.meetingId}-${ownNotes ? 'discard-keeps-notes' : 'discard-removes-reference'}.png`
    ),
  })
  if (ownNotes) {
    await recordingRow(target, recording).click()
    await target.waitForURL(
      (url) =>
        url.pathname === '/wiki/page/' &&
        url.searchParams.get('space') === recording.spaceId &&
        url.searchParams.get('slug') === recording.pageSlug
    )
    const editor = await visibleEditor(target)
    await editor.getByText(ownNotes, { exact: true }).waitFor({ state: 'visible' })
    await editor.getByText('Recording discarded', { exact: true }).waitFor({ state: 'visible' })
    assert.equal(
      await editor.getByRole('link', { name: 'Open opname en transcript', exact: true }).count(),
      0,
      'The preserved document must not offer a link to the discarded recording'
    )
    assert.equal(await editor.locator(`a[href*="${recording.meetingId}"]`).count(), 0)
    await target.screenshot({
      path: join(runDirectory, `space-recording-${recording.meetingId}-discard-preserved-notes-document.png`),
    })
  }
  checks.push(
    ownNotes
      ? 'Discarding a recording preserves its notes under Documents and replaces the dead source link with an explicit discarded marker'
      : 'Discarding a recording removes its generated Space reference'
  )
  return recording
}

async function verifySpaceSubpagesQa({ target, runDirectory, checks, page }: SpaceQaOptions & { page: WikiPage }) {
  await target.getByRole('button', { name: `More options for ${page.title}`, exact: true }).click()
  await target.getByRole('menuitem', { name: 'New subpage', exact: true }).click()
  await target.waitForURL(
    (url) => url.pathname === '/wiki/page/' && Boolean(url.searchParams.get('slug')?.startsWith(`${page.slug}/`))
  )
  const childSlug = new URL(target.url()).searchParams.get('slug')
  assert(childSlug)
  await visibleEditor(target)
  const childTitle = 'Native subpage QA'
  const childContent = 'This child note survives returning to its parent document.'
  const title = target.getByRole('textbox', { name: 'Page title', exact: true })
  await title.fill(childTitle)
  await title.press('Enter')
  await target.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Page content')
  await target.keyboard.insertText(childContent)
  await target
    .getByRole('navigation', { name: 'Wiki breadcrumb', exact: true })
    .getByRole('link', { name: page.title, exact: true })
    .click()
  await target.waitForURL((url) => url.pathname === '/wiki/page/' && url.searchParams.get('slug') === page.slug)
  await visibleEditor(target)
  await waitForBridgeValue(
    () => target.evaluate(() => window.remember.listWikiPages('personal')),
    (pages) =>
      pages.some(
        (child) => child.slug === childSlug && child.title === childTitle && child.content.includes(childContent)
      ),
    'the new child document title and body to survive breadcrumb navigation'
  )

  const sidebar = target.locator('#dashboard-sidebar')
  const spaceLink = sidebar.locator('a[href="/wiki/?space=personal"]')
  await spaceLink.waitFor({ state: 'visible' })
  assert.equal(
    await sidebar.getByRole('link', { name: page.title, exact: true }).count(),
    0,
    'The restored sidebar lists Spaces without nesting document links'
  )
  const category = page.slug.split('/')[0]
  await target
    .getByRole('navigation', { name: 'Wiki breadcrumb', exact: true })
    .locator(`a[href="/wiki/category/?space=personal&category=${category}"]`)
    .click()
  await target.waitForURL((url) => url.pathname === '/wiki/category/' && url.searchParams.get('category') === category)
  await target.getByRole('main').getByRole('link', { name: page.title, exact: true }).click()
  await target.waitForURL((url) => url.pathname === '/wiki/page/' && url.searchParams.get('slug') === page.slug)
  await visibleEditor(target)
  const subpages = target.getByRole('region', { name: 'Subpages', exact: true })
  const childLink = subpages.getByRole('link', { name: childTitle, exact: true })
  await childLink.waitFor({ state: 'visible' })
  assert.equal(await subpages.locator('details').count(), 0, 'Subpages remain visible without a disclosure')
  const dimensions = async () => {
    const [pointerCoarse, space, child] = await Promise.all([
      target.evaluate(() => matchMedia('(pointer: coarse)').matches),
      spaceLink.boundingBox(),
      childLink.boundingBox(),
    ])
    assert(space && child, 'The Space and child page links must be visible')
    return { pointerCoarse, space, child }
  }
  const viewport = await target.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  const session = await target.context().newCDPSession(target)
  try {
    await target.setViewportSize({ width: 1280, height: 900 })
    await session.send('Emulation.setTouchEmulationEnabled', { enabled: false })
    await target.waitForFunction(() => !matchMedia('(pointer: coarse)').matches)
    const desktop = await dimensions()
    assert.equal(desktop.space.height, 32)
    assert.equal(desktop.child.height, 40)
    await target.screenshot({ path: join(runDirectory, 'living-space-subpages-desktop.png') })

    await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
    await target.waitForFunction(() => matchMedia('(pointer: coarse)').matches)
    const touch = await dimensions()
    for (const [name, bounds] of Object.entries({ space: touch.space, child: touch.child })) {
      assert(bounds.width >= 44 && bounds.height >= 44, `${name} must offer a 44px touch target`)
    }
    await target.screenshot({ path: join(runDirectory, 'living-space-touch.png') })

    await session.send('Emulation.setTouchEmulationEnabled', { enabled: false })
    await target.waitForFunction(() => !matchMedia('(pointer: coarse)').matches)
    const restored = await dimensions()
    assert.deepEqual(restored, desktop, 'Disabling touch emulation must restore the exact compact desktop layout')
    writeFileSync(
      join(runDirectory, 'living-space-touch.json'),
      JSON.stringify({ childSlug, desktop, touch, restored }, null, 2)
    )
  } finally {
    await session.send('Emulation.setTouchEmulationEnabled', { enabled: false })
    await target.setViewportSize(viewport)
    await session.detach()
  }
  await childLink.click()
  await target.waitForURL((url) => url.pathname === '/wiki/page/' && url.searchParams.get('slug') === childSlug)
  await (await visibleEditor(target)).getByText(childContent, { exact: true }).waitFor()
  await spaceLink.click()
  await target.getByRole('heading', { name: 'Categories', exact: true }).waitFor()
  await target.getByRole('heading', { name: 'Recent', exact: true }).waitFor()
  await target.getByRole('main').locator(`a[href="/wiki/category/?space=personal&category=${category}"]`).waitFor()
  assert.equal(await target.getByRole('button', { name: 'Record conversation', exact: true }).count(), 0)
  await target.screenshot({ path: join(runDirectory, 'restored-space-overview.png') })
  checks.push(
    'The restored Space overview exposes categories and recent pages; a child page survives category and breadcrumb navigation, stays visible, and retains 44px touch targets'
  )
}

export async function livingSpacesQa(options: {
  desktopDirectory: string
  profile: string
  runDirectory: string
  launch: () => Promise<Page>
  closeElectron: () => Promise<void>
  checks: string[]
}) {
  const cli = join(options.desktopDirectory, 'native/remember')
  const env = { ...process.env, REMEMBER_DATA_DIR: join(options.profile, 'daily-review'), REMEMBER_AGENT: 'codex' }
  const work = (request: object, spaceId = 'personal') =>
    JSON.parse(
      execFileSync(cli, ['wiki', 'work', '--space', spaceId, '--request', JSON.stringify(request), '--json'], {
        env,
        encoding: 'utf8',
        timeout: 20_000,
      })
    )
  let target = await options.launch()
  const input = {
    action: 'ensure',
    source: 'https://woub.sentry.io/issues/123456789',
    title: 'Woub · pushonderzoek',
    content: '## Onderzoek\n\nHypothese: targeting.\n\n## Volgende stap\n\nControleer het verzendbewijs.',
    client: 'codex',
    summary: 'Onderzoek gestart',
  }
  const page: WikiPage = work(input)
  assert.equal(work(input).slug, page.slug)
  const mcp = spawnSync(cli, ['mcp'], {
    env,
    encoding: 'utf8',
    timeout: 20_000,
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'remember_space_work', arguments: { space: 'personal', action: 'find-source', source: input.source } } })}\n`,
  })
  assert.equal(mcp.status, 0, mcp.stderr)
  const mcpResult = JSON.parse(mcp.stdout.trim())
  assert.equal(JSON.parse(mcpResult.result.content[0].text).slug, page.slug)
  options.checks.push('The compiled stdio MCP tool reads the same source-bound document as the CLI')
  const baseline = work({ action: 'changes' })
  await target.evaluate(
    (page) =>
      window.remember.saveWikiPage({
        spaceId: 'personal',
        slug: page.slug,
        title: page.title,
        content: `${page.content}\n\nBijdrage Jan: geen send record gevonden.`,
        expectedRevision: page.revision,
      }),
    page
  )
  assert.throws(
    () =>
      work({
        action: 'patch',
        slug: page.slug,
        expectedRevision: page.revision,
        before: 'Hypothese: targeting.',
        after: 'Conclusie',
        client: 'codex',
        summary: 'Verouderde conclusie',
      }),
    /wiki-page-conflict/
  )
  const contributions = work({ action: 'changes', cursor: baseline.cursor })
  const current: WikiPage = contributions.pages.find((item: WikiPage) => item.slug === page.slug)
  assert(current.content.includes('Bijdrage Jan'))
  assert(
    contributions.contributions.some(
      (entry: { slug: string; revisions: { actor: string }[] }) =>
        entry.slug === page.slug && entry.revisions.some((revision) => revision.actor === 'user')
    )
  )
  const updated: WikiPage = work({
    action: 'patch',
    slug: current.slug,
    expectedRevision: current.revision,
    before: 'Controleer het verzendbewijs.',
    after: 'Onderzoek de aanmaak en targeting; de provider is nog niet bewezen als oorzaak.',
    client: 'claude',
    summary: 'Bijdrage Jan verwerkt; volgende stap aangescherpt',
  })
  options.checks.push(
    'Native CLI creates once by source, sees a renderer contribution, rejects stale writes and accepts a second client patch'
  )
  await target.goto(
    `${await target.evaluate(() => location.origin)}/wiki/page/?space=personal&slug=${encodeURIComponent(page.slug)}`
  )
  const editor = await visibleEditor(target)
  await editor.getByText('Bijdrage Jan: geen send record gevonden.', { exact: true }).waitFor()
  await editor
    .getByText('Onderzoek de aanmaak en targeting; de provider is nog niet bewezen als oorzaak.', { exact: true })
    .waitFor()
  await target.screenshot({ path: join(options.runDirectory, 'living-space-document.png') })
  await verifySpaceSubpagesQa({ target, runDirectory: options.runDirectory, checks: options.checks, page: updated })
  await options.closeElectron()
  target = await options.launch()
  const resumed: WikiPage = work({ action: 'find-source', source: input.source })
  assert.equal(resumed.revision, updated.revision)
  assert.equal(resumed.content, updated.content)
  const history = await target.evaluate(
    (slug) => window.remember.getWikiPageHistory({ spaceId: 'personal', slug }),
    page.slug
  )
  assert.equal(history.revisions[0].sourceId, 'client:claude')
  writeFileSync(
    join(options.runDirectory, 'living-spaces-proof.json'),
    JSON.stringify(
      {
        page: resumed,
        history,
        contributions,
        boundary:
          'Real Electron, CLI and IPC. Client names self-reported; no actual Codex/Claude model or second account.',
      },
      null,
      2
    )
  )
  options.checks.push(
    'Document, revision lineage, client attribution and human contribution survive an Electron restart'
  )

  const localSpaces: Array<WikiSpace & { page: WikiPage }> = []
  for (const name of ['Native local memory', 'Native second memory']) {
    await target.getByRole('link', { name: 'Create new space', exact: true }).click()
    const dialog = target.getByRole('dialog', { name: 'New space', exact: true })
    await dialog.getByLabel('Name', { exact: true }).fill(name)
    await dialog.getByRole('button', { name: 'Create space', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await target.getByRole('heading', { name, exact: true }).waitFor()
    const overview = await target.evaluate(() => window.remember.getWikiOverview())
    assert(!('cloud' in overview), 'Spaces must not depend on an account connection')
    const created = overview.spaces.find((space) => space.name === name)
    assert(created)
    const saved: WikiPage = work(
      {
        ...input,
        source: `https://example.test/memory/${created.id}`,
        title: `${name} decision`,
        content: 'Keep the project context available on this Mac.',
      },
      created.id
    )
    await target.getByRole('main').getByRole('link', { name: saved.title, exact: true }).waitFor()
    localSpaces.push({ ...created, page: saved })
  }
  await target.screenshot({ path: join(options.runDirectory, 'local-spaces-created.png') })
  await options.closeElectron()
  target = await options.launch()
  const overview = await target.evaluate(() => window.remember.getWikiOverview())
  assert(overview.spaces.some((space) => space.id === 'personal'))
  for (const space of localSpaces) {
    assert(overview.spaces.some((candidate) => candidate.id === space.id && candidate.name === space.name))
    const pages = await target.evaluate((id) => window.remember.listWikiPages(id), space.id)
    assert.equal(pages.find((page) => page.slug === space.page.slug)?.revision, space.page.revision)
    assert.equal(pages.find((page) => page.slug === space.page.slug)?.content, space.page.content)
  }
  await target.evaluate((id) => window.remember.removeLocalWikiSpace({ spaceId: id }), localSpaces[1].id)
  const afterRemoval = await target.evaluate(() => window.remember.getWikiOverview())
  assert(!afterRemoval.spaces.some((space) => space.id === localSpaces[1].id))
  assert(afterRemoval.spaces.some((space) => space.id === localSpaces[0].id))
  assert(afterRemoval.spaces.some((space) => space.id === 'personal'))
  writeFileSync(
    join(options.runDirectory, 'local-spaces-proof.json'),
    JSON.stringify({ localSpaces, afterRestart: overview.spaces, afterRemoval: afterRemoval.spaces }, null, 2)
  )
  options.checks.push(
    'Two Spaces created without descriptions or sign-in accept native agent writes, retain their identities and content after restart, and delete independently of Personal'
  )
}
