import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import {
  getWorkItemAgentContextAt,
  getWorkItemAgentExecutionAt,
  listStoredAgentProjectsAt,
  setWorkItemAgentProjectAt,
  setWorkItemAgentThreadAt,
} from '../agentWorkContextStore'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test('persists a project and provider thread per Inbox item', () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'remember-agent-context-'))
  directories.push(userData)
  const projectPath = path.join(userData, 'remember')
  mkdirSync(projectPath)
  const canonicalProjectPath = realpathSync(projectPath)
  const project = {
    id: canonicalProjectPath,
    name: 'remember',
    path: canonicalProjectPath,
    providers: ['codex' as const],
    lastUsedAt: 100,
  }

  assert.deepEqual(setWorkItemAgentProjectAt(userData, 'item-1', project), { project })
  setWorkItemAgentThreadAt(userData, 'item-1', 'codex', 'thread-1')

  assert.deepEqual(getWorkItemAgentContextAt(userData, 'item-1'), { project })
  assert.deepEqual(getWorkItemAgentExecutionAt(userData, 'item-1', 'codex'), {
    workingDirectory: canonicalProjectPath,
    threadId: 'thread-1',
  })
  assert.deepEqual(listStoredAgentProjectsAt(userData), [project])
})

test('changing the project clears the old resumable thread', () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'remember-agent-context-'))
  directories.push(userData)
  const firstPath = path.join(userData, 'first')
  const secondPath = path.join(userData, 'second')
  mkdirSync(firstPath)
  mkdirSync(secondPath)
  const canonicalSecondPath = realpathSync(secondPath)
  const project = (projectPath: string) => ({
    id: projectPath,
    name: path.basename(projectPath),
    path: projectPath,
    providers: ['codex' as const],
    lastUsedAt: 100,
  })

  setWorkItemAgentProjectAt(userData, 'item-1', project(firstPath))
  setWorkItemAgentThreadAt(userData, 'item-1', 'codex', 'thread-1')
  setWorkItemAgentProjectAt(userData, 'item-1', project(secondPath))

  assert.deepEqual(getWorkItemAgentExecutionAt(userData, 'item-1', 'codex'), {
    workingDirectory: canonicalSecondPath,
    threadId: null,
  })
})

test('Codex tasks without a project retain a stable workspace and resumable thread', () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'remember-agent-context-'))
  directories.push(userData)
  const first = getWorkItemAgentExecutionAt(userData, '../item-1', 'codex')
  assert.ok(first.workingDirectory?.startsWith(path.join(userData, 'agent-workspaces')))
  setWorkItemAgentThreadAt(userData, '../item-1', 'codex', 'thread-1')
  assert.deepEqual(getWorkItemAgentExecutionAt(userData, '../item-1', 'codex'), { ...first, threadId: 'thread-1' })
  assert.deepEqual(getWorkItemAgentExecutionAt(userData, '../item-1', 'claude'), {
    workingDirectory: null,
    threadId: null,
  })
  assert.notEqual(getWorkItemAgentExecutionAt(userData, 'other', 'codex').workingDirectory, first.workingDirectory)
  setWorkItemAgentProjectAt(userData, '../item-1', null)
  assert.equal(getWorkItemAgentExecutionAt(userData, '../item-1', 'codex').threadId, 'thread-1')
})
