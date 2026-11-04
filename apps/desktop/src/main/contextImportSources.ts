import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { AgentProject, AgentProvider, ContextImportPreview } from '@remember/shared'
import { activityContentHash, parseAgentActivityRecord } from './agentActivitySources'

const RECENT_SESSION_DAYS = 30
const MAX_SESSIONS_PER_PROVIDER = 8
const MAX_SESSION_CANDIDATES = 32
const MAX_PROJECT_MEMORIES = 12
const MAX_PROJECT_INSTRUCTIONS = 6
const MAX_DOCUMENT_CHARACTERS = 20_000
const MAX_SESSION_CHARACTERS = 12_000
const MAX_TOTAL_CHARACTERS = 120_000
const MAX_SESSION_FILE_BYTES = 2.5 * 1024 * 1024
const SESSION_FILE_HEAD_BYTES = 256 * 1024

export type AgentContextMessage = {
  content: string
  observedAt: number | null
  role?: 'user' | 'assistant'
  eventId?: string
  partIndex?: number
  partCount?: number
}

export type AgentContextDocument = {
  provider: AgentProvider
  kind: 'instructions' | 'memory' | 'session'
  sourceId: string
  project: string
  updatedAt: number
  content: string
  wikiProject?: { spaceId: string; projectSlug: string }
  workingDirectory?: string | null
  messages?: AgentContextMessage[]
  // Earlier original messages clarify the conversation's scope; they are not fresh learning evidence.
  contextMessages?: AgentContextMessage[]
}

export type AgentContextDiscovery = {
  preview: ContextImportPreview
  documents: AgentContextDocument[]
}

type SessionDocument = AgentContextDocument & { workingDirectory: string | null }

export function discoverAgentContextAt(homeDirectory: string, now = Date.now()): AgentContextDiscovery {
  const codexDocuments = codexContextDocuments(homeDirectory, now)
  const claudeDocuments = claudeContextDocuments(homeDirectory, now)
  const documents = withinCharacterBudget([...codexDocuments, ...claudeDocuments])
  return {
    preview: {
      providers: (['codex', 'claude'] as const).map((provider) => providerSummary(provider, documents)),
    },
    documents,
  }
}

export async function discoverAgentProjectsAt(homeDirectory: string, now = Date.now()): Promise<AgentProject[]> {
  const sources = [
    { provider: 'codex' as const, directory: path.join(homeDirectory, '.codex', 'sessions') },
    { provider: 'claude' as const, directory: path.join(homeDirectory, '.claude', 'projects') },
  ]
  const projects = new Map<string, AgentProject>()
  for (const source of sources) {
    const sessions = await recentProjectSessions(source.directory, source.provider, now)
    for (const session of sessions) {
      const directory = await sessionProjectDirectory(session.filePath, source.provider)
      if (!directory) continue
      const current = projects.get(directory)
      const providers = current?.providers.includes(source.provider)
        ? current.providers
        : [...(current?.providers ?? []), source.provider]
      projects.set(directory, {
        id: directory,
        name: path.basename(directory),
        path: directory,
        providers,
        lastUsedAt: Math.max(current?.lastUsedAt ?? 0, session.updatedAt),
      })
    }
  }
  return [...projects.values()].sort(
    (left, right) => (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0) || left.name.localeCompare(right.name)
  )
}

async function recentProjectSessions(directory: string, provider: AgentProvider, now: number) {
  const cutoff = now - RECENT_SESSION_DAYS * 24 * 60 * 60_000
  const files = await listProjectSessionFiles(directory)
  const sessionFiles = files.filter(
    (filePath) =>
      filePath.endsWith('.jsonl') &&
      (provider === 'codex' || /^[0-9a-f]{8}-[0-9a-f-]{27}\.jsonl$/i.test(path.basename(filePath)))
  )
  const candidates: Array<{ filePath: string; updatedAt: number }> = []
  for (let index = 0; index < sessionFiles.length; index += 64) {
    const batch = await Promise.all(
      sessionFiles.slice(index, index + 64).map(async (filePath) => {
        const metadata = await stat(filePath).catch(() => null)
        return metadata && metadata.mtimeMs >= cutoff ? { filePath, updatedAt: metadata.mtimeMs } : null
      })
    )
    for (const entry of batch) if (entry) candidates.push(entry)
  }
  return candidates.sort((first, second) => second.updatedAt - first.updatedAt).slice(0, MAX_SESSION_CANDIDATES)
}

async function listProjectSessionFiles(directory: string, remainingDepth = 5): Promise<string[]> {
  if (remainingDepth < 0) return []
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const files = await Promise.all(
    entries.map((entry) => {
      const target = path.join(directory, entry.name)
      if (entry.isFile()) return [target]
      return entry.isDirectory() ? listProjectSessionFiles(target, remainingDepth - 1) : []
    })
  )
  return files.flat()
}

