import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createUpdateState, reduceUpdateState } from '../updaterState'

describe('updater state', () => {
  it('reports development and unconfigured builds without presenting an error', () => {
    const development = createUpdateState('1.2.3', 'development')
    const unconfigured = createUpdateState('1.2.3', 'unconfigured')

    assert.equal(development.status, 'unavailable')
    assert.equal(development.availability, 'development')
    assert.equal(unconfigured.status, 'unavailable')
    assert.equal(unconfigured.availability, 'unconfigured')
  })

  it('moves through checking, availability, progress, and downloaded states', () => {
    const initial = createUpdateState('1.2.3', 'supported')
    const checking = reduceUpdateState(initial, { type: 'check-started' })
    const available = reduceUpdateState(checking, { type: 'update-available', version: '1.3.0' })
    const downloading = reduceUpdateState(available, { type: 'download-started' })
    const progressing = reduceUpdateState(downloading, { type: 'download-progress', progress: 0.428 })
    const downloaded = reduceUpdateState(progressing, { type: 'update-downloaded', version: '1.3.0' })

    assert.equal(checking.status, 'checking')
    assert.equal(available.status, 'available')
    assert.equal(available.version, '1.3.0')
    assert.equal(downloading.downloadProgress, 0)
    assert.equal(progressing.downloadProgress, 0.428)
    assert.equal(downloaded.status, 'downloaded')
    assert.equal(downloaded.downloadProgress, 1)
    assert.equal(downloaded.revision, 5)
  })

  it('represents no update as a distinct successful result', () => {
    const checking = reduceUpdateState(createUpdateState('1.2.3', 'supported'), { type: 'check-started' })
    const current = reduceUpdateState(checking, { type: 'update-not-available' })

    assert.equal(current.status, 'up-to-date')
    assert.equal(current.currentVersion, '1.2.3')
    assert.equal(current.errorStage, null)
  })

  it('keeps the available version after a recoverable download failure', () => {
    const available = reduceUpdateState(createUpdateState('1.2.3', 'supported'), {
      type: 'update-available',
      version: '1.3.0',
    })
    const failed = reduceUpdateState(available, { type: 'failed', stage: 'download' })
    const retrying = reduceUpdateState(failed, { type: 'download-started' })

    assert.equal(failed.status, 'error')
    assert.equal(failed.errorStage, 'download')
    assert.equal(failed.version, '1.3.0')
    assert.equal(retrying.status, 'downloading')
    assert.equal(retrying.errorStage, null)
  })

  it('returns a cancelled download to the locally known available update', () => {
    const available = reduceUpdateState(createUpdateState('1.2.3', 'supported'), {
      type: 'update-available',
      version: '1.3.0',
    })
    const downloading = reduceUpdateState(available, { type: 'download-started' })
    const cancelled = reduceUpdateState(downloading, { type: 'cancelled' })

    assert.equal(cancelled.status, 'available')
    assert.equal(cancelled.version, '1.3.0')
    assert.equal(cancelled.downloadProgress, null)
    assert.equal(cancelled.errorStage, null)
  })

  it('clamps progress values from the updater', () => {
    const state = createUpdateState('1.2.3', 'supported')

    assert.equal(reduceUpdateState(state, { type: 'download-progress', progress: -1 }).downloadProgress, 0)
    assert.equal(reduceUpdateState(state, { type: 'download-progress', progress: 2 }).downloadProgress, 1)
  })
})
