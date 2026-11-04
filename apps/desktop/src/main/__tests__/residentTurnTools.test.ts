import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { WikiPage, WikiSpace } from '@remember/shared'
import { EvidenceStore } from '../dailyReview/evidenceStore'
import { createResidentMemoryTool } from '../residentAgentMemoryTool'
import { ResidentAgentStore } from '../residentAgentStore'
import { createResidentArchiveSession } from '../residentArchiveSession'
import { createResidentDataTool } from '../residentDataTool'
import { createResidentTaskTool } from '../residentTaskTool'
import { createResidentTurnTools } from '../residentTurnTools'
import { DEFAULT_SETTINGS } from '../settingsStore'

const context = { threadId: 'thread', turnId: 'turn', callId: 'call', signal: new AbortController().signal }
for (const concurrent of [false, true]) {
  test(`canonical Task projection and turn ledger ${concurrent ? 'reject an unrelated concurrent edit' : 'confirm a reviewed completion'}`, async (t) => {
    const directory = mkdtempSync('/private/tmp/remember-turn-tools-')
    const evidence = new EvidenceStore(join(directory, 'evidence.sqlite'))
    const store = new ResidentAgentStore(join(directory, 'chat.sqlite'))
    t.after(() => {
      evidence.close()
      store.close()
      rmSync(directory, { recursive: true, force: true })
    })
    const item = evidence.createWorkItem('Controleer publicatie', 'Bewaar de bestaande beschrijving.')
    const other = evidence.createWorkItem('Andere taak', 'Ongewijzigd')
    const turn = store.start('Vink de publicatietaak af.', 'codex')
    const session = createResidentArchiveSession({
      run: async () => {
        throw new Error('no archive lookup needed')
      },
      assertCurrent() {},
      instruction: 'Vink de publicatietaak af.',
      locale: 'nl',
      recovery: false,
    })
    const data = createResidentDataTool({
      asOf: Date.now(),
      store: evidence,
      settings: () => DEFAULT_SETTINGS,
      notes: () => ({ state: 'available', epoch: 'qa', sequence: 0, notes: [], tombstones: {} }),
      daySummaryPermitted: () => false,
      assertCurrent() {},
    })
    const task = createResidentTaskTool({
      messageId: turn.id,
      store,
      evidence,
      permitted: () => true,
      assertAvailable() {},
      ask: async () => {
        if (concurrent) evidence.updateWorkItem(other.id, 'Concurrerende wijziging', other.description)
        return { id: 'review', action: 'accept', values: {} }
      },
    })
    const tools = createResidentTurnTools({
      memory: () => ({ name: 'unused', description: '', inputSchema: {}, call: async () => null }),
      data,
      task,
      archive: session,
    })
    const dataTool = tools.find((tool) => tool.name === 'remember_data')
    const taskTool = tools.find((tool) => tool.name === 'remember_task')
    assert(dataTool && taskTool)
    await dataTool.call({ action: 'tasks' }, context)
    const read = (await taskTool.call({ action: 'read', taskId: item.id }, context)) as { task: { updatedAt: number } }
    const saved = (await taskTool.call(
      {
        action: 'update',
        taskId: item.id,
        expectedUpdatedAt: read.task.updatedAt,
        field: 'lifecycle',
        value: 'completed',
      },
      context
    )) as { saved: boolean }
    assert(saved.saved)
    assert.equal(evidence.getWorkItem(item.id)?.lifecycle, 'completed')
    const reply = await session.finalize('De publicatietaak is afgevinkt.', context.signal)
    if (concurrent) assert.match(reply, /niet betrouwbaar/)
    else assert.equal(reply, 'De publicatietaak is afgevinkt.')
  })
}

for (const concurrent of [false, true]) {
  test(`search then create a project and child ${concurrent ? 'detects an unrelated concurrent edit' : 'keeps the saved reply with a full search page'}`, async (t) => {
    const directory = mkdtempSync('/private/tmp/remember-create-turn-')
    const store = new ResidentAgentStore(join(directory, 'chat.sqlite'))
    t.after(() => {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    })
    const turn = store.start('Save a China project and practical preparation.', 'codex')
    const space: WikiSpace = {
      id: 'personal',
      name: 'Personal',
      description: '',
      icon: 'book',
      color: 'slate',
      maintenanceMode: 'auto',
    }
    let pages: WikiPage[] = Array.from({ length: 7 }, (_, index) => ({
      slug: `projects/china-${index}`,
      title: 'China',
      content: 'China preparation',
      excerpt: 'China preparation',
      revision: 'r1',
      sourceCount: 0,
      updatedAt: index,
    }))
    const session = createResidentArchiveSession({
      run: async () => {
        throw new Error('no archive lookup needed')
      },
      assertCurrent() {},
      instruction: 'Save a China project and practical preparation.',
      locale: 'en',
      recovery: false,
    })
    const memory = (searchLimit?: number) =>
      createResidentMemoryTool('Save a China project.', {
        messageId: turn.id,
        searchLimit,
        spaces: () => [space],
        store,
        read: async () => ({ state: 'fresh', checkedAt: Date.now(), pages }),
        pagePermitted: () => true,
        assertAvailable() {},
        ask: async () => {
          if (concurrent)
            pages = pages.map((page) => (page.slug === 'projects/china-6' ? { ...page, revision: 'other-edit' } : page))
          return { id: 'review', action: 'accept', values: {} }
        },
        wiki: {
          getSpaces: () => [space],
          listPages: async () => pages,
          createPage: async (input) => {
            const content = input.content ?? ''
            pages = [
              ...pages,
              {
                slug: `${input.parentSlug ?? input.category}/${input.title.toLowerCase().replaceAll(' ', '-')}`,
                title: input.title,
                content,
                excerpt: content,
                revision: 'created',
                sourceCount: 0,
                updatedAt: 100 + pages.length,
              },
            ]
            return pages
          },
          savePage: async () => {
            throw new Error('unexpected save')
          },
          deletePage: async () => {
            throw new Error('unexpected delete')
          },
          proposePage: async () => {
            throw new Error('unexpected proposal')
          },
        },
      })
    const unused = { name: 'unused', description: '', inputSchema: {}, call: async () => null }
    const tool = createResidentTurnTools({ memory, data: unused, task: unused, archive: session })[0]
    const call = (input: unknown, callId: string) => tool.call(input, { ...context, callId })
    await call({ action: 'spaces' }, 'spaces')
    const found = (await call({ action: 'search', spaceId: 'personal', query: 'China' }, 'search')) as {
      pages: WikiPage[]
    }
    assert.equal(found.pages.length, 6)
    for (const [title, parentSlug] of [
      ['China', undefined],
      ['China preparation', 'projects/china'],
    ] as const) {
      const result = (await call(
        {
          action: 'create',
          spaceId: 'personal',
          title,
          category: 'projects',
          parentSlug,
          content: 'China preparation',
        },
        title
      )) as { saved: boolean }
      assert(result.saved)
    }
    assert.equal(store.get(turn.id)?.results?.length, 2)
    const reply = 'Saved the China project and preparation document.'
    const finalized = await session.finalize(reply, context.signal)
    if (concurrent) assert.match(finalized, /could not reliably/)
    else assert.equal(finalized, reply)
  })
}
