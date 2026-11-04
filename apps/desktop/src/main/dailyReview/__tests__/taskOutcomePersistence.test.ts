import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseDayMemory } from '../analysisFormat'
import { EvidenceStore } from '../evidenceStore'

test('refines a generated substep into its outcome without changing identity, survives restart, and protects user edits', () => {
  const directory = mkdtempSync(join(tmpdir(), 'remember-task-outcome-'))
  const database = join(directory, 'evidence.sqlite')
  let store = new EvidenceStore(database)
  try {
    const day = 'outcome-day'
    store.upsertSession({
      id: day,
      startedAt: 1000,
      endedAt: null,
      activeDurationMs: 0,
      moments: [],
      appActivity: [],
      contextMoments: [],
      memory: null,
      refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
    })
    store.appendContextMoment(
      day,
      {
        id: 'source',
        timestamp: 1100,
        appName: 'Notes',
        windowTitle: 'Application',
        text: 'My application still needs the video and references.',
        textSource: 'accessibility',
        trigger: 'window-change',
        monitorName: 'Test',
        screenshotPath: '',
      },
      null,
      'test.notes'
    )
    const source = {
      kind: 'task' as const,
      evidenceId: 'source',
      label: 'Application',
      detail: 'Personal application commitment.',
    }
    const apply = (id: string | undefined, title: string, description: string, at: number) =>
      store.applyAnalyzedWorkItems({
        workdayId: day,
        conversations: [],
        analysisStartedAt: at,
        observedAt: at + 1,
        plan: {
          proposed:
            parseDayMemory(
              JSON.stringify({
                summary: '',
                openTasks: [{ id, title, description, source, titleChangeReason: id ? 'outcome' : null }],
              })
            ).openTasks ?? [],
          changes: [],
        },
      })
    apply(undefined, 'Record application video', 'Record the application video.', 1200)
    const [initial] = store.listWorkItems()
    assert.ok(initial)
    assert.equal(initial.userEditedTitle, false)
    const description = 'Complete the application.\n- Record the video.\n- Ask the references.'
    assert.deepEqual(apply(initial.id, 'Complete Bridge application', description, 1300), {
      created: 0,
      updated: 1,
      closed: 0,
    })
    assert.equal(store.listWorkItems().length, 1)
    assert.equal(store.getWorkItem(initial.id)?.title, 'Complete Bridge application')
    assert.equal(store.getWorkItem(initial.id)?.description, description)
    store.close()
    store = new EvidenceStore(database)
    assert.equal(store.getWorkItem(initial.id)?.description, description)
    assert.equal(store.getWorkItem(initial.id)?.lifecycle, 'open')

    const edited = store.updateWorkItem(initial.id, 'My next chapter', 'My own remaining steps')
    apply(initial.id, 'Model replacement title', 'Model replacement steps', edited.updatedAt + 10)
    assert.equal(store.getWorkItem(initial.id)?.title, 'My next chapter')
    assert.equal(store.getWorkItem(initial.id)?.description, 'My own remaining steps')
    assert.equal(store.listWorkItems().length, 1)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
