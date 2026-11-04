import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CliSetupStatus } from '@remember/shared'
import { app } from 'electron'
import { ensureCliAccessAt, getCliSetupStatusAt, installCliAccessAt, resolveCliSetupPaths } from './cliSetupFiles'

function setupPaths() {
  const resourcesDirectory = app.isPackaged ? process.resourcesPath : app.getAppPath()
  const resourceRoot = app.isPackaged ? resourcesDirectory : join(resourcesDirectory, 'resources')
  const paths = resolveCliSetupPaths(homedir(), resourceRoot)
  if (!app.isPackaged) {
    paths.commandSource = join(resourcesDirectory, 'native', 'remember')
  }
  return paths
}

function failureStatus(error: unknown): CliSetupStatus {
  const paths = setupPaths()
  return {
    installed: false,
    upToDate: false,
    commandInstalled: false,
    codexSkillInstalled: false,
    claudeSkillInstalled: false,
    commandPath: paths.commandTarget,
    pathAvailable: false,
    error: error instanceof Error ? error.message : String(error),
  }
}

export async function getCliSetupStatus(): Promise<CliSetupStatus> {
  try {
    return await getCliSetupStatusAt(setupPaths())
  } catch (error) {
    return failureStatus(error)
  }
}

export async function installCliAccess(): Promise<CliSetupStatus> {
  try {
    return await installCliAccessAt(setupPaths())
  } catch (error) {
    console.error('[cli-setup] installation failed', error)
    const status = await getCliSetupStatus()
    return {
      ...status,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function ensureCliAccess(): Promise<CliSetupStatus> {
  try {
    return await ensureCliAccessAt(setupPaths())
  } catch (error) {
    console.error('[cli-setup] automatic installation failed', error)
    const status = await getCliSetupStatus()
    return {
      ...status,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