async function sessionProjectDirectory(filePath: string, provider: AgentProvider) {
  try {
    const file = await open(filePath, 'r')
    let content: string
    try {
      const { size } = await file.stat()
      if (size <= MAX_SESSION_FILE_BYTES) content = await file.readFile('utf8')
      else {
        const head = Buffer.alloc(SESSION_FILE_HEAD_BYTES)
        const tail = Buffer.alloc(MAX_SESSION_FILE_BYTES - SESSION_FILE_HEAD_BYTES)
        const { bytesRead: headBytes } = await file.read(head, 0, head.length, 0)
        const { bytesRead: tailBytes } = await file.read(tail, 0, tail.length, Math.max(headBytes, size - tail.length))
        const headText = head.toString('utf8', 0, headBytes)
        const tailText = tail.toString('utf8', 0, tailBytes)
        content = `${headText.slice(0, headText.lastIndexOf('\n') + 1)}${tailText.slice(Math.max(0, tailText.indexOf('\n') + 1))}`
      }
    } finally {
      await file.close()
    }
    // Project menus need directory metadata, not transcript extraction and hashing.
    let directory: string | null = null
    for (const line of content.split('\n')) {
      if (!line.includes('"cwd"')) continue
      try {
        const record = JSON.parse(line) as unknown
        if (!isRecord(record)) continue
        const metadata =
          provider === 'codex'
            ? record.type === 'session_meta' || record.type === 'turn_context'
              ? record.payload
              : null
            : record
        if (isRecord(metadata) && typeof metadata.cwd === 'string') directory = metadata.cwd
      } catch {
        // Ignore partial records while the agent is writing its session.
      }
    }
    if (!directory || !path.isAbsolute(directory)) return null
    const resolved = await realpath(directory)
    return (await stat(resolved)).isDirectory() ? resolved : null
  } catch {
    return null
  }
}

function codexContextDocuments(homeDirectory: string, now: number) {
  const codexDirectory = path.join(homeDirectory, '.codex')
  const memorySummaryPath = path.join(codexDirectory, 'memories', 'memory_summary.md')
  const memoryPath = existsSync(memorySummaryPath)
    ? memorySummaryPath
    : path.join(codexDirectory, 'memories', 'MEMORY.md')
  const documents = [
    textDocument('codex', 'memory', memoryPath, 'All projects', MAX_DOCUMENT_CHARACTERS),
    textDocument('codex', 'instructions', path.join(codexDirectory, 'AGENTS.md'), 'Working preferences'),
  ].filter((document): document is AgentContextDocument => document !== null)
  const sessions = selectDiverseSessions(
    recentSessionFiles(path.join(codexDirectory, 'sessions'), now)
      .slice(0, MAX_SESSION_CANDIDATES)
      .map(codexSessionDocument)
      .filter((document): document is SessionDocument => document !== null)
  )
  return [...documents, ...projectInstructionDocuments('codex', homeDirectory, sessions), ...sessions]
}

function claudeContextDocuments(homeDirectory: string, now: number) {
  const claudeDirectory = path.join(homeDirectory, '.claude')
  const projectDirectory = path.join(claudeDirectory, 'projects')
  const sessions = selectDiverseSessions(
    recentSessionFiles(projectDirectory, now, (filePath) =>
      /^[0-9a-f]{8}-[0-9a-f-]{27}\.jsonl$/i.test(path.basename(filePath))
    )
      .slice(0, MAX_SESSION_CANDIDATES)
      .map(claudeSessionDocument)
      .filter((document): document is SessionDocument => document !== null)
  )
  const memoryDocuments = listFiles(projectDirectory, 3)
    .filter((filePath) => filePath.endsWith(`${path.sep}memory${path.sep}MEMORY.md`))
    .map((filePath) => ({ filePath, updatedAt: fileModifiedAt(filePath) }))
    .filter((entry): entry is { filePath: string; updatedAt: number } => entry.updatedAt !== null)
    .sort((first, second) => second.updatedAt - first.updatedAt)
    .slice(0, MAX_PROJECT_MEMORIES)
    .map(({ filePath }) =>
      textDocument(
        'claude',
        'memory',
        filePath,
        claudeProjectName(path.dirname(path.dirname(filePath)), sessions),
        MAX_DOCUMENT_CHARACTERS
      )
    )
    .filter((document): document is AgentContextDocument => document !== null)
  const documents = [
    textDocument('claude', 'instructions', path.join(claudeDirectory, 'CLAUDE.md'), 'Working preferences'),
    ...memoryDocuments,
  ].filter((document): document is AgentContextDocument => document !== null)
  return [...documents, ...projectInstructionDocuments('claude', homeDirectory, sessions), ...sessions]
}

