import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright-core'

export async function measureAssistantTyping(page: Page, directory: string) {
  const composer = page.locator('#assistant-message')
  await page.evaluate(() => window.remember.updateSettings({ offlineMode: false, cloudAnalysisConsent: true }))
  await composer.fill('qa-ux-typing-history: review the synthetic client workstreams.')
  await composer.press('Enter')
  await page.waitForFunction(async () => {
    const conversation = await window.remember.getAssistantConversation()
    return !conversation.activeTurnId && conversation.messages.at(-1)?.text.includes('## Workstream 60')
  })
  await page
    .locator('[data-assistant-message]')
    .last()
    .getByRole('heading', { name: 'Workstream 60', exact: true })
    .waitFor()
  await composer.fill('qa-cancel-no-approval')
  await composer.press('Enter')
  await page
    .locator('[data-assistant-message]')
    .last()
    .getByRole('heading', { name: 'Notitie 14', exact: true })
    .waitFor()
  const streamingBefore = await page.evaluate(async () => {
    const conversation = await window.remember.getAssistantConversation()
    return { id: conversation.activeTurnId, length: conversation.messages.at(-1)?.text.length ?? 0 }
  })
  assert(streamingBefore.id && streamingBefore.length > 0, 'Measure a response that has started streaming')
  await composer.fill('')
  await page.evaluate(() => {
    const samples: number[] = []
    const longTasks: number[] = []
    const focused: boolean[] = []
    const observer = new PerformanceObserver((list) => {
      longTasks.push(...list.getEntries().map((entry) => entry.duration))
    })
    observer.observe({ type: 'longtask' })
    const events = {
      input() {
        focused.push(document.hasFocus() && document.visibilityState === 'visible')
        const started = performance.now()
        requestAnimationFrame(() => samples.push(performance.now() - started))
      },
    }
    const composer = document.querySelector('#assistant-message')
    if (!composer) throw new Error('Missing Agent composer')
    composer.addEventListener('input', events.input)
    Object.assign(window, {
      qaAssistantTyping: {
        samples,
        longTasks,
        focused,
        finish() {
          composer.removeEventListener('input', events.input)
          observer.disconnect()
        },
      },
    })
  })
  const text =
    'Please compare the client decisions, list the remaining questions, and suggest a short agenda for our next conversation.'
  await composer.pressSequentially(text, { delay: 12 })
  assert.equal(await composer.inputValue(), text, 'Typing must preserve every character')
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  const proof = await page.evaluate(() => {
    const result = Reflect.get(window, 'qaAssistantTyping')
    result.finish()
    const samples: number[] = [...result.samples].sort((a, b) => a - b)
    return {
      boundary:
        'Input event to next animation frame during a growing response with a long retained chat history in fixture Electron; not physical key-to-paint latency.',
      characters: samples.length,
      medianMs: samples[Math.floor(samples.length / 2)],
      p95Ms: samples[Math.ceil(samples.length * 0.95) - 1],
      maxMs: samples.at(-1),
      longTasks: result.longTasks,
      focused: result.focused.every(Boolean),
    }
  })
  const streamingAfter = await page.evaluate(async () => {
    const conversation = await window.remember.getAssistantConversation()
    return { id: conversation.activeTurnId, length: conversation.messages.at(-1)?.text.length ?? 0 }
  })
  writeFileSync(
    join(directory, 'assistant-typing-performance.json'),
    JSON.stringify({ ...proof, streamingBefore, streamingAfter }, null, 2)
  )
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await page.screenshot({ path: join(directory, `assistant-chat-${colorScheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: null })
  assert.equal(proof.characters, text.length)
  assert(proof.focused, 'Typing measurements require a focused and visible native window')
  assert(proof.p95Ms <= 100, `Composer typing p95 ${proof.p95Ms}ms exceeds 100ms`)
  assert.equal(streamingAfter.id, streamingBefore.id, 'Typing must not interrupt the response')
  assert(streamingAfter.length > streamingBefore.length, 'The measured response must grow during typing')
  await page.getByRole('button', { name: /^(Stoppen|Stop)$/ }).click()
  await page.waitForFunction(async () => !(await window.remember.getAssistantConversation()).activeTurnId)
  await page.reload()
  await composer.waitFor({ state: 'visible' })
  assert.equal(await composer.inputValue(), text, 'Typing-only draft must survive renderer reload')
  await composer.fill('')
  await page.evaluate(() => window.remember.updateSettings({ offlineMode: true }))
}

/** Renderer observations in the QA runner's owned Electron window, never a production attachment. */
export async function observeAssistantSubmit(page: Page, text: string, durationMs = 1_500) {
  await page.evaluate(
    ({ text, durationMs }) => {
      const samples: Record<string, number | boolean | null>[] = []
      const commits: Record<string, number | boolean | null>[] = []
      const longTasks: Record<string, unknown>[] = []
      const result = {
        text,
        startedAt: 0,
        samples,
        commits,
        longTasks,
        visibility: document.visibilityState,
        focused: document.hasFocus(),
        done: false,
      }
      const taskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTasks.push(entry.toJSON())
      })
      taskObserver.observe({ type: 'longtask' })
      Object.assign(window, { qaAssistantSubmit: result })
      document.querySelector('#assistant-message')?.addEventListener(
        'keydown',
        (event) => {
          if ((event as KeyboardEvent).key !== 'Enter') return
          result.startedAt = performance.now()
          const observer = {
            read() {
              const composer = document.querySelector<HTMLTextAreaElement>('#assistant-message')
              const users = [...document.querySelectorAll('[data-assistant-user-message]')].filter((element) =>
                element.textContent?.includes(text)
              )
              return {
                ms: performance.now() - result.startedAt,
                userCount: users.length,
                draftEmpty: composer?.value === '',
                composerFocused: document.activeElement === composer,
                documentFocused: document.hasFocus(),
                scrollTop: document.querySelector('[data-assistant-scroll]')?.scrollTop ?? 0,
                progress: Boolean(document.querySelector('[data-assistant-progress][data-active="true"]')),
              }
            },
            frame() {
              samples.push(observer.read())
              if (performance.now() - result.startedAt < durationMs) requestAnimationFrame(() => observer.frame())
              else {
                taskObserver.disconnect()
                changes.disconnect()
                result.done = true
              }
            },
          }
          const changes = new MutationObserver(() => commits.push(observer.read()))
          changes.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true })
          requestAnimationFrame(() => observer.frame())
        },
        { once: true, capture: true }
      )
    },
    { text, durationMs }
  )
}

export async function saveAssistantSubmit(page: Page, directory: string, sample?: number | string) {
  await page.waitForFunction(() => Reflect.get(window, 'qaAssistantSubmit')?.done === true)
  const result = await page.evaluate(() => Reflect.get(window, 'qaAssistantSubmit'))
  const first = (key: string) => result.samples.find((sample: Record<string, unknown>) => sample[key])?.ms ?? null
  const proof = {
    boundary:
      'Native keyboard event to the next renderer animation frame observing the committed DOM. Not physical key-to-screen paint, provider latency, or p95. One native sample.',
    firstUserMs: first('userCount'),
    draftClearedMs: first('draftEmpty'),
    progressMs: first('progress'),
    userCommitMs: result.commits.find((sample: { userCount: number }) => sample.userCount)?.ms ?? null,
    draftClearedCommitMs: result.commits.find((sample: { draftEmpty: boolean }) => sample.draftEmpty)?.ms ?? null,
    progressCommitMs: result.commits.find((sample: { progress: boolean }) => sample.progress)?.ms ?? null,
    visibility: result.visibility,
    focused: result.focused,
    longTasks: result.longTasks,
    samples: result.samples,
    commits: result.commits,
  }
  writeFileSync(
    join(directory, sample === undefined ? 'assistant-submit-performance.json' : `assistant-submit-${sample}.json`),
    JSON.stringify(proof, null, 2)
  )
  assert(proof.firstUserMs !== null, 'The user message must render')
  assert(proof.draftClearedMs !== null, 'The submitted draft must clear')
  assert(
    result.samples.every((sample: { userCount: number }) => sample.userCount <= 1),
    'One local send must never render two copies'
  )
  assert(
    result.samples.some((sample: { composerFocused: boolean }) => sample.composerFocused),
    'Submission must retain composer focus'
  )
  if (sample === undefined || typeof sample === 'string')
    await page.screenshot({
      path: join(directory, sample === undefined ? 'assistant-send-progress.png' : `assistant-send-${sample}.png`),
    })
  return proof
}

export async function measureRepeatedAssistantSubmit(page: Page, webUrl: string, directory: string) {
  await page.evaluate(() => window.remember.updateSettings({ offlineMode: false, cloudAnalysisConsent: true }))
  await page.goto(`${webUrl}/assistant/`)
  const composer = page.locator('#assistant-message')
  const samples: Awaited<ReturnType<typeof saveAssistantSubmit>>[] = []
  for (let index = 0; index < 30; index += 1) {
    const text = `qa-ux-short-${index}: bevestig deze synthetische snelheidstest.`
    await composer.fill(text)
    await observeAssistantSubmit(page, text, 300)
    await composer.press('Enter')
    samples.push(await saveAssistantSubmit(page, directory, index))
    await page.waitForFunction(async (text) => {
      const conversation = await window.remember.getAssistantConversation()
      return (
        conversation.messages.some((message) => message.role === 'user' && message.text === text) &&
        !conversation.activeTurnId
      )
    }, text)
    await page.getByRole('button', { name: /^(Versturen|Send)$/ }).waitFor({ state: 'visible' })
  }
  const metrics = Object.fromEntries(
    ['firstUserMs', 'draftClearedMs', 'progressMs'].map((key) => {
      const values = samples
        .map((sample) => Reflect.get(sample, key))
        .filter((value): value is number => typeof value === 'number')
        .sort((a, b) => a - b)
      return [
        key,
        {
          n: values.length,
          median: values[Math.floor(values.length / 2)],
          p95: values[Math.ceil(values.length * 0.95) - 1],
          max: values.at(-1),
        },
      ]
    })
  )
  writeFileSync(
    join(directory, 'assistant-submit-distribution.json'),
    JSON.stringify(
      {
        boundary:
          '30 keyboard submissions in one warm native renderer, deterministic provider, growing conversation. Renderer frame observations, not production/model latency or physical paint.',
        metrics,
      },
      null,
      2
    )
  )
  await page.screenshot({ path: join(directory, 'assistant-repeated-completed.png') })
  await page.evaluate(() => window.remember.updateSettings({ offlineMode: true }))
  assert.equal(metrics.firstUserMs.n, 30)
  assert.equal(metrics.draftClearedMs.n, 30)
  assert(metrics.firstUserMs.p95 <= 100, `User message p95 ${metrics.firstUserMs.p95}ms exceeds 100ms`)
  assert(metrics.draftClearedMs.p95 <= 100, `Draft clear p95 ${metrics.draftClearedMs.p95}ms exceeds 100ms`)
}

export async function measureAssistantProgress(page: Page, directory: string) {
  const progress = page.locator('[data-assistant-progress][data-active="true"]').last()
  await progress.waitFor({ state: 'visible' })
  const proof: Record<string, unknown> = {
    boundary:
      'Computed animation state and requestAnimationFrame samples from the owned native renderer. Frame gaps include machine scheduling; not a high-speed camera or a Claude animation measurement.',
  }
  proof.motion = await progress.evaluate(async (element) => {
    const start = performance.now()
    const samples: { ms: number; x: number; y: number; width: number; height: number; dots: string[] }[] = []
    await new Promise<void>((resolve) => {
      const observer = {
        frame() {
          const rect = element.getBoundingClientRect()
          samples.push({
            ms: performance.now() - start,
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            dots: [...element.querySelectorAll('*')]
              .filter((child) => getComputedStyle(child).animationName !== 'none')
              .map((child) => {
                const style = getComputedStyle(child)
                return `${style.transform}/${style.opacity}/${style.backgroundPosition}`
              }),
          })
          if (performance.now() - start < 1_800) requestAnimationFrame(() => observer.frame())
          else resolve()
        },
      }
      requestAnimationFrame(() => observer.frame())
    })
    const gaps = samples
      .slice(1)
      .map((sample, index) => sample.ms - samples[index].ms)
      .sort((a, b) => a - b)
    return {
      animations: element.getAnimations({ subtree: true }).map((animation) => ({
        playState: animation.playState,
        timing: animation.effect?.getTiming(),
        keyframes: animation.effect instanceof KeyframeEffect ? animation.effect.getKeyframes() : [],
      })),
      samples,
      frameGapP95Ms: gaps[Math.ceil(gaps.length * 0.95) - 1],
      frameGapMaxMs: gaps.at(-1),
      layoutDriftPx: Math.max(
        ...samples.flatMap((sample) => [
          Math.abs(sample.x - samples[0].x),
          Math.abs(sample.width - samples[0].width),
          Math.abs(sample.height - samples[0].height),
        ])
      ),
    }
  })
  await page.screenshot({ path: join(directory, 'assistant-thinking.png') })
  proof.themes = {}
  for (const colorScheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme })
    const summary = progress.locator('[data-assistant-progress-summary]')
    Reflect.set(
      proof.themes as object,
      colorScheme,
      await summary.evaluate((element) => ({
        background: getComputedStyle(element).backgroundImage,
        animation: getComputedStyle(element).animationName,
      }))
    )
    await page.screenshot({ path: join(directory, `assistant-thinking-${colorScheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: null })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  try {
    proof.reducedMotion = await progress.evaluate((element) => ({
      text: element.textContent,
      runningAnimations: element
        .getAnimations({ subtree: true })
        .filter((animation) => animation.playState === 'running').length,
    }))
    await page.screenshot({ path: join(directory, 'assistant-reduced-motion.png') })
  } finally {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
  }
  writeFileSync(join(directory, 'assistant-animation-performance.json'), JSON.stringify(proof, null, 2))
  const motion = proof.motion as { animations: unknown[]; samples: { dots: string[] }[]; layoutDriftPx: number }
  assert(motion.animations.length > 0, 'The active progress indicator must expose a real animation')
  assert(motion.layoutDriftPx <= 0.1, 'The animated indicator must not shift its layout or width')
  assert(
    new Set(motion.samples.map((sample) => sample.dots.join(','))).size > 1,
    'The indicator must actually change over frames'
  )
  assert.equal(
    (proof.reducedMotion as { runningAnimations: number }).runningAnimations,
    0,
    'Reduced motion must disable continuous indicator movement'
  )
  return proof
}

export async function measureAssistantReading(page: Page, directory: string) {
  const viewport = page.locator('[data-assistant-scroll]')
  await page.waitForFunction(() => {
    const element = document.querySelector('[data-assistant-scroll]')
    return element && element.scrollHeight > element.clientHeight + 300
  })
  await viewport.evaluate((element) => {
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 300)
    element.dispatchEvent(new Event('scroll'))
  })
  const before = await viewport.evaluate((element) => ({
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
  }))
  await page.locator('#assistant-message').fill('Dit concept blijft bewaard terwijl ik lees.')
  await page.waitForFunction(
    (height) => (document.querySelector('[data-assistant-scroll]')?.scrollHeight ?? 0) > height,
    before.scrollHeight
  )
  const readingSamples = await viewport.evaluate(async (element) => {
    const started = performance.now()
    const samples: { ms: number; scrollTop: number; scrollHeight: number }[] = []
    await new Promise<void>((resolve) => {
      const observer = {
        frame() {
          samples.push({
            ms: performance.now() - started,
            scrollTop: element.scrollTop,
            scrollHeight: element.scrollHeight,
          })
          if (performance.now() - started < 10_000) requestAnimationFrame(() => observer.frame())
          else resolve()
        },
      }
      requestAnimationFrame(() => observer.frame())
    })
    return samples
  })
  const after = await viewport.evaluate((element) => ({
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
  }))
  const proof = {
    before,
    after,
    scrollDriftPx: Math.max(...readingSamples.map((sample) => Math.abs(sample.scrollTop - before.scrollTop))),
    readingSamples,
    draft: await page.locator('#assistant-message').inputValue(),
  }
  writeFileSync(join(directory, 'assistant-reading-performance.json'), JSON.stringify(proof, null, 2))
  await page.screenshot({ path: join(directory, 'assistant-reading-draft.png') })
  assert(
    proof.scrollDriftPx <= 2,
    `Streaming must preserve the chosen reading position; drift ${proof.scrollDriftPx}px`
  )
  assert.equal(proof.draft, 'Dit concept blijft bewaard terwijl ik lees.')
  await page.locator('#assistant-message').fill('')
  return proof
}

export async function measureAssistantWidths(page: Page, directory: string) {
  const original = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  const samples: Record<string, unknown>[] = []
  try {
    for (const width of [390, 768, 1280]) {
      await page.setViewportSize({ width, height: 800 })
      await page.locator('[data-assistant-scroll]').evaluate((element) => {
        element.scrollTop = element.scrollHeight
        element.dispatchEvent(new Event('scroll'))
      })
      const composer = page.locator('[data-assistant-composer]')
      const stop = page.getByRole('button', { name: /^(Stoppen|Stop)$/ })
      await stop.waitFor({ state: 'visible' })
      const layout = await composer.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return {
          width: innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          composer: { x: rect.x, right: rect.right, y: rect.y, bottom: rect.bottom },
        }
      })
      const stopBounds = await stop.boundingBox()
      samples.push({ ...layout, stopBounds })
      await page.screenshot({ path: join(directory, `assistant-streaming-${width}.png`) })
      assert(layout.documentWidth <= width, `No document overflow at ${width}px`)
      assert(layout.composer.x >= 0 && layout.composer.right <= width, `Composer fits at ${width}px`)
      assert(layout.composer.y >= 0 && layout.composer.bottom <= 800, `Composer stays visible at ${width}px`)
      assert(stopBounds && stopBounds.x >= 0 && stopBounds.x + stopBounds.width <= width, `Stop fits at ${width}px`)
      assert(stopBounds.y >= 0 && stopBounds.y + stopBounds.height <= 800, `Stop stays visible at ${width}px`)
    }
  } finally {
    writeFileSync(join(directory, 'assistant-responsive-proof.json'), JSON.stringify(samples, null, 2))
    await page.setViewportSize(original)
  }
}

