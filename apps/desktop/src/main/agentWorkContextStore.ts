import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { AgentProject, AgentProvider, WorkItemAgentContext } from '@remember/shared'

type StoredWorkItemAgentContext = {
  project: AgentProject | null
  threads: Partial<Record<AgentProvider, string>>
}

type AgentWorkContextFile = {
  version: 1
  items: Record<string, StoredWorkItemAgentContext>
}

const EMPTY_FILE: AgentWorkContextFile = { version: 1, items: {} }

function storePath(userDataDirectory: string) {
  return path.join(userDataDirectory, 'inbox-agent-context.json')
}

function validItemId(itemId: string) {
  const normalized = itemId.trim()
  if (!normalized || normalized.length > 200) throw new Error('invalid-work-item-id')
  return normalized
}

function canonicalProject(project: AgentProject): AgentProject {
  if (!path.isAbsolute(project.path)) throw new Error('invalid-agent-project')
  const directory = realpathSync(project.path)
  if (!statSync(directory).isDirectory()) throw new Error('invalid-agent-project')
  return {
    id: directory,
    name: path.basename(directory),
    path: directory,
    providers: project.providers.filter(
      (provider, index, providers): provider is AgentProvider =>
        (provider === 'codex' || provider === 'claude') && providers.indexOf(provider) === index
    ),
    lastUsedAt:
      typeof project.lastUsedAt === 'number' && Number.isFinite(project.lastUsedAt) ? project.lastUsedAt : null,
  }
}

function readStore(userDataDirectory: string): AgentWorkContextFile {
  try {
    const parsed = JSON.parse(readFileSync(storePath(userDataDirectory), 'utf8')) as AgentWorkContextFile
    if (parsed.version !== 1 || !parsed.items || typeof parsed.items !== 'object') return EMPTY_FILE
    return parsed
  } catch {
    return EMPTY_FILE
  }
}

function writeStore(userDataDirectory: string, store: AgentWorkContextFile) {
  mkdirSync(userDataDirectory, { recursive: true })
  const destination = storePath(userDataDirectory)
  const temporary = `${destination}.tmp`
  writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, destination)
}

export function getWorkItemAgentContextAt(userDataDirectory: string, itemId: string): WorkItemAgentContext {
  const stored = readStore(userDataDirectory).items[validItemId(itemId)]
  if (!stored?.project || !existsSync(stored.project.path)) return { project: null }
  try {
    return { project: canonicalProject(stored.project) }
  } catch {
    return { project: null }
  }
}

export function setWorkItemAgentProjectAt(
  userDataDirectory: string,
  itemId: string,
  project: AgentProject | null
): WorkItemAgentContext {
  const normalizedItemId = validItemId(itemId)
  const store = readStore(userDataDirectory)
  const current = store.items[normalizedItemId]
  const normalizedProject = project ? canonicalProject(project) : null
  const projectChanged = current?.project?.path !== normalizedProject?.path
  store.items[normalizedItemId] = {
    project: normalizedProject,
    threads: projectChanged ? {} : (current?.threads ?? {}),
  }
  writeStore(userDataDirectory, store)
  return { project: normalizedProject }
}

export function listStoredAgentProjectsAt(userDataDirectory: string) {
  const projects = new Map<string, AgentProject>()
  for (const item of Object.values(readStore(userDataDirectory).items)) {
    if (!item.project || projects.has(item.project.path)) continue
    try {
      const project = canonicalProject(item.project)
      projects.set(project.path, project)
    } catch {
      // A moved or deleted project disappears from the picker.
    }
  }
  return [...projects.values()]
}

export function getWorkItemAgentExecutionAt(userDataDirectory: string, itemId: string, provider: AgentProvider) {
  const stored = readStore(userDataDirectory).items[validItemId(itemId)]
  if (!stored?.project) {
    if (provider !== 'codex') return { workingDirectory: null, threadId: null }
    const workingDirectory = path.join(
      userDataDirectory,
      'agent-workspaces',
      createHash('sha256').update(validItemId(itemId)).digest('hex')
    )
    mkdirSync(workingDirectory, { recursive: true, mode: 0o700 })
    return { workingDirectory, threadId: stored?.threads?.codex ?? null }
  }
  try {
    const project = canonicalProject(stored.project)
    const threadId = stored.threads[provider]
    return {
      workingDirectory: project.path,
      threadId: typeof threadId === 'string' && threadId.trim() ? threadId : null,
    }
  } catch {
    throw new Error('agent-project-unavailable')
  }
}

export function setWorkItemAgentThreadAt(
  userDataDirectory: string,
  itemId: string,
  provider: AgentProvider,
  threadId: string
) {
  const normalizedItemId = validItemId(itemId)
  const normalizedThreadId = threadId.trim()
  if (!normalizedThreadId || normalizedThreadId.length > 200) throw new Error('invalid-agent-thread-id')
  const store = readStore(userDataDirectory)
  const current = store.items[normalizedItemId]
  if (!current?.project && provider !== 'codex') return
  store.items[normalizedItemId] = {
    project: current?.project ?? null,
    threads: { ...current?.threads, [provider]: normalizedThreadId },
  }
  writeStore(userDataDirectory, store)
}
