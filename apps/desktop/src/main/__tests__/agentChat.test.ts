import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  type AgentChatRuntime,
  buildDesktopChatAppleScript,
  matchingRememberMcpServer,
  normalizeAgentChatInput,
  parseAgentChatInput,
} from '../agentChat'

const runtime: AgentChatRuntime = {
  commandPath: '/workspace/.remember-dev/tom/bin/remember',
  dataDirectory: '/workspace/.remember-dev/tom/daily-review',
  isolated: true,
  mcpServerName: 'remember-dev',
}

const mcpServer = { command: runtime.commandPath, args: ['mcp'] }

describe('desktop agent chat', () => {
  it('prefixes Codex prompts with the Remember skill', () => {
    assert.deepEqual(normalizeAgentChatInput({ provider: 'codex', query: 'What did I work on?' }), {
      provider: 'codex',
      prompt: '$remember What did I work on?',
    })
  })

  it('uses MCP for Claude Desktop lookups', () => {
    const input = normalizeAgentChatInput({ provider: 'claude', query: 'Find the billing decision' }, runtime)
    assert.equal(input?.provider, 'claude')
    assert.match(input?.prompt ?? '', /Remember MCP server "remember-dev"/)
    assert.match(input?.prompt ?? '', /remember_status/)
    assert.match(input?.prompt ?? '', /Find the billing decision/)
    assert.doesNotMatch(input?.prompt ?? '', /\/remember|\$remember/)
  })

  it('keeps Codex development lookups on the scoped CLI', () => {
    const input = normalizeAgentChatInput({ provider: 'codex', query: 'Find the billing decision' }, runtime)
    assert.ok(input?.prompt.includes(runtime.commandPath))
    assert.ok(input?.prompt.includes(runtime.dataDirectory))
    assert.doesNotMatch(input?.prompt ?? '', /\$remember|\.local\/bin/)
  })

  it('rejects an empty or unknown request', () => {
    assert.equal(normalizeAgentChatInput({ provider: 'codex', query: '   ' }), null)
    assert.equal(normalizeAgentChatInput({ provider: 'other', query: 'hello' }), null)
    assert.equal(normalizeAgentChatInput({ provider: 'codex', requestId: 'request-1' }), null)
    assert.equal(parseAgentChatInput({ provider: 'codex', query: 'hello', requestId: 'request-1' }), null)
    for (const requestId of ['', 'request\n1', 'request;whoami', "request'1", 'x'.repeat(101)]) {
      assert.equal(parseAgentChatInput({ provider: 'codex', requestId }), null)
    }
  })

  it('targets the application by its bundle identifier for both desktop apps', () => {
    for (const provider of ['codex', 'claude'] as const) {
      const script = buildDesktopChatAppleScript(provider)
      assert.match(script, /first application process whose bundle identifier is/)
      assert.doesNotMatch(script, /tell process "ChatGPT"/)
    }
  })
})

describe('Remember MCP profile matching', () => {
  it('chooses the development server when more than one name has the same scoped configuration', () => {
    assert.equal(
      matchingRememberMcpServer({ mcpServers: { remember: mcpServer, 'remember-dev': mcpServer } }, runtime),
      'remember-dev'
    )
  })

  it('accepts the exact wrapper with an explicit matching environment', () => {
    assert.equal(
      matchingRememberMcpServer(
        { mcpServers: { 'my-profile': { ...mcpServer, env: { REMEMBER_DATA_DIR: runtime.dataDirectory } } } },
        runtime
      ),
      'my-profile'
    )
  })

  it('rejects a production command or conflicting profile even when its server is named remember-dev', () => {
    for (const server of [
      { ...mcpServer, command: '/Users/jan/.local/bin/remember' },
      { ...mcpServer, env: { REMEMBER_DATA_DIR: '/Users/jan/Library/Application Support/Remember/daily-review' } },
      { ...mcpServer, env: { REMEMBER_DATA_DIR: null } },
      { ...mcpServer, args: ['mcp', '--other-profile'] },
      { ...mcpServer, disabled: true },
      { ...mcpServer, type: 'http' },
      { ...mcpServer, env: [] },
    ]) {
      assert.equal(matchingRememberMcpServer({ mcpServers: { 'remember-dev': server } }, runtime), null)
    }
  })

  it('rejects missing or malformed configurations', () => {
    for (const configuration of [null, [], {}, { mcpServers: [] }, { mcpServers: { remember: null } }]) {
      assert.equal(matchingRememberMcpServer(configuration, runtime), null)
    }
  })
})

describe('Codex Worker handoff', () => {
  it('requires a task prompt resolved by the main process and keeps other providers unchanged', () => {
    assert.deepEqual(parseAgentChatInput({ provider: 'codex', workItemId: 'task-1' }), {
      provider: 'codex',
      kind: 'workItem',
      workItemId: 'task-1',
    })
    assert.equal(normalizeAgentChatInput({ provider: 'codex', workItemId: 'task-1' }, runtime), null)
    assert.deepEqual(
      normalizeAgentChatInput(
        { provider: 'codex', workItemId: 'task-1' },
        { ...runtime, taskPrompt: 'Verified saved task context' }
      ),
      { provider: 'codex', prompt: 'Verified saved task context' }
    )
    assert.equal(parseAgentChatInput({ provider: 'claude', workItemId: 'task-1' }), null)
    assert.equal(parseAgentChatInput({ provider: 'codex', workItemId: 'task-1', query: 'override' }), null)
  })
})
