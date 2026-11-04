import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FALLBACK_CODEX_MODELS } from '@remember/shared'
import { createCodexModelCatalog, fetchCodexModels, parseCodexModels } from '../codexModelCatalog'
import { createCachedSettingsStore } from '../settingsStore'

const model = {
  model: 'gpt-future',
  displayName: 'GPT Future',
  supportedReasoningEfforts: [{ reasoningEffort: 'minimal' }, { reasoningEffort: 'ultra' }],
  defaultReasoningEffort: 'minimal',
}

test('discovers new models and effort values across pages, excluding hidden and invalid entries', async () => {
  const requests: object[] = []
  const models = await fetchCodexModels(async (method, params) => {
    assert.equal(method, 'model/list')
    requests.push(params)
    return requests.length === 1
      ? { data: [model, { ...model, model: 'hidden', hidden: true }, { model: 'broken' }], nextCursor: 'page2' }
      : { data: [{ ...model, model: 'gpt-next' }], nextCursor: null }
  })
  assert.deepEqual(
    models.map((entry) => entry.model),
    ['gpt-future', 'gpt-next']
  )
  assert.deepEqual(models[0].supportedReasoningEfforts, ['minimal', 'ultra'])
  assert.deepEqual(requests[1], { limit: 100, includeHidden: false, cursor: 'page2' })
  await assert.rejects(fetchCodexModels(async () => ({ data: [model], nextCursor: 'repeat' })))
  await assert.rejects(fetchCodexModels(async () => ({ data: [] })))
})

test('deduplicates refreshes, persists the catalog, and retains it after errors and offline reads', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'remember-models-'))
  try {
    const catalog = createCodexModelCatalog()
    const models = parseCodexModels([model])
    assert.deepEqual(await catalog.get(directory, null), FALLBACK_CODEX_MODELS)
    let calls = 0
    const fetch = async () => {
      calls++
      return models
    }
    await Promise.all([catalog.get(directory, fetch, 1000), catalog.get(directory, fetch, 1000)])
    assert.equal(calls, 1)
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'codex-models.json'), 'utf8')), models)
    await catalog.get(directory, fetch, 2000)
    assert.equal(calls, 1)
    assert.deepEqual(
      await catalog.get(
        directory,
        async () => {
          throw new Error('offline')
        },
        400000
      ),
      models
    )
    assert.deepEqual(await createCodexModelCatalog().get(directory, null), models)
    catalog.invalidate()
    await catalog.get(directory, fetch, 400001)
    assert.equal(calls, 2)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('new model selection and supported effort survive a fresh settings store and a lost catalog', () => {
  const directory = mkdtempSync(join(tmpdir(), 'remember-model-settings-'))
  try {
    writeFileSync(join(directory, 'codex-models.json'), JSON.stringify(parseCodexModels([model])))
    const store = createCachedSettingsStore()
    const selected = store.update(directory, { codexAnalysisModel: 'gpt-future', codexAnalysisEffort: 'high' }, 1000)
    assert.equal(selected.codexAnalysisModel, 'gpt-future')
    assert.equal(selected.codexAnalysisEffort, 'minimal')
    assert.equal(store.update(directory, { codexAnalysisEffort: 'ultra' }, 1001).codexAnalysisEffort, 'ultra')
    rmSync(join(directory, 'codex-models.json'))
    const restarted = createCachedSettingsStore().refresh(directory)
    assert.equal(restarted.settings.codexAnalysisModel, 'gpt-future')
    assert.equal(restarted.settings.codexAnalysisEffort, 'ultra')
    assert.equal(
      store.update(directory, { codexAnalysisModel: 'not-in-catalog' }, 1002).codexAnalysisModel,
      'gpt-future'
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
