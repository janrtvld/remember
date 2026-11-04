import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { setTimeout as wait } from 'node:timers/promises'
import { createAgentProcessController } from '../agentProcessLifecycle'
import { readClaudeAnalysisResult } from '../claudeAnalysisQuery'

function syntheticClaudeProcess(mode: 'result' | 'timeout' | 'exit') {
  return `
    const { spawn } = require('node:child_process');
    const { createInterface } = require('node:readline');
    const write = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
    const sendResult = () => {
      write({ type: 'system', subtype: 'init', session_id: 'synthetic-test' });
      if (${JSON.stringify(mode)} === 'result') {
        write({ type: 'result', subtype: 'success', is_error: false, result: '{"summary":"Done"}' });
      }
    };
    createInterface({ input: process.stdin }).on('line', (line) => {
      const message = JSON.parse(line);
      if (message.type === 'control_request') {
        write({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
      }
      if (message.type === 'user') {
        if (${JSON.stringify(mode)} === 'exit') process.exit(1);
        const descendant = spawn(process.execPath, ['-e',
          "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"
        ], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
        descendant.once('message', sendResult);
      }
    });
    setInterval(() => {}, 1000);
  `
}

function groupRunning(processId: number) {
  try {
    process.kill(-processId, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    // macOS can briefly reject group probes while SIGKILL is being reaped; keep waiting for ESRCH.
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true
    throw error
  }
}

for (const mode of ['result', 'timeout', 'exit'] as const) {
  test(`installed SDK ${mode} settles and reaps the owned process group`, {
    skip: process.platform === 'win32',
  }, async () => {
    const { query } = await import('@anthropic-ai/claude-agent-sdk')
    const controller = new AbortController()
    const processes = createAgentProcessController()
    const timeoutError = new Error('claude-timeout')
    let processId: number | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const sdkQuery = query({
      prompt: 'Synthetic lifecycle check.',
      options: {
        abortController: controller,
        pathToClaudeCodeExecutable: process.execPath,
        persistSession: false,
        settingSources: [],
        tools: [],
        mcpServers: {},
        spawnClaudeCodeProcess: (options) => {
          const child = processes.track(
            spawn(process.execPath, ['-e', syntheticClaudeProcess(mode)], {
              detached: true,
              signal: options.signal,
              stdio: ['pipe', 'pipe', 'pipe'],
            }),
            { retainProcessGroup: true }
          )
          processId = child.pid
          return child
        },
      },
    })
    const watchdog = setTimeout(() => controller.abort(new Error('synthetic-test-watchdog')), 5_000)

    try {
      const completed = readClaudeAnalysisResult(sdkQuery, {
        signal: controller.signal,
        onMessage: () => {
          if (mode === 'timeout') timer = setTimeout(() => controller.abort(timeoutError), 10)
        },
      })
      if (mode === 'result') {
        assert.equal((await completed)?.subtype, 'success')
      } else if (mode === 'timeout') {
        await assert.rejects(completed, (error) => error === timeoutError)
      } else {
        await assert.rejects(completed, /process exited with code 1/)
      }
      await processes.cancelActive(100)
      assert.ok(processId)
      for (let attempt = 0; attempt < 100 && groupRunning(processId); attempt += 1) await wait(10)
      assert.equal(groupRunning(processId), false, 'Process group survived cleanup')
    } finally {
      clearTimeout(watchdog)
      clearTimeout(timer)
      sdkQuery.close()
      await processes.cancelActive(0)
      if (processId && groupRunning(processId)) process.kill(-processId, 'SIGKILL')
    }
  })
}
