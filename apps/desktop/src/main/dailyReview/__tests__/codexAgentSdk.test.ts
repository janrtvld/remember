import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Codex } from '@openai/codex-sdk'
import {
  buildCodexChatSdkConfiguration,
  buildCodexSdkConfiguration,
  buildCodexWorkspaceSdkConfiguration,
} from '../codexAgentSdk'

test('request inference keeps login but exposes no tools or inherited context to the installed Codex model transport', {
  skip: process.platform !== 'darwin',
}, async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'remember-codex-no-tools-'))
  mkdirSync(path.join(cwd, 'codex'))
  mkdirSync(path.join(cwd, 'codex', 'skills', 'private'), { recursive: true })
  writeFileSync(path.join(cwd, 'AGENTS.md'), 'OUTSIDE-SCOPE-PROJECT-CONTEXT')
  writeFileSync(path.join(cwd, 'codex', 'AGENTS.md'), 'OUTSIDE-SCOPE-GLOBAL-CONTEXT')
  writeFileSync(path.join(cwd, 'codex', 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'synthetic-test-key' }))
  writeFileSync(
    path.join(cwd, 'codex', 'skills', 'private', 'SKILL.md'),
    '---\nname: private\ndescription: OUTSIDE-SCOPE-SKILL-CONTEXT\n---\nPrivate information.'
  )
  const controller = new AbortController()
  let received: Record<string, unknown> | undefined
  let receivedPath = ''
  let receivedAuthorization = ''
  let transportError = ''
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    if (request.method !== 'POST') {
      response.writeHead(404).end()
      return
    }
    received = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    receivedPath = request.url ?? ''
    receivedAuthorization = request.headers.authorization ?? ''
    response
      .writeHead(400, { 'Content-Type': 'application/json' })
      .end(
        JSON.stringify({ error: { message: 'Synthetic transport inspection complete', type: 'invalid_request_error' } })
      )
  })
  const timeout = setTimeout(() => controller.abort(), 20_000)
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert(address && typeof address !== 'string')
    const require = createRequire(import.meta.url)
    const executable = path.join(
      path.dirname(require.resolve('@openai/codex-darwin-arm64/package.json')),
      'vendor/aarch64-apple-darwin/bin/codex'
    )
    const configuration = buildCodexSdkConfiguration({
      abortController: controller,
      cwd,
      effort: 'low',
      env: { PATH: process.env.PATH, CODEX_HOME: path.join(cwd, 'codex') },
      executable,
      model: 'gpt-5.6-terra',
      schema: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
        additionalProperties: false,
      },
      toolsDisabled: true,
    })
    const codex = new Codex({
      ...configuration.client,
      config: {
        ...configuration.client.config,
        model_provider: 'inspection',
        model_providers: {
          inspection: {
            name: 'Local inspection',
            base_url: `http://127.0.0.1:${address.port}/v1`,
            wire_api: 'responses',
            requires_openai_auth: true,
          },
        },
        'features.enable_request_compression': false,
      },
    })
    await codex
      .startThread(configuration.thread)
      .run('Return the supplied word OK as JSON. Do not read files.', configuration.turn)
      .catch((error) => {
        transportError = String(error)
      })
    assert(received, `The installed CLI must reach the local model transport: ${transportError}`)
    assert.equal(receivedPath, '/v1/responses')
    assert.equal(receivedAuthorization, 'Bearer synthetic-test-key')
    assert(
      Array.isArray(received.input),
      `Expected a model request, received fields: ${Object.keys(received).join(', ')}`
    )
    assert.deepEqual(
      received.tools ?? [],
      [],
      'Scoped automatic replies must not expose shell, files, web, apps, or other tools'
    )
    const leakedContext = JSON.stringify(received).match(/OUTSIDE-SCOPE-[A-Z-]+/g) ?? []
    assert.deepEqual(leakedContext, [], 'External instructions and skills must not enter the scoped model context')
  } finally {
    clearTimeout(timeout)
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(cwd, { recursive: true, force: true })
  }
})

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs = 8_000) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('process-exit-timeout')), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
  })
}

