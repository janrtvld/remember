import { writeFile } from 'node:fs/promises'
import type { WebContents } from 'electron'

// Launch benchmark support: `scripts/benchmark-startup.mjs` names an output file and reads these marks.
const outputFile = process.env.REMEMBER_STARTUP_TIMELINE
const marks: Array<{ name: string; at: number }> = []

/** Records a launch milestone as epoch milliseconds. Costs one array push when no benchmark is listening. */
export function markStartup(name: string) {
  marks.push({ name, at: performance.timeOrigin + performance.now() })
}

const rendererTimings = `new Promise((resolve) => {
  let largestContentfulPaint = null
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) largestContentfulPaint = entry.startTime
    }).observe({ type: 'largest-contentful-paint', buffered: true })
  } catch {}
  setTimeout(() => {
    const navigation = performance.getEntriesByType('navigation')[0]
    const paint = Object.fromEntries(performance.getEntriesByType('paint').map((entry) => [entry.name, entry.startTime]))
    resolve({
      timeOrigin: performance.timeOrigin,
      url: location.href,
      textLength: document.body.innerText.length,
      responseEnd: navigation?.responseEnd ?? null,
      domContentLoaded: navigation?.domContentLoadedEventEnd ?? null,
      loadEventEnd: navigation?.loadEventEnd ?? null,
      firstContentfulPaint: paint['first-contentful-paint'] ?? null,
      largestContentfulPaint,
      contentVisible: window.__rememberContentAt ?? null,
      resources: performance.getEntriesByType('resource').length,
      transferBytes: performance.getEntriesByType('resource').reduce((sum, entry) => sum + (entry.transferSize || 0), 0),
    })
  }, 3000)
})`

const contentObserver = `(() => {
  const check = () => {
    if (document.body && document.body.innerText.trim().length > 0) window.__rememberContentAt = performance.now()
    else requestAnimationFrame(check)
  }
  check()
})()`

/** Times the first frame in which the app renderer shows text, which the loading indicator never does. */
export function observeStartupContent(webContents: WebContents) {
  if (!outputFile) return
  webContents.on('dom-ready', () => {
    if (webContents.getURL().startsWith('http'))
      void webContents.executeJavaScript(contentObserver).catch(() => undefined)
  })
}

/** Writes the main-process marks and the renderer's paint timings once the app renderer has settled. */
export async function reportStartupTimeline(webContents: WebContents) {
  if (!outputFile) return
  const renderer = await webContents.executeJavaScript(rendererTimings).catch(() => null)
  await writeFile(
    outputFile,
    JSON.stringify({
      processCreatedAt: process.getCreationTime(),
      nodeTimeOrigin: performance.timeOrigin,
      marks,
      renderer,
      memory: process.memoryUsage(),
      cpu: process.cpuUsage(),
    })
  )
}
