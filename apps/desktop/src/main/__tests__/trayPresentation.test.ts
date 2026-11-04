import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { UpdateState } from '@remember/shared'
import { formatPauseEnd, getTrayPresentation, getTrayUpdatePresentation } from '../trayPresentation'

const NOW = new Date('2026-08-03T10:00:00Z').getTime()
const defaultPauseState = { pauseReason: null, nextScheduleTransitionAt: null } as const
const defaultUpdateState: UpdateState = {
  status: 'idle',
  availability: 'supported',
  currentVersion: '1.2.3',
  version: null,
  downloadProgress: null,
  errorStage: null,
  revision: 0,
}

describe('getTrayPresentation', () => {
  it('offers pause while recording and resume during a manual pause', () => {
    const recording = getTrayPresentation({
      status: 'recording',
      capturePausedUntil: null,
      now: NOW,
      ...defaultPauseState,
    })
    assert.equal(recording.canPause, true)
    assert.equal(recording.canResume, false)
    assert.equal(recording.icon, 'normal')

    const paused = getTrayPresentation({
      status: 'paused',
      capturePausedUntil: null,
      pauseReason: 'manual',
      nextScheduleTransitionAt: null,
      now: NOW,
    })
    assert.equal(paused.canPause, false)
    assert.equal(paused.canResume, true)
    assert.equal(paused.icon, 'paused')
  })

  it('uses the same end time in timed pause labels', () => {
    const pausedUntil = NOW + 60 * 60 * 1_000
    const formattedEnd = formatPauseEnd(pausedUntil)
    const presentation = getTrayPresentation({
      status: 'paused',
      capturePausedUntil: pausedUntil,
      pauseReason: 'manual',
      nextScheduleTransitionAt: null,
      now: NOW,
    })

    assert.equal(presentation.icon, 'paused')
    assert.ok(presentation.pauseActionLabel.includes(formattedEnd))
    assert.ok(presentation.tooltip.includes(formattedEnd))
  })

  it('returns to the normal icon as soon as capture resumes', () => {
    const presentation = getTrayPresentation({
      status: 'recording',
      capturePausedUntil: NOW + 60 * 60 * 1_000,
      now: NOW,
      ...defaultPauseState,
    })

    assert.equal(presentation.icon, 'normal')
  })

  it('shows scheduled pauses without offering a manual resume action', () => {
    const nextScheduleTransitionAt = NOW + 23 * 60 * 60_000
    const formattedTransition = formatPauseEnd(nextScheduleTransitionAt)
    const presentation = getTrayPresentation({
      status: 'paused',
      capturePausedUntil: null,
      pauseReason: 'schedule',
      nextScheduleTransitionAt,
      now: NOW,
    })

    assert.equal(presentation.icon, 'paused')
    assert.equal(presentation.canResume, false)
    assert.ok(presentation.pauseActionLabel.includes(formattedTransition))
    assert.ok(presentation.tooltip.includes(formattedTransition))
  })
})

describe('getTrayUpdatePresentation', () => {
  it('keeps checking and download progress visible in the tray menu and tooltip', () => {
    const checking = getTrayUpdatePresentation({ ...defaultUpdateState, status: 'checking' })
    const downloading = getTrayUpdatePresentation({
      ...defaultUpdateState,
      status: 'downloading',
      version: '1.3.0',
      downloadProgress: 0.428,
    })

    assert.equal(checking.action, 'none')
    assert.equal(checking.enabled, false)
    assert.equal(downloading.action, 'none')
    assert.equal(downloading.enabled, false)
    assert.ok(downloading.label.includes('1.3.0'))
    assert.ok(downloading.label.includes('43%'))
    assert.ok(downloading.tooltip?.includes('43%'))
  })

  it('turns a downloaded update into a restart action', () => {
    const downloaded = getTrayUpdatePresentation({ ...defaultUpdateState, status: 'downloaded', version: '1.3.0' })
    assert.equal(downloaded.action, 'restart')
    assert.equal(downloaded.enabled, true)
    assert.ok(downloaded.label.includes('1.3.0'))
  })

  it('disables network update actions offline but still permits an already downloaded install', () => {
    const offline = getTrayUpdatePresentation(defaultUpdateState, 'en', true)
    assert.equal(offline.action, 'none')
    assert.equal(offline.enabled, false)
    assert.equal(
      getTrayUpdatePresentation({ ...defaultUpdateState, status: 'downloaded' }, 'en', true).action,
      'restart'
    )
  })

  it('offers the correct retry after check and download failures', () => {
    const checkError = getTrayUpdatePresentation({
      ...defaultUpdateState,
      status: 'error',
      errorStage: 'check',
    })
    const downloadError = getTrayUpdatePresentation({
      ...defaultUpdateState,
      status: 'error',
      version: '1.3.0',
      errorStage: 'download',
    })

    assert.equal(checkError.action, 'check')
    assert.equal(downloadError.action, 'download')
  })
})