function projectInstructionDocuments(provider: AgentProvider, homeDirectory: string, sessions: SessionDocument[]) {
  const filenames = provider === 'codex' ? ['AGENTS.md'] : ['CLAUDE.md', 'AGENTS.md']
  const seen = new Set<string>()
  const documents: AgentContextDocument[] = []
  for (const session of sessions) {
    const workingDirectory = session.workingDirectory
    if (!workingDirectory || !isInsideHome(workingDirectory, homeDirectory)) continue
    for (const filename of filenames) {
      const filePath = path.join(workingDirectory, filename)
      if (seen.has(filePath)) continue
      seen.add(filePath)
      const document = textDocument(provider, 'instructions', filePath, session.project)
      if (document) documents.push(document)
      if (documents.length >= MAX_PROJECT_INSTRUCTIONS) return documents
    }
  }
  return documents
}

function codexSessionDocument(filePath: string): SessionDocument | null {
  return providerSessionDocument('codex', filePath)
}

function claudeSessionDocument(filePath: string): SessionDocument | null {
  return providerSessionDocument('claude', filePath)
}

function providerSessionDocument(provider: AgentProvider, filePath: string) {
  const cursor = {
    sessionId: path.basename(filePath, '.jsonl'),
    projectPath: null as string | null,
    turnId: null as string | null,
  }
  const seen: Array<{ role: string; hash: string; at: number | null; representation: string }> = []
  const messages = readJsonLines(filePath).flatMap((record) => {
    const observedAt = messageTimestamp(record.timestamp)
    // Bootstrap retains undated context, while incremental learning requires original timestamps.
    const parsed = parseAgentActivityRecord(provider, { ...record, timestamp: observedAt ?? 0 }, cursor)
    return parsed.messages.flatMap((message) => {
      const hash = activityContentHash(message.text)
      if (
        seen.some(
          (previous) =>
            previous.role === message.role &&
            previous.hash === hash &&
            previous.representation !== message.representation &&
            Math.abs((previous.at ?? 0) - (observedAt ?? 0)) <= 2_000
        )
      )
        return []
      seen.push({ role: message.role, hash, at: observedAt, representation: message.representation })
      return [{ role: message.role === 'user' ? 'User' : 'Agent', text: message.text, observedAt }]
    })
  })
  return sessionDocument(provider, filePath, cursor.projectPath, messages)
}

function sessionDocument(
  provider: AgentProvider,
  filePath: string,
  workingDirectory: string | null,
  messages: Array<{ role: string; text: string; observedAt: number | null }>
): SessionDocument | null {
  const selectedMessages = messages.length > 12 ? [messages[0], ...messages.slice(-11)] : messages
  const content = selectedMessages
    .map((message) => `[${message.role}]\n${cleanImportedText(message.text)}`)
    .filter((message) => message.length > 10)
    .join('\n\n')
    .slice(0, MAX_SESSION_CHARACTERS)
    .trim()
  const updatedAt = fileModifiedAt(filePath)
  if (!content || updatedAt === null) return null
  let remaining = MAX_SESSION_CHARACTERS
  const boundedMessages = selectedMessages
    .toReversed()
    .flatMap((message) => {
      const content = `[${message.role}]\n${cleanImportedText(message.text)}`
      if (content.length > remaining) return []
      remaining -= content.length
      return [{ content, observedAt: message.observedAt }]
    })
    .reverse()
  return {
    provider,
    kind: 'session',
    sourceId: path.basename(filePath, path.extname(filePath)),
    project: workingDirectory ? path.basename(workingDirectory) : 'Unknown project',
    updatedAt,
    content,
    messages: boundedMessages,
    workingDirectory,
  }
}

function textDocument(
  provider: AgentProvider,
  kind: 'instructions' | 'memory',
  filePath: string,
  project: string,
  maxCharacters = MAX_DOCUMENT_CHARACTERS
): AgentContextDocument | null {
  try {
    const content = readFileSync(filePath, 'utf8').slice(0, maxCharacters).trim()
    if (!content) return null
    return {
      provider,
      kind,
      sourceId: `${path.basename(filePath)}:${createHash('sha256').update(filePath).digest('hex').slice(0, 16)}`,
      project,
      updatedAt: statSync(filePath).mtimeMs,
      content,
    }
  } catch {
    return null
  }
}

function messageTimestamp(value: unknown) {
  const timestamp = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(timestamp) ? timestamp : null
}

