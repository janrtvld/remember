import type { DailyReviewContextMoment } from '@remember/shared'
import type { ContextCaptureEvent } from './context'
import { isPassiveContext } from './contextActivity'

const FULL_CHECKPOINT_INTERVAL_MS = 15 * 60_000
const MAX_CONTEXT_CHARACTERS = 40_000
const MAX_APP_NAME_CHARACTERS = 200
const MAX_WINDOW_TITLE_CHARACTERS = 1_000
const MAX_URL_CHARACTERS = 8_000
const MAX_FOCUSED_ROLE_CHARACTERS = 120
const MAX_FOCUSED_LABEL_CHARACTERS = 500
const MAX_FOCUSED_VALUE_CHARACTERS = 2_000

type WindowState = {
  lines: Set<string>
  lastFullAt: number
}

function normalizedLines(text: string): string[] {
  const lines = text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)

  return Array.from(new Set(lines))
}

function boundedText(lines: string[]): string {
  let characters = 0
  const retained: string[] = []

  for (const line of lines) {
    const separatorCharacters = retained.length > 0 ? 1 : 0
    const remaining = MAX_CONTEXT_CHARACTERS - characters - separatorCharacters
    if (remaining <= 0) break
    const bounded = line.slice(0, remaining)
    if (!bounded) break
    retained.push(bounded)
    characters += bounded.length + separatorCharacters
  }

  return retained.join('\n')
}

function keyFor(event: Pick<ContextCaptureEvent, 'appName' | 'windowTitle'>): string {
  return `${event.appName}\u0000${event.windowTitle}`
}

function boundedFocusedElement(focusedElement: ContextCaptureEvent['focusedElement']) {
  if (!focusedElement) return undefined
  const bounded = {
    role: focusedElement.role.slice(0, MAX_FOCUSED_ROLE_CHARACTERS),
    title: focusedElement.title.slice(0, MAX_FOCUSED_LABEL_CHARACTERS),
    description: focusedElement.description.slice(0, MAX_FOCUSED_LABEL_CHARACTERS),
    value: focusedElement.value.slice(0, MAX_FOCUSED_VALUE_CHARACTERS),
  }
  return Object.values(bounded).some(Boolean) ? bounded : undefined
}

/**
 * Accessibility snapshots contain the complete visible window tree. The tree
 * is mostly identical on every heartbeat, so persisting it verbatim makes a
 * workday grow by tens of megabytes. Store a bounded full checkpoint every 15
 * minutes and only newly visible lines between checkpoints.
 */
export class ContextSnapshotCompactor {
  private readonly windows = new Map<string, WindowState>()
  private focusedWindowKey = ''
  private focusedElementKey = ''
  private passive = false

  reset(seed: DailyReviewContextMoment[] = []): void {
    this.windows.clear()
    this.focusedWindowKey = ''
    this.focusedElementKey = ''
    this.passive = false
    for (const moment of [...seed].sort((first, second) => first.timestamp - second.timestamp)) {
      const lines = normalizedLines(moment.text)
      const key = keyFor(moment)
      const previous = this.windows.get(key)
      this.windows.set(key, {
        lines: new Set(lines),
        lastFullAt: previous?.lastFullAt ?? moment.timestamp,
      })
    }
  }

  compact(event: ContextCaptureEvent): ContextCaptureEvent | null {
    const appName = event.appName.slice(0, MAX_APP_NAME_CHARACTERS)
    const windowTitle = event.windowTitle.slice(0, MAX_WINDOW_TITLE_CHARACTERS)
    const lines = normalizedLines(event.text)
    const normalized = {
      ...event,
      appName,
      windowTitle,
      url: event.url?.slice(0, MAX_URL_CHARACTERS),
      focusedElement: boundedFocusedElement(event.focusedElement),
      screenshotPath: '',
    }
    const key = keyFor(normalized)
    const focusedElementKey = JSON.stringify(normalized.focusedElement ?? null)
    const passive = isPassiveContext(event)
    const focusChanged =
      key !== this.focusedWindowKey || focusedElementKey !== this.focusedElementKey || passive !== this.passive
    this.passive = passive
    this.focusedWindowKey = key
    this.focusedElementKey = focusedElementKey
    const previous = this.windows.get(key)
    const needsFullCheckpoint = previous == null || event.timestamp - previous.lastFullAt >= FULL_CHECKPOINT_INTERVAL_MS

    this.windows.set(key, {
      lines: new Set(lines),
      lastFullAt: needsFullCheckpoint ? event.timestamp : (previous?.lastFullAt ?? event.timestamp),
    })

    if (needsFullCheckpoint) {
      return { ...normalized, text: boundedText(lines) }
    }

    const addedLines = lines.filter((line) => !previous.lines.has(line))
    if (addedLines.length === 0) {
      return focusChanged ? { ...normalized, text: '' } : null
    }
    return {
      ...normalized,
      text: boundedText(addedLines),
      trigger: [event.trigger, 'new-visible-text'].filter(Boolean).join(':'),
    }
  }
}
