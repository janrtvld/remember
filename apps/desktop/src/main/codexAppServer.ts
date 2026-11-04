import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { type CodexConnection, type CodexServerEvents, createCodexJsonRpc } from './codexJsonRpc'
import { terminateAgentProcess, trackAgentProcess, untrackAgentProcess } from './dailyReview/agentProcessLifecycle'

export type CodexServerOptions = CodexServerEvents & {
  executable: string
  env: NodeJS.ProcessEnv
  cwd?: string
}

// App Server's public newline-delimited JSON-RPC transport. Requests from the
// server (approvals/elicitation) must receive a response, not become notifications.
export function createCodexAppServer(options: CodexServerOptions) {
  const child = trackAgentProcess(
    spawn(options.executable, ['app-server', '--listen', 'stdio://'], {
      detached: true,
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
    { retainProcessGroup: true }
  ) as ChildProcessWithoutNullStreams
  const lines = createInterface({ input: child.stdout })
  const rpc = createCodexJsonRpc(options, {
    send: (data) => {
      if (!child.stdin.writable) throw new Error('codex-app-server-closed')
      child.stdin.write(`${data}\n`)
    },
    close: () => {
      lines.close()
      terminateAgentProcess(child)
      const killTimer = setTimeout(() => {
        terminateAgentProcess(child, 'SIGKILL')
        untrackAgentProcess(child)
      }, 2_000)
      killTimer.unref()
    },
  })
  lines.on('line', rpc.receive)
  // Drain stderr without persisting prompts, tool arguments, or credentials.
  child.stderr.resume()
  child.stdin.on('error', (error) => rpc.settle(error))
  child.once('error', (error) => rpc.settle(error))
  child.once('exit', (code) => rpc.settle(new Error(`codex-app-server-exit-${code ?? 'unknown'}`)))
  return rpc.connection
}

export type CodexAppServer = CodexConnection

export async function initializeCodexServer(server: CodexAppServer, version: string) {
  await server.request('initialize', {
    clientInfo: { name: 'remember', title: 'Remember', version },
    capabilities: { experimentalApi: true },
  })
  server.notify('initialized', {})
}
