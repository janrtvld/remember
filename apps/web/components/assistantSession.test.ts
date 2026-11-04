import assert from 'node:assert/strict'
import { type TestContext, test } from 'node:test'
import {
  ASSISTANT_OUTBOX_LIMIT,
  type LocalAssistantSubmission,
  readAssistantSession,
  restoreAssistantSessionDraft,
  writeAssistantSession,
} from './assistantSession'

function setup(t: TestContext) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const values = new Map<string, string>()
  const browser = {
    sessionStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'window', original)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  return { browser, values }
}

function submission(index = 1): LocalAssistantSubmission {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    text: `Vraag ${index}`,
    provider: 'codex',
    createdAt: 1,
    queued: false,
    failed: false,
  }
}

test('reload preserves text, IDs, queue and optional mode but never treats pending sends as running', (t) => {
  setup(t)
  const first = submission()
  const queued = { ...submission(2), mode: 'command' as const, queued: true }
  assert.equal(writeAssistantSession({ draft: 'Nieuw concept\nmet tweede regel', submissions: [first, queued] }), true)
  const loaded = readAssistantSession()
  assert.deepEqual(loaded, {
    draft: 'Nieuw concept\nmet tweede regel',
    submissions: [
      { ...first, failed: true },
      { ...queued, failed: true },
    ],
  })
  assert(loaded?.submissions[0])
  assert.equal(Object.hasOwn(loaded.submissions[0], 'mode'), false)
})

test('capacity rejects the entire write and preserves the previous draft and all unresolved messages', (t) => {
  setup(t)
  const submissions = Array.from({ length: ASSISTANT_OUTBOX_LIMIT }, (_, index) => submission(index + 1))
  assert.equal(writeAssistantSession({ draft: 'Bewaren', submissions }), true)
  const before = readAssistantSession()
  assert.equal(writeAssistantSession({ draft: 'Nieuw', submissions: [...submissions, submission(11)] }), false)
  assert.deepEqual(readAssistantSession(), before)
  assert.equal(writeAssistantSession({ draft: 'x'.repeat(20_001), submissions }), false)
  assert.deepEqual(readAssistantSession(), before)
})

test('blocked storage and quota failure return honest failure without throwing', (t) => {
  const { browser } = setup(t)
  assert.equal(writeAssistantSession({ draft: 'Bewaard', submissions: [] }), true)
  browser.sessionStorage.setItem = () => {
    throw new Error('Quota exceeded')
  }
  assert.equal(writeAssistantSession({ draft: 'Nieuw', submissions: [] }), false)
  assert.equal(readAssistantSession()?.draft, 'Bewaard')
  Object.defineProperty(browser, 'sessionStorage', {
    get: () => {
      throw new Error('Blocked')
    },
  })
  assert.equal(readAssistantSession(), null)
  assert.equal(writeAssistantSession({ draft: 'Nieuw', submissions: [] }), false)
})

test('invalid or incompatible stored data is not loaded, erased or rewritten', (t) => {
  const { values } = setup(t)
  assert.equal(writeAssistantSession({ draft: 'Bewaard', submissions: [] }), true)
  const key = [...values.keys()][0]
  assert(key)
  for (const raw of [
    '{broken',
    JSON.stringify({ version: 2, draft: 'Future', submissions: [] }),
    JSON.stringify({ version: 1, draft: 'Text', submissions: [{ ...submission(), id: 'bad-id' }] }),
  ]) {
    values.set(key, raw)
    assert.equal(readAssistantSession(), null)
    assert.equal(values.get(key), raw)
  }
})

test('duplicate IDs cannot replace the stored outbox with ambiguous submissions', (t) => {
  setup(t)
  assert.equal(writeAssistantSession({ draft: 'Concept', submissions: [submission()] }), true)
  assert.equal(
    writeAssistantSession({ draft: '', submissions: [submission(), { ...submission(), text: 'Different' }] }),
    false
  )
  assert.equal(readAssistantSession()?.draft, 'Concept')
})

test('scoped drafts and a pending queue edit survive independently of the general draft', (t) => {
  const { values } = setup(t)
  const scopedDrafts = { 'task:one': 'Taakconcept', [`prompt:${'x'.repeat(20_000)}`]: 'Promptconcept' }
  const queueEdit = { id: submission().id, text: 'Bewerking onderweg' }
  assert.equal(writeAssistantSession({ draft: 'Algemeen', scopedDrafts, queueEdit, submissions: [] }), true)
  assert.deepEqual(readAssistantSession(), { draft: 'Algemeen', scopedDrafts, queueEdit, submissions: [] })
  assert.equal(writeAssistantSession({ draft: '', scopedDrafts, submissions: [] }), true)
  assert.deepEqual(readAssistantSession()?.scopedDrafts, scopedDrafts)
  assert.equal(writeAssistantSession({ draft: '', queueEdit, submissions: [] }), true)
  assert.deepEqual(readAssistantSession()?.queueEdit, queueEdit)
  assert.equal(values.size, 1)
  assert.equal(writeAssistantSession({ draft: '', submissions: [] }), true)
  assert.equal(values.size, 0)
})

