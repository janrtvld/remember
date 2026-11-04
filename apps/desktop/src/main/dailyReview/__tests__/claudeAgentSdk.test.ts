import assert from 'node:assert/strict'
import test from 'node:test'
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  buildClaudeChatSdkOptions,
  buildClaudeSdkOptions,
  buildClaudeWorkspaceSdkOptions,
  claudeSdkResultError,
  isSuccessfulClaudeSdkResult,
} from '../claudeAgentSdk'

test('configures an isolated ephemeral structured-output query', () => {
  const abortController = new AbortController()
  const env = { HOME: '/Users/example', PATH: '/usr/bin' }
  const spawnClaudeCodeProcess = () => {
    throw new Error('not-called')
  }
  const options = buildClaudeSdkOptions({
    abortController,
    cwd: '/tmp/remember',
    effort: 'medium',
    env,
    executable: '/Applications/Remember.app/Contents/Resources/claude',
    model: 'sonnet',
    schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
    spawnClaudeCodeProcess,
    systemPrompt: 'Analyze the evidence.',
  })

  assert.equal(options.abortController, abortController)
  assert.equal(options.cwd, '/tmp/remember')
  assert.equal(options.env, env)
  assert.equal(options.pathToClaudeCodeExecutable, '/Applications/Remember.app/Contents/Resources/claude')
  assert.deepEqual(options.outputFormat, {
    type: 'json_schema',
    schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
  })
  assert.deepEqual(options.tools, [])
  assert.deepEqual(options.settingSources, [])
  assert.deepEqual(options.mcpServers, {})
  assert.equal(options.strictMcpConfig, true)
  assert.equal(options.persistSession, false)
  assert.equal(options.permissionMode, 'dontAsk')
  assert.equal(options.spawnClaudeCodeProcess, spawnClaudeCodeProcess)
})

test('configures a plain-text Claude turn without an output format', () => {
  const options = buildClaudeChatSdkOptions({
    abortController: new AbortController(),
    cwd: '/tmp/remember',
    effort: 'medium',
    env: { PATH: '/usr/bin' },
    executable: '/Applications/Remember.app/Contents/Resources/claude',
    model: 'sonnet',
    spawnClaudeCodeProcess: () => {
      throw new Error('not-called')
    },
    systemPrompt: 'Help with the task.',
  })

  assert.equal(options.outputFormat, undefined)
  assert.deepEqual(options.tools, [])
  assert.equal(options.persistSession, false)
})

test('configures a persistent sandboxed Claude workspace turn', () => {
  const options = buildClaudeWorkspaceSdkOptions({
    abortController: new AbortController(),
    cwd: '/Users/example/Developer/remember',
    effort: 'high',
    env: { PATH: '/usr/bin' },
    executable: '/Applications/Remember.app/Contents/Resources/claude',
    model: 'opus',
    resume: '00000000-0000-4000-8000-000000000001',
    spawnClaudeCodeProcess: () => {
      throw new Error('not-called')
    },
    systemPrompt: 'Work in the selected repository.',
  })

  assert.equal(options.persistSession, true)
  assert.equal(options.resume, '00000000-0000-4000-8000-000000000001')
  assert.deepEqual(options.settingSources, ['project'])
  assert.deepEqual(options.tools, ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'])
  assert.deepEqual(options.sandbox, {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    network: { allowedDomains: [], strictAllowlist: true },
    filesystem: { allowWrite: ['/Users/example/Developer/remember'] },
  })
})

test('maps structured-output exhaustion to the retryable Claude error', () => {
  const result = {
    type: 'result',
    subtype: 'error_max_structured_output_retries',
    errors: ['Output does not match required schema'],
  } as SDKResultMessage

  const error = claudeSdkResultError(result)
  assert.equal(error?.message, 'claude-structured-output-failed')
  assert.equal(error?.cause instanceof Error ? error.cause.message : null, 'Output does not match required schema')
})

test('recognizes only a completed non-error Claude result as usable', () => {
  const success = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '{"summary":"Done"}',
  } as SDKResultMessage
  const failedSuccess = { ...success, is_error: true } as SDKResultMessage
  const executionError = {
    type: 'result',
    subtype: 'error_during_execution',
    errors: ['Process failed'],
  } as SDKResultMessage

  assert.equal(isSuccessfulClaudeSdkResult(success), true)
  assert.equal(isSuccessfulClaudeSdkResult(failedSuccess), false)
  assert.equal(isSuccessfulClaudeSdkResult(executionError), false)
  assert.equal(isSuccessfulClaudeSdkResult(null), false)
})
