import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type CodexModel, FALLBACK_CODEX_MODELS, isCodexEffort, isCodexModelId } from '@remember/shared'

const CACHE_FILE = 'codex-models.json'
const REFRESH_MS = 5 * 60_000
const memoryModels = new Map<string, CodexModel[]>()

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

export function parseCodexModels(value: unknown): CodexModel[] {
  if (!Array.isArray(value)) return []
  const models = new Map<string, CodexModel>()
  for (const entry of value) {
    const model = object(entry)
    if (model.hidden === true || !isCodexModelId(model.model)) continue
    if (!Array.isArray(model.supportedReasoningEfforts)) continue
    const efforts = [
      ...new Set(
        model.supportedReasoningEfforts
          .map((effort) => (typeof effort === 'string' ? effort : object(effort).reasoningEffort))
          .filter(isCodexEffort)
      ),
    ]
    if (!isCodexEffort(model.defaultReasoningEffort)) continue
    if (!efforts.includes(model.defaultReasoningEffort)) continue
    models.set(model.model, {
      model: model.model,
      displayName: typeof model.displayName === 'string' && model.displayName.trim() ? model.displayName : model.model,
      supportedReasoningEfforts: efforts,
      defaultReasoningEffort: model.defaultReasoningEffort,
    })
  }
  return [...models.values()]
}

export function readCachedCodexModels(directory: string): CodexModel[] {
  const memory = memoryModels.get(directory)
  if (memory) return memory
  try {
    const models = parseCodexModels(JSON.parse(readFileSync(join(directory, CACHE_FILE), 'utf8')))
    if (models.length) return models
  } catch {
    /* The first launch and unreadable cache use the bundled fallback. */
  }
  return FALLBACK_CODEX_MODELS
}

export async function fetchCodexModels(request: (method: string, params: object) => Promise<unknown>) {
  const models: CodexModel[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  do {
    const page = object(
      await request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) })
    )
    if (!Array.isArray(page.data)) throw new Error('codex-model-list-invalid')
    models.push(...parseCodexModels(page.data))
    cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined
    if (cursor && cursors.has(cursor)) throw new Error('codex-model-list-repeated-cursor')
    if (cursor) cursors.add(cursor)
    if (cursors.size > 100) throw new Error('codex-model-list-too-many-pages')
  } while (cursor)
  if (!models.length) throw new Error('codex-model-list-empty')
  return [...new Map(models.map((model) => [model.model, model])).values()]
}

export function createCodexModelCatalog() {
  let pending: Promise<CodexModel[]> | undefined
  let lastAttempt = 0
  let cachedDirectory: string | undefined
  return {
    async get(directory: string, fetch: (() => Promise<CodexModel[]>) | null, now = Date.now()): Promise<CodexModel[]> {
      if (cachedDirectory !== directory) {
        lastAttempt = 0
        cachedDirectory = directory
      }
      if (!fetch) return readCachedCodexModels(directory)
      if (pending) return pending
      if (lastAttempt && now - lastAttempt < REFRESH_MS) return readCachedCodexModels(directory)
      lastAttempt = now
      pending = (async () => {
        try {
          const models = await fetch()
          if (!models.length) throw new Error('codex-model-list-empty')
          memoryModels.set(directory, models)
          try {
            mkdirSync(directory, { recursive: true })
            const file = join(directory, CACHE_FILE)
            writeFileSync(`${file}.tmp`, JSON.stringify(models), { mode: 0o600 })
            renameSync(`${file}.tmp`, file)
          } catch {
            /* A cache write failure must not discard the fetched catalog. */
          }
          return models
        } catch {
          return readCachedCodexModels(directory)
        } finally {
          pending = undefined
        }
      })()
      return pending
    },
    invalidate() {
      lastAttempt = 0
    },
  }
}

export const codexModelCatalog = createCodexModelCatalog()