test('configures an isolated read-only structured-output Codex SDK run', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'remember-codex-sdk-test-'))
  const abortController = new AbortController()
  try {
    const configuration = buildCodexSdkConfiguration({
      abortController,
      cwd,
      effort: 'medium',
      env: { CODEX_HOME: '/Users/example/Remember/codex', PATH: '/usr/bin', UNSET: undefined },
      executable: '/Applications/Remember.app/Contents/Resources/codex',
      model: 'gpt-5.6-terra',
      schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
    })

    assert.deepEqual(configuration.client, {
      codexPathOverride: path.join(cwd, 'codex-sdk'),
      env: {
        CODEX_HOME: '/Users/example/Remember/codex',
        PATH: '/usr/bin',
        REMEMBER_CODEX_EXECUTABLE: '/Applications/Remember.app/Contents/Resources/codex',
        REMEMBER_CODEX_OWNER_PID: String(process.pid),
      },
      config: {
        agents: { enabled: false },
        history: { persistence: 'none' },
        hooks: {},
        mcp_servers: {},
        memories: { generate_memories: false },
        plugins: {},
      },
    })
    const wrapper = readFileSync(path.join(cwd, 'codex-sdk'), 'utf8')
    assert.match(wrapper, /--ephemeral --ignore-user-config --ignore-rules/)
    assert.deepEqual(configuration.thread, {
      approvalPolicy: 'never',
      model: 'gpt-5.6-terra',
      modelReasoningEffort: 'medium',
      networkAccessEnabled: false,
      sandboxMode: 'read-only',
      skipGitRepoCheck: true,
      webSearchMode: 'disabled',
      workingDirectory: cwd,
    })
    assert.equal(configuration.turn.signal, abortController.signal)
    assert.deepEqual(configuration.turn.outputSchema, {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
    })
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('terminates the Codex process group and its descendant when the SDK wrapper is aborted', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'remember-codex-sdk-process-test-'))
  const fixtureScript = path.join(cwd, 'fake-codex.cjs')
  const fixtureExecutable = path.join(cwd, 'fake-codex')
  const marker = path.join(cwd, 'processes.txt')
  let processIds: number[] = []

  try {
    writeFileSync(
      fixtureScript,
      `const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
writeFileSync(process.env.REMEMBER_TEST_MARKER, process.pid + '\\n' + descendant.pid)
setInterval(() => {}, 1000)
`,
      { mode: 0o600 }
    )
    writeFileSync(fixtureExecutable, '#!/bin/sh\nexec "$REMEMBER_TEST_NODE" "$REMEMBER_TEST_SCRIPT"\n', { mode: 0o700 })
    const configuration = buildCodexChatSdkConfiguration({
      abortController: new AbortController(),
      cwd,
      effort: 'medium',
      env: {
        PATH: '/usr/bin:/bin',
        REMEMBER_TEST_MARKER: marker,
        REMEMBER_TEST_NODE: process.execPath,
        REMEMBER_TEST_SCRIPT: fixtureScript,
      },
      executable: fixtureExecutable,
      model: 'gpt-5.6-terra',
    })
    const child = spawn(configuration.client.codexPathOverride as string, [], {
      env: configuration.client.env,
      stdio: 'ignore',
    })

    const markerDeadline = Date.now() + 5_000
    while (Date.now() < markerDeadline) {
      try {
        processIds = readFileSync(marker, 'utf8').trim().split('\n').map(Number)
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
    assert.equal(processIds.length, 2)

    child.kill('SIGTERM')
    await once(child, 'exit')

    const exitDeadline = Date.now() + 2_000
    for (const processId of processIds) {
      while (Date.now() < exitDeadline) {
        try {
          process.kill(processId, 0)
          await new Promise((resolve) => setTimeout(resolve, 25))
        } catch {
          break
        }
      }
      assert.throws(() => process.kill(processId, 0), { code: 'ESRCH' })
    }
  } finally {
    for (const processId of processIds) {
      try {
        process.kill(processId, 'SIGKILL')
      } catch {}
    }
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('does not launch Codex while the offline sentinel exists', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'remember-codex-sdk-offline-test-'))
  const fixtureExecutable = path.join(cwd, 'fake-codex')
  const sentinel = path.join(cwd, '.offline-mode')
  const marker = path.join(cwd, 'launched.txt')

  try {
    writeFileSync(fixtureExecutable, '#!/bin/sh\ntouch "$REMEMBER_TEST_MARKER"\n', { mode: 0o700 })
    writeFileSync(sentinel, 'offline\n', { mode: 0o600 })
    const configuration = buildCodexChatSdkConfiguration({
      abortController: new AbortController(),
      cwd,
      effort: 'medium',
      env: {
        PATH: '/usr/bin:/bin',
        REMEMBER_OFFLINE_SENTINEL: sentinel,
        REMEMBER_TEST_MARKER: marker,
      },
      executable: fixtureExecutable,
      model: 'gpt-5.6-terra',
    })
    const child = spawn(configuration.client.codexPathOverride as string, [], {
      env: configuration.client.env,
      stdio: 'ignore',
    })
    const [exitCode] = (await once(child, 'exit')) as [number | null]

    assert.equal(exitCode, 125)
    assert.equal(existsSync(marker), false)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('terminates the Codex process group when its owning app process exits abruptly', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'remember-codex-sdk-owner-test-'))
  const fixtureScript = path.join(cwd, 'fake-codex.cjs')
  const fixtureExecutable = path.join(cwd, 'fake-codex')
  const marker = path.join(cwd, 'processes.txt')
  const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  let wrapper: ReturnType<typeof spawn> | null = null
  let processIds: number[] = []

  try {
    assert.ok(owner.pid)
    writeFileSync(
      fixtureScript,
      `const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
writeFileSync(process.env.REMEMBER_TEST_MARKER, process.pid + '\\n' + descendant.pid)
setInterval(() => {}, 1000)
`,
      { mode: 0o600 }
    )
    writeFileSync(fixtureExecutable, '#!/bin/sh\nexec "$REMEMBER_TEST_NODE" "$REMEMBER_TEST_SCRIPT"\n', { mode: 0o700 })
    const configuration = buildCodexChatSdkConfiguration({
      abortController: new AbortController(),
      cwd,
      effort: 'medium',
      env: {
        PATH: '/usr/bin:/bin',
        REMEMBER_TEST_MARKER: marker,
        REMEMBER_TEST_NODE: process.execPath,
        REMEMBER_TEST_SCRIPT: fixtureScript,
      },
      executable: fixtureExecutable,
      model: 'gpt-5.6-terra',
      ownerProcessId: owner.pid,
    })
    wrapper = spawn(configuration.client.codexPathOverride as string, [], {
      env: configuration.client.env,
      stdio: 'ignore',
    })

    const markerDeadline = Date.now() + 5_000
    while (Date.now() < markerDeadline) {
      try {
        processIds = readFileSync(marker, 'utf8').trim().split('\n').map(Number)
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
    assert.equal(processIds.length, 2)

    const wrapperExited = waitForExit(wrapper)
    owner.kill('SIGKILL')
    await wrapperExited

    const exitDeadline = Date.now() + 2_000
    for (const processId of processIds) {
      while (Date.now() < exitDeadline) {
        try {
          process.kill(processId, 0)
          await new Promise((resolve) => setTimeout(resolve, 25))
        } catch {
          break
        }
      }
      assert.throws(() => process.kill(processId, 0), { code: 'ESRCH' })
    }
  } finally {
    owner.kill('SIGKILL')
    wrapper?.kill('SIGKILL')
    for (const processId of processIds) {
      try {
        process.kill(processId, 'SIGKILL')
      } catch {}
    }
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('configures a plain-text Codex turn without an output schema', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'remember-codex-chat-sdk-test-'))
  const abortController = new AbortController()
  try {
    const configuration = buildCodexChatSdkConfiguration({
      abortController,
      cwd,
      effort: 'medium',
      env: { PATH: '/usr/bin' },
      executable: '/Applications/Remember.app/Contents/Resources/codex',
      model: 'gpt-5.6-terra',
    })

    assert.equal(configuration.turn.signal, abortController.signal)
    assert.equal(configuration.turn.outputSchema, undefined)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('configures a persistent workspace-write Codex turn that keeps project rules', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'remember-codex-workspace-test-'))
  const runtimeDirectory = mkdtempSync(path.join(tmpdir(), 'remember-codex-runtime-test-'))
  try {
    const configuration = buildCodexWorkspaceSdkConfiguration({
      abortController: new AbortController(),
      cwd,
      effort: 'high',
      env: { PATH: '/usr/bin' },
      executable: '/Applications/Remember.app/Contents/Resources/codex',
      model: 'gpt-5.6-sol',
      runtimeDirectory,
    })

    assert.equal(configuration.thread.workingDirectory, cwd)
    assert.equal(configuration.thread.sandboxMode, 'workspace-write')
    assert.equal(configuration.thread.networkAccessEnabled, false)
    assert.equal(configuration.client.config?.history, undefined)
    const wrapper = readFileSync(path.join(runtimeDirectory, 'codex-sdk'), 'utf8')
    assert.match(wrapper, /--ignore-user-config/)
    assert.doesNotMatch(wrapper, /--ephemeral/)
    assert.doesNotMatch(wrapper, /--ignore-rules/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
    rmSync(runtimeDirectory, { recursive: true, force: true })
  }
})

test('tool-disabled SDK configuration suppresses only experimental-feature startup notices while retaining isolation', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'remember-codex-sdk-warning-'))
  try {
    const configuration = buildCodexChatSdkConfiguration({
      abortController: new AbortController(),
      cwd,
      effort: 'low',
      env: { CODEX_HOME: path.join(cwd, 'source-login'), PATH: '/usr/bin:/bin' },
      executable: '/Applications/Remember.app/Contents/Resources/codex',
      model: 'gpt-5.6-terra',
      toolsDisabled: true,
    })
    const config = configuration.client.config
    assert.equal(config?.suppress_unstable_features_warning, true)
    assert.deepEqual(config?.features, {
      apps: false,
      artifact: false,
      browser_use: false,
      chronicle: false,
      code_mode: false,
      code_mode_host: false,
      computer_use: false,
      goals: false,
      hooks: false,
      image_generation: false,
      memories: false,
      multi_agent: false,
      multi_agent_v2: false,
      plugins: false,
      shell_snapshot: false,
      shell_tool: false,
      skill_search: false,
      skip_host_skill_discovery: true,
      sleep_tool: false,
      tool_suggest: false,
      unified_exec: false,
      view_image: false,
      workspace_dependencies: false,
    })
    assert.equal(config?.project_doc_max_bytes, 0)
    assert.equal(config?.include_environment_context, false)
    assert.deepEqual(config?.skills, { include_instructions: false })
    assert.deepEqual(config?.tools, { web_search: false })
    assert.equal(configuration.thread.sandboxMode, 'read-only')
    assert.equal(configuration.thread.networkAccessEnabled, false)
    assert.equal(configuration.thread.webSearchMode, 'disabled')
    assert.equal(configuration.thread.approvalPolicy, 'never')
    assert.equal(configuration.turn.outputSchema, undefined)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
