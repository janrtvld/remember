import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ClaudeMcpSetupStatus } from '@remember/shared'
import { app } from 'electron'
import { getClaudeMcpSetupStatusAt, installClaudeMcpAt, resolveClaudeMcpSetupPaths } from './claudeMcpSetupFiles'
import { ensureCliAccess, getCliSetupStatus } from './cliSetup'

function setupPaths(commandPath: string) {
  const userData = app.getPath('userData')
  return resolveClaudeMcpSetupPaths(homedir(), commandPath, {
    serverName: 'remember',
    dataDirectory: join(userData, 'daily-review'),
  })
}

function failureStatus(commandPath: string, error: unknown): ClaudeMcpSetupStatus {
  return {
    connected: false,
    conflict: false,
    commandPath,
    error: error instanceof Error ? error.message : String(error),
  }
}

export async function getClaudeMcpSetupStatus(): Promise<ClaudeMcpSetupStatus> {
  const cli = await getCliSetupStatus()
  if (!cli.commandInstalled)
    return failureStatus(cli.commandPath, cli.error ?? 'Remember CLI kon niet worden geïnstalleerd.')
  try {
    return await getClaudeMcpSetupStatusAt(setupPaths(cli.commandPath))
  } catch (error) {
    return failureStatus(cli.commandPath, error)
  }
}

export async function installClaudeMcp(): Promise<ClaudeMcpSetupStatus> {
  const cli = await ensureCliAccess()
  if (!cli.commandInstalled)
    return failureStatus(cli.commandPath, cli.error ?? 'Remember CLI kon niet worden geïnstalleerd.')
  try {
    return await installClaudeMcpAt(setupPaths(cli.commandPath))
  } catch (error) {
    return failureStatus(cli.commandPath, error)
  }
}
