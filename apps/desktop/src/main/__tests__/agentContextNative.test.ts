import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { it } from 'node:test'

const binary = process.env.REMEMBER_CONTEXT_CLI

function invoke(directory: string, input: object) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(binary as string, ['agent-hook', '--provider', 'codex'], {
      env: { ...process.env, REMEMBER_DATA_DIR: directory },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ stdout, stderr, code }))
    child.stdin.end(JSON.stringify(input))
  })
}

it('retired native hooks return no context and never contact the open app', { skip: !binary }, async () => {
  const directory = await mkdtemp('/private/tmp/rctx-')
  let connections = 0
  const server = createServer((connection) => {
    connections += 1
    connection.end()
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(join(directory, 'remember-agent.sock'), resolve)
    })
    for (const hookEvent of ['SessionStart', 'UserPromptSubmit']) {
      const result = await invoke(directory, {
        session_id: 'native-test',
        cwd: '/work/app',
        hook_event_name: hookEvent,
        prompt: 'Continue my project',
      })
      assert.equal(result.code, 0, result.stderr)
      assert.deepEqual(JSON.parse(result.stdout), {})
      assert.equal(result.stderr, '')
    }
    assert.equal(connections, 0)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