export async function verifyAssistantDraftScopes(page: Page, directory: string) {
  const composer = page.locator('#assistant-message')
  const before = (await page.evaluate(() => window.remember.getAssistantConversation())).messages
  const scopes = [
    { path: '/assistant/', scope: '', text: 'Mijn gewone concept blijft hier.' },
    { path: '/assistant/?prompt=qa-prefill-one', scope: 'prompt:qa-prefill-one', text: 'Eerste aangepast voorstel.' },
    { path: '/assistant/?prompt=qa-prefill-two', scope: 'prompt:qa-prefill-two', text: 'Tweede aangepast voorstel.' },
    {
      path: '/assistant/?task=qa-unavailable-task',
      scope: 'task:qa-unavailable-task',
      text: 'Mijn taakconcept blijft hier.',
    },
  ]
  for (const entry of scopes) {
    await page.evaluate((path) => window.history.pushState(null, '', path), entry.path)
    await page.waitForFunction((path) => `${location.pathname}${location.search}` === path, entry.path)
    if (entry.scope.startsWith('prompt:')) {
      await page.waitForFunction(
        (text) => document.querySelector<HTMLTextAreaElement>('#assistant-message')?.value === text,
        entry.scope.slice('prompt:'.length)
      )
    }
    if (entry.scope.startsWith('task:')) await page.locator('[data-assistant-task-draft]').waitFor()
    await composer.fill(entry.text)
    await page.waitForFunction(({ scope, text }) => {
      const stored = JSON.parse(sessionStorage.getItem('remember:assistant-session:v1') ?? '{}')
      return (scope ? stored.scopedDrafts?.[scope] : stored.draft) === text
    }, entry)
  }
  const checks: Record<string, unknown>[] = []
  for (const entry of [...scopes].reverse()) {
    await page.evaluate((path) => window.history.pushState(null, '', path), entry.path)
    await page.waitForFunction(
      (text) => document.querySelector<HTMLTextAreaElement>('#assistant-message')?.value === text,
      entry.text
    )
    await page.reload()
    await page.waitForFunction(
      (text) => document.querySelector<HTMLTextAreaElement>('#assistant-message')?.value === text,
      entry.text
    )
    checks.push({ scope: entry.scope || 'general', draft: await composer.inputValue(), reloadPreserved: true })
  }
  assert.deepEqual((await page.evaluate(() => window.remember.getAssistantConversation())).messages, before)
  await page.screenshot({ path: join(directory, 'assistant-draft-scopes.png') })
  writeFileSync(
    join(directory, 'assistant-draft-scopes-proof.json'),
    JSON.stringify(
      {
        boundary:
          'Same native window: client route changes and reload preserve separate session drafts. Synthetic unavailable task route; no task execution or cross-window/relaunch draft persistence claim.',
        noMessageSent: true,
        checks,
      },
      null,
      2
    )
  )
}

