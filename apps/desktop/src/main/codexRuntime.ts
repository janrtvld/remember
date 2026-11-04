import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { agentLoginShellEnvironment, agentProcessEnvironment } from './agentPaths'
import { bundledCodexExecutablePath } from './codexRuntimePaths'

export function bundledCodexExecutable() {
  return bundledCodexExecutablePath({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
  })
}

export function rememberCodexHome() {
  const directory = path.join(app.getPath('userData'), 'codex')
  mkdirSync(directory, { recursive: true })
  return directory
}

export async function codexProcessEnvironment(executable: string) {
  const homeDirectory = app.getPath('home')
  const environment = agentProcessEnvironment(
    executable,
    homeDirectory,
    process.env,
    await agentLoginShellEnvironment(homeDirectory)
  )
  return { ...environment, CODEX_HOME: rememberCodexHome() }
}