test('invalid scoped drafts or queue edits do not overwrite recoverable text', (t) => {
  const { values } = setup(t)
  assert.equal(writeAssistantSession({ draft: 'Bewaren', submissions: [] }), true)
  const key = [...values.keys()][0]
  assert(key)
  const malformed = [
    { scopedDrafts: { 'task:one': 42 } },
    { scopedDrafts: { 'task:one': 'x'.repeat(20_001) } },
    { scopedDrafts: { ['x'.repeat(20_011)]: 'Concept' } },
    { scopedDrafts: { '': 'Concept' } },
    { scopedDrafts: JSON.parse('{"__proto__":"Concept"}') },
    { queueEdit: { id: 'not-a-uuid', text: 'Concept' } },
    { queueEdit: { id: submission().id, text: ' ' } },
    { queueEdit: { id: submission().id, text: 'x'.repeat(20_001) } },
  ]
  const original = values.get(key)
  for (const invalid of malformed) {
    const session = { draft: '', submissions: [], ...invalid }
    // Exercise runtime validation at the persisted-data boundary.
    assert.equal(writeAssistantSession(session as Parameters<typeof writeAssistantSession>[0]), false)
    assert.equal(values.get(key), original)
    const raw = JSON.stringify({ version: 1, ...session })
    values.set(key, raw)
    assert.equal(readAssistantSession(), null)
    assert.equal(values.get(key), raw)
    assert(original)
    values.set(key, original)
  }
})

test('local recovery unlocks a retired queue edit while preserving the existing and scoped drafts', (t) => {
  setup(t)
  const queueEdit = { id: submission().id, text: 'Old remote queue edit' }
  const original = {
    draft: 'Existing local draft',
    scopedDrafts: { 'task:one': 'Separate task draft' },
    queueEdit,
    submissions: [],
  }
  const recovered = restoreAssistantSessionDraft(original, queueEdit)
  assert.deepEqual(recovered, {
    session: {
      draft: 'Existing local draft\n\nOld remote queue edit',
      scopedDrafts: original.scopedDrafts,
      submissions: [],
    },
  })
  assert.equal(original.queueEdit, queueEdit)
  assert.equal(writeAssistantSession(recovered.session), true)
  assert.deepEqual(readAssistantSession(), recovered.session)
})

test('explicit recovery removes the old remote outbox descriptor without dispatching or changing other submissions', () => {
  const remote = { ...submission(), mode: 'command' as const, queued: true, failed: true }
  const other = { ...submission(2), provider: 'claude' as const, failed: true }
  const original = { draft: '', submissions: [remote, other] }
  const recovered = restoreAssistantSessionDraft(original, remote)
  assert.deepEqual(recovered.session, { draft: remote.text, submissions: [other] })
  assert.deepEqual(original.submissions, [remote, other])
  assert.equal(recovered.prompt, undefined)
})

test('two maximum-length drafts recover without truncation or overwriting an existing prompt scope', (t) => {
  setup(t)
  const queueEdit = { id: submission().id, text: 'r'.repeat(20_000) }
  const original = {
    draft: 'd'.repeat(20_000),
    scopedDrafts: { [`prompt:${queueEdit.id}`]: 'Existing prompt draft', 'task:one': 'Task draft' },
    queueEdit,
    submissions: [],
  }
  const recovered = restoreAssistantSessionDraft(original, queueEdit)
  assert.equal(recovered.session.draft, original.draft)
  assert.equal(recovered.prompt, `${queueEdit.id}-1`)
  assert.equal(recovered.session.scopedDrafts?.[`prompt:${recovered.prompt}`], queueEdit.text)
  assert.equal(recovered.session.scopedDrafts?.[`prompt:${queueEdit.id}`], 'Existing prompt draft')
  assert.equal(recovered.session.scopedDrafts?.['task:one'], 'Task draft')
  assert.equal(recovered.session.queueEdit, undefined)
  assert.equal(writeAssistantSession(recovered.session), true)
  assert.deepEqual(readAssistantSession(), recovered.session)
})