function providerSummary(provider: AgentProvider, documents: AgentContextDocument[]) {
  const providerDocuments = documents.filter((document) => document.provider === provider)
  return {
    provider,
    available: providerDocuments.length > 0,
    projectCount: new Set(providerDocuments.map((document) => document.project).filter(isNamedProject)).size,
    sessionCount: providerDocuments.filter((document) => document.kind === 'session').length,
    memoryCount: providerDocuments.filter((document) => document.kind !== 'session').length,
    latestAt: providerDocuments.length ? Math.max(...providerDocuments.map((document) => document.updatedAt)) : null,
  }
}

function withinCharacterBudget(documents: AgentContextDocument[]) {
  const prioritized = [...documents].sort((first, second) => {
    const kindPriority = { instructions: 0, memory: 1, session: 2 }
    return kindPriority[first.kind] - kindPriority[second.kind] || second.updatedAt - first.updatedAt
  })
  let characters = 0
  return prioritized.filter((document) => {
    if (characters + document.content.length > MAX_TOTAL_CHARACTERS) return false
    characters += document.content.length
    return true
  })
}

function selectDiverseSessions(sessions: SessionDocument[]) {
  const selected: SessionDocument[] = []
  const projects = new Set<string>()
  for (const session of sessions) {
    if (projects.has(session.project)) continue
    projects.add(session.project)
    selected.push(session)
    if (selected.length >= MAX_SESSIONS_PER_PROVIDER) return selected
  }
  for (const session of sessions) {
    if (selected.includes(session)) continue
    selected.push(session)
    if (selected.length >= MAX_SESSIONS_PER_PROVIDER) break
  }
  return selected
}

function recentSessionFiles(directory: string, now: number, isCandidate: (filePath: string) => boolean = () => true) {
  const cutoff = now - RECENT_SESSION_DAYS * 24 * 60 * 60_000
  return listFiles(directory, 5)
    .filter((filePath) => filePath.endsWith('.jsonl'))
    .filter(isCandidate)
    .map((filePath) => ({ filePath, updatedAt: fileModifiedAt(filePath) }))
    .filter(
      (entry): entry is { filePath: string; updatedAt: number } => entry.updatedAt !== null && entry.updatedAt >= cutoff
    )
    .sort((first, second) => second.updatedAt - first.updatedAt)
    .map((entry) => entry.filePath)
}

function listFiles(directory: string, remainingDepth: number): string[] {
  if (remainingDepth < 0) return []
  try {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const target = path.join(directory, entry.name)
      if (entry.isFile()) return [target]
      return entry.isDirectory() ? listFiles(target, remainingDepth - 1) : []
    })
  } catch {
    return []
  }
}

function readJsonLines(filePath: string) {
  try {
    return readBoundedSessionFile(filePath)
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const value = JSON.parse(line) as unknown
          return isRecord(value) ? [value] : []
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

function readBoundedSessionFile(filePath: string) {
  const size = statSync(filePath).size
  if (size <= MAX_SESSION_FILE_BYTES) return readFileSync(filePath, 'utf8')

  const descriptor = openSync(filePath, 'r')
  try {
    const head = Buffer.alloc(SESSION_FILE_HEAD_BYTES)
    const tail = Buffer.alloc(MAX_SESSION_FILE_BYTES - SESSION_FILE_HEAD_BYTES)
    const headBytes = readSync(descriptor, head, 0, head.length, 0)
    const tailPosition = Math.max(headBytes, size - tail.length)
    const tailBytes = readSync(descriptor, tail, 0, tail.length, tailPosition)
    const headText = head.toString('utf8', 0, headBytes)
    const tailText = tail.toString('utf8', 0, tailBytes)
    return `${headText.slice(0, headText.lastIndexOf('\n') + 1)}${tailText.slice(Math.max(0, tailText.indexOf('\n') + 1))}`
  } finally {
    closeSync(descriptor)
  }
}

function claudeProjectName(projectDirectory: string, sessions: SessionDocument[]) {
  const encodedProject = path.basename(projectDirectory)
  const matchingSession = sessions.find(
    (session) => session.workingDirectory && encodedProject === session.workingDirectory.replaceAll(path.sep, '-')
  )
  if (matchingSession?.workingDirectory) {
    return matchingSession.project
  }
  return path.basename(projectDirectory).replace(/^-Users-[^-]+-(?:Developer-)?/, '') || 'Unknown project'
}

function cleanImportedText(value: string) {
  return value.replaceAll(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/g, '').trim()
}

function fileModifiedAt(filePath: string) {
  try {
    return statSync(filePath).mtimeMs
  } catch {
    return null
  }
}

function isInsideHome(directory: string, homeDirectory: string) {
  const relative = path.relative(homeDirectory, directory)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function isNamedProject(project: string) {
  return project !== 'All projects' && project !== 'Working preferences' && project !== 'Unknown project'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
