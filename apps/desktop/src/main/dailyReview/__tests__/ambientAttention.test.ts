import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { createAmbientTaskWorker } from '../ambientTaskWorker'
import { EvidenceStore } from '../evidenceStore'

test('one work moment shares its attention budget between chat and native notifications across restart', () => {
  for (const firstChannel of ['chat', 'native'] as const) {
    const directory = mkdtempSync(join(tmpdir(), 'remember-attention-'))
    const file = join(directory, 'evidence.sqlite')
    let store = new EvidenceStore(file)
    const now = Date.now()
    try {
      const tasks = ['Overzicht naar Noor', 'Testuitslag naar Eva', 'Belmoment met Tom'].map((title, index) => {
        const item = store.createWorkItem(title, title)
        store.ambientTasks.enqueueNotification(item.id, now + index)
        return item
      })
      const first = tasks[0]
      const second = tasks[1]
      assert(first && second)
      if (firstChannel === 'chat') {
        assert.equal(store.ambientTasks.nextSuggestion(now), first.id)
        store.ambientTasks.acknowledgeSuggestion(first.id, now)
      } else {
        assert.equal(store.ambientTasks.takeNotification(now), first.id)
      }

      store.close()
      store = new EvidenceStore(file)
      // The other surface may reflect the same event, never a second task's interruption.
      if (firstChannel === 'chat') {
        assert.equal(store.ambientTasks.takeNotification(now + 1_000), first.id)
      } else {
        assert.equal(store.ambientTasks.nextSuggestion(now + 1_000), first.id)
        store.ambientTasks.acknowledgeSuggestion(first.id, now + 1_000)
      }
      assert.equal(store.ambientTasks.nextSuggestion(now + 2_000), null)
      assert.equal(store.ambientTasks.takeNotification(now + 2_000), null)
      assert.equal(store.ambientTasks.nextSuggestion(now + 60_999), null)
      assert.equal(store.ambientTasks.nextSuggestion(now + 61_000), second.id)
      assert.equal(store.listWorkItems().length, 3, 'Throttling attention must not discard commitments')
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
})

test('completed and expired offers never become fresh interruptions after the shared cooldown', () => {
  const directory = mkdtempSync(join(tmpdir(), 'remember-attention-'))
  const store = new EvidenceStore(join(directory, 'evidence.sqlite'))
  const now = Date.now()
  try {
    const completed = store.createWorkItem('Al gedaan', 'Al gedaan')
    const expired = store.createWorkItem('Oude aanleiding', 'Oude aanleiding')
    store.ambientTasks.enqueueNotification(completed.id, now)
    store.ambientTasks.enqueueNotification(expired.id, now - 31 * 60_000)
    store.setWorkItemLifecycle(completed.id, 'completed')
    assert.equal(store.ambientTasks.nextSuggestion(now), null)
    assert.equal(store.ambientTasks.takeNotification(now), null)
    assert.equal(store.listWorkItems().length, 2)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('an existing attention outbox gains suppression support without losing its prior attention budget', () => {
  const directory = mkdtempSync(join(tmpdir(), 'remember-attention-migration-'))
  const file = join(directory, 'evidence.sqlite')
  let store = new EvidenceStore(file)
  const now = Date.now()
  try {
    const first = store.createWorkItem('Eerste taak', 'Eerste taak')
    const second = store.createWorkItem('Tweede taak', 'Tweede taak')
    store.ambientTasks.enqueueNotification(first.id, now)
    store.ambientTasks.enqueueNotification(second.id, now + 1)
    store.ambientTasks.acknowledgeSuggestion(first.id, now)
    store.ambientTasks.takeNotification(now)
    store.close()
    const previousSchema = new DatabaseSync(file)
    previousSchema.exec('ALTER TABLE ambient_task_notification DROP COLUMN suppressed_at')
    previousSchema.close()

    store = new EvidenceStore(file)
    assert.equal(store.listWorkItems().length, 2)
    assert.equal(store.ambientTasks.nextSuggestion(now + 1_000), null)
    assert.equal(store.ambientTasks.nextSuggestion(now + 60_000), second.id)
    store.ambientTasks.suppressAttention(second.id, now + 60_000)
    store.close()
    store = new EvidenceStore(file)
    assert.equal(store.ambientTasks.nextSuggestion(now + 61_000), null)
    assert.equal(store.ambientTasks.takeNotification(now + 61_000), null)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('discarding revoked sources is durable and does not consume another task’s attention budget', async () => {
  for (const chatAvailable of [true, false]) {
    const directory = mkdtempSync(join(tmpdir(), 'remember-attention-'))
    const file = join(directory, 'evidence.sqlite')
    let store = new EvidenceStore(file)
    const start = Date.now()
    let now = start
    const emitted: string[] = []
    const worker = (allowRevoked: boolean) =>
      createAmbientTaskWorker({
        store: store.ambientTasks,
        policy: () => 'enabled',
        allowed: () => true,
        accept: (source) => allowRevoked || source.sourceId !== 'revoked',
        items: () => store.listWorkItems(),
        now: () => now,
        analyze: async () => assert.fail('No new analysis expected'),
        apply: () => assert.fail('Already committed'),
        changed: () => {},
        notificationsSupported: () => true,
        notify: (item) => {
          emitted.push(`native:${item.title}`)
        },
        ...(chatAvailable
          ? {
              suggest: (item: { title: string }) => {
                emitted.push(`chat:${item.title}`)
                return true
              },
            }
          : {}),
        error: (error) => assert.fail(String(error)),
      })
    try {
      store.upsertSession({
        id: 'day',
        startedAt: start - 60_000,
        endedAt: null,
        activeDurationMs: 0,
        moments: [],
        contextMoments: [],
        appActivity: [],
        memory: null,
        refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
      })
      for (const [index, id] of ['revoked', 'permitted'].entries()) {
        const text = `Jan, stuur de ${id} versie.`
        store.appendContextMoment(
          'day',
          {
            id,
            timestamp: start - 2_000 + index,
            text,
            appName: 'QA',
            windowTitle: id,
            textSource: 'accessibility',
            trigger: 'content-change',
            monitorName: '',
            screenshotPath: '',
          },
          null
        )
        const source = store.ambientTasks.resolveSource(id)
        assert(source)
        const item = store.createWorkItem(id, text)
        store.ambientTasks.recordTaskSource(item.id, `source-${id}`, source)
        store.ambientTasks.enqueueNotification(item.id, source.observedAt)
        store.ambientTasks.acknowledge([source], start)
      }
      const first = worker(false)
      await first.tick()
      now += 1_000
      await first.tick()
      await first.stop()
      assert.deepEqual(emitted.sort(), chatAvailable ? ['chat:permitted', 'native:permitted'] : ['native:permitted'])
      store.close()
      store = new EvidenceStore(file)
      const count = emitted.length
      now += 61_000
      const restarted = worker(true)
      await restarted.tick()
      await restarted.stop()
      assert.equal(emitted.length, count, 'A discarded source must not reappear after privacy changes or restart')
      assert.equal(store.listWorkItems().length, 2)
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
})

test('an offer expiring during validation never consumes another offer without attempting it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'remember-attention-expiry-'))
  const file = join(directory, 'evidence.sqlite')
  let store = new EvidenceStore(file)
  const start = Date.now()
  let now = start
  const attempts: string[] = []
  const worker = () =>
    createAmbientTaskWorker({
      store: store.ambientTasks,
      policy: () => 'enabled',
      allowed: () => true,
      accept: () => {
        now = start + 2
        return true
      },
      items: () => store.listWorkItems(),
      now: () => now,
      analyze: async () => assert.fail('No new analysis expected'),
      apply: () => assert.fail('Already committed'),
      changed: () => {},
      notificationsSupported: () => true,
      notify: (item) => attempts.push(item.title),
      error: (error) => assert.fail(String(error)),
    })
  try {
    store.upsertSession({
      id: 'day',
      startedAt: start - 31 * 60_000,
      endedAt: null,
      activeDurationMs: 0,
      moments: [],
      contextMoments: [],
      appActivity: [],
      memory: null,
      refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
    })
    let permittedId = ''
    for (const [index, id] of ['expires', 'permitted'].entries()) {
      const observedAt = index === 0 ? start - 30 * 60_000 + 1 : start - 100
      const text = `Jan, stuur de ${id} versie.`
      store.appendContextMoment(
        'day',
        {
          id,
          timestamp: observedAt,
          text,
          appName: 'QA',
          windowTitle: id,
          textSource: 'accessibility',
          trigger: 'content-change',
          monitorName: '',
          screenshotPath: '',
        },
        null
      )
      const source = store.ambientTasks.resolveSource(id)
      assert(source)
      const item = store.createWorkItem(id, text)
      if (id === 'permitted') permittedId = item.id
      store.ambientTasks.recordTaskSource(item.id, `source-${id}`, source)
      store.ambientTasks.enqueueNotification(item.id, observedAt)
      store.ambientTasks.acknowledge([source], start)
    }
    const first = worker()
    await first.tick()
    await first.stop()
    assert.deepEqual(attempts, [])
    assert.equal(store.ambientTasks.nextNotification(now), permittedId)

    store.close()
    store = new EvidenceStore(file)
    assert.equal(store.ambientTasks.nextNotification(now), permittedId)
    const restarted = worker()
    await restarted.tick()
    await restarted.stop()
    assert.deepEqual(attempts, ['permitted'])
    assert.equal(store.ambientTasks.nextNotification(now), null)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
