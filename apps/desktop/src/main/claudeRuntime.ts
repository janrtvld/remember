import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { agentLoginShellEnvironment, agentProcessEnvironment } from './agentPaths'
import { bundledClaudeExecutablePath, withClaudeRuntimeEnvironment } from './claudeRuntimePaths'

export function bundledClaudeExecutable() {
  return bundledClaudeExecutablePath({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
  })
}

export function rememberClaudeConfigDirectory() {
  const directory = path.join(app.getPath('userData'), 'claude')
  mkdirSync(directory, { recursive: true })
  return directory
}

export async function claudeProcessEnvironment(executable: string) {
  const homeDirectory = app.getPath('home')
  const environment = agentProcessEnvironment(
    executable,
    homeDirectory,
    process.env,
    await agentLoginShellEnvironment(homeDirectory)
  )
  return withClaudeRuntimeEnvironment(environment, rememberClaudeConfigDirectory())
}
