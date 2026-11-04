import { execFile } from 'node:child_process'
import { resolveAgentProcessCommand } from './agentPaths'
import { redactClaudeAnalysisSecrets } from './claudeAnalysisConfig'
import { redactAgentCredentials } from './dailyReview/agentErrors'

const agentVersionCache = new Map<string, Promise<string | null>>()

export function readAgentVersion(
  executable: string,
  homeDirectory: string,
  workingDirectory: string,
  environment: NodeJS.ProcessEnv
) {
  const cached = agentVersionCache.get(executable)
  if (cached) return cached
  const command = resolveAgentProcessCommand(executable, ['--version'], homeDirectory, environment)
  const pending = new Promise<string | null>((resolve) => {
    execFile(
      command.executable,
      command.arguments,
      { cwd: workingDirectory, env: environment, encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024 },
      (_error, stdout, stderr) => {
        const version =
          redactAgentCredentials(redactClaudeAnalysisSecrets(`${stdout ?? ''}\n${stderr ?? ''}`))
            .trim()
            .slice(0, 500) || null
        resolve(version)
      }
    )
  })
  agentVersionCache.set(executable, pending)
  return pending
}