export async function verifyAssistantHistoryScroll(page: Page, directory: string) {
  await page.reload()
  await page.locator('[data-assistant-message]').last().waitFor()
  const latest = await page.evaluate(() => window.remember.getAssistantConversation())
  assert(latest.hasEarlier, 'Fixture must span multiple history pages')
  const selector = '[data-assistant-user-message], [data-assistant-message]'
  const count = await page.locator(selector).count()
  const anchor = await page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('[data-assistant-scroll]')
    const first = document.querySelector<HTMLElement>('[data-assistant-user-message], [data-assistant-message]')
    if (!viewport || !first) throw new Error('Missing conversation')
    viewport.scrollTop = 0
    return {
      id: first.dataset.assistantUserMessage ?? first.dataset.assistantMessage,
      top: first.getBoundingClientRect().top,
    }
  })
  await page.waitForFunction(
    (count) => document.querySelectorAll('[data-assistant-user-message], [data-assistant-message]').length > count,
    count
  )
  const after = await page.evaluate((id) => {
    const element = [
      ...document.querySelectorAll<HTMLElement>('[data-assistant-user-message], [data-assistant-message]'),
    ].find((entry) => (entry.dataset.assistantUserMessage ?? entry.dataset.assistantMessage) === id)
    return element?.getBoundingClientRect().top
  }, anchor.id)
  assert(after !== undefined && Math.abs(after - anchor.top) <= 1, 'Prepending history preserves the reading anchor')
  assert.equal(
    await page
      .getByRole('button', { name: /^(Earlier messages|Eerdere berichten|Nieuwste berichten|Latest messages)$/ })
      .count(),
    0
  )
  await page.locator('[data-assistant-scroll]').evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await page.locator(`[data-assistant-message="${latest.messages.at(-1)?.id}"]`).waitFor({ state: 'visible' })
  const loadedCount = await page.locator(selector).count()
  assert(loadedCount > count, 'Returning to latest retains the loaded history')
  await page.screenshot({ path: join(directory, 'assistant-history-scroll.png') })
  writeFileSync(
    join(directory, 'assistant-history-scroll.json'),
    JSON.stringify(
      { before: count, after: loadedCount, anchorDrift: (after ?? 0) - anchor.top, latestRetained: true },
      null,
      2
    )
  )
}
