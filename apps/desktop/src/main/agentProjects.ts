import { realpathSync } from 'node:fs'
import path from 'node:path'
import type { AgentProject } from '@remember/shared'
import { app, dialog } from 'electron'
import { createAgentProjectDiscoveryCache } from './agentProjectDiscoveryCache'
import {
  getWorkItemAgentContextAt,
  getWorkItemAgentExecutionAt,
  listStoredAgentProjectsAt,
  setWorkItemAgentProjectAt,
  setWorkItemAgentThreadAt,
} from './agentWorkContextStore'
import { discoverAgentProjectsAt } from './contextImportSources'
import { localText } from './localization'
import { getInterfaceLocale } from './settings'

const discoverProjects = createAgentProjectDiscoveryCache(() => discoverAgentProjectsAt(app.getPath('home')))

export async function listAgentProjects() {
  const discovered = await discoverProjects()
  const projects = new Map(discovered.map((project) => [project.path, project]))
  for (const stored of listStoredAgentProjectsAt(app.getPath('userData'))) {
    const current = projects.get(stored.path)
    projects.set(stored.path, current ? { ...stored, ...current } : stored)
  }
  return [...projects.values()].sort(
    (left, right) => (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0) || left.name.localeCompare(right.name)
  )
}

export async function chooseAgentProject(): Promise<AgentProject | null> {
  const locale = getInterfaceLocale()
  const result = await dialog.showOpenDialog({
    title: localText(locale, 'Kies een project', 'Choose a project'),
    buttonLabel: localText(locale, 'Kies project', 'Choose project'),
    properties: ['openDirectory'],
  })
  const selected = result.filePaths[0]
  if (result.canceled || !selected) return null
  const directory = realpathSync(selected)
  const known = (await listAgentProjects()).find((project) => project.path === directory)
  return (
    known ?? {
      id: directory,
      name: path.basename(directory),
      path: directory,
      providers: [],
      lastUsedAt: null,
    }
  )
}

export function getWorkItemAgentContext(itemId: string) {
  return getWorkItemAgentContextAt(app.getPath('userData'), itemId)
}

export function setWorkItemAgentProject(itemId: string, project: AgentProject | null) {
  return setWorkItemAgentProjectAt(app.getPath('userData'), itemId, project)
}

export function getWorkItemAgentExecution(itemId: string, provider: 'codex' | 'claude') {
  return getWorkItemAgentExecutionAt(app.getPath('userData'), itemId, provider)
}

export function setWorkItemAgentThread(itemId: string, provider: 'codex' | 'claude', threadId: string) {
  setWorkItemAgentThreadAt(app.getPath('userData'), itemId, provider, threadId)
}
