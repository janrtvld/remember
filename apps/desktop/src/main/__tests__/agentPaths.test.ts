import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  agentAuthenticationState,
  agentLoginShellEnvironment,
  agentProcessEnvironment,
  parseNullDelimitedEnvironment,
  resolveAgentProcessCommand,
  selectAgentStatusProbe,
} from '../agentPaths'

test('reads and shares a pending login-shell environment without blocking the event loop', async (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'remember-shell-environment-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const shell = path.join(directory, 'shell')
  writeFileSync(shell, '#!/bin/sh\n/bin/sleep 0.05\nprintf "PATH=/usr/bin:/bin\\0PROJECT=work\\0"\n', { mode: 0o755 })
  const environment = { SHELL: shell }
  let timerFired = false
  const timer = setTimeout(() => {
    timerFired = true
  }, 0)
  context.after(() => clearTimeout(timer))
  const pending = agentLoginShellEnvironment(directory, environment)
  assert.equal(agentLoginShellEnvironment(directory, environment), pending)
  assert.deepEqual(await pending, { PATH: '/usr/bin:/bin', PROJECT: 'work' })
  assert.equal(timerFired, true)
  assert.equal(agentLoginShellEnvironment(directory, environment), pending)
})

test('falls back to an empty shell environment after a failed launch', async (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'remember-shell-unavailable-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  assert.deepEqual(await agentLoginShellEnvironment(directory, { SHELL: path.join(directory, 'missing-shell') }), {})
})

test('makes the runtime for a Bun-installed agent available to child processes', () => {
  const environment = agentProcessEnvironment('/Users/tom/.bun/bin/codex', '/Users/tom', {
    PATH: '/usr/bin:/bin',
  })

  assert.equal(environment.PATH?.split(':')[0], '/Users/tom/.bun/bin')
  assert.match(environment.PATH ?? '', /\/Users\/tom\/\.bun\/bin/)
  assert.match(environment.PATH ?? '', /\/usr\/bin:\/bin/)
  assert.equal(environment.HOME, '/Users/tom')
  assert.equal(environment.CODEX_HOME, '/Users/tom/.codex')
})

test('preserves an explicit Codex home for status, login, and analysis', () => {
  const environment = agentProcessEnvironment('/Users/tom/.bun/bin/codex', '/Users/tom', {
    CODEX_HOME: '/Users/tom/.config/work-codex',
  })

  assert.equal(environment.CODEX_HOME, '/Users/tom/.config/work-codex')
})

test('uses the login shell Codex home when the desktop process does not have it', () => {
  const environment = agentProcessEnvironment(
    '/Users/tom/.bun/bin/codex',
    '/Users/tom',
    { PATH: '/usr/bin:/bin' },
    { CODEX_HOME: '/Users/tom/.config/work-codex', PATH: '/Applications/Bun/bin:/usr/bin' }
  )

  assert.equal(environment.CODEX_HOME, '/Users/tom/.config/work-codex')
  assert.match(environment.PATH ?? '', /\/Applications\/Bun\/bin/)
})

test('parses null-delimited login shell environments without truncating values', () => {
  assert.deepEqual(parseNullDelimitedEnvironment('PATH=/usr/bin:/bin\0CODEX_HOME=/Users/tom/Codex Home\0'), {
    PATH: '/usr/bin:/bin',
    CODEX_HOME: '/Users/tom/Codex Home',
  })
})

test('runs a Bun-installed Node shim through Bun', (context) => {
  const homeDirectory = mkdtempSync(path.join(tmpdir(), 'remember-agent-paths-'))
  context.after(() => rmSync(homeDirectory, { recursive: true, force: true }))
  const binDirectory = path.join(homeDirectory, '.bun', 'bin')
  const bunExecutable = path.join(binDirectory, 'bun')
  const codexExecutable = path.join(binDirectory, 'codex')
  mkdirSync(binDirectory, { recursive: true })
  writeFileSync(bunExecutable, '#!/bin/sh\n')
  writeFileSync(codexExecutable, '#!/usr/bin/env node\n')
  chmodSync(bunExecutable, 0o755)
  chmodSync(codexExecutable, 0o755)

  assert.deepEqual(resolveAgentProcessCommand(codexExecutable, ['login', 'status'], homeDirectory, {}), {
    executable: bunExecutable,
    arguments: [codexExecutable, 'login', 'status'],
  })
})

test('runs a Node shim through Bun resolved from PATH', (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'remember-agent-runtime-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const bunExecutable = path.join(directory, 'bun')
  const codexExecutable = path.join(directory, 'codex')
  writeFileSync(bunExecutable, '#!/bin/sh\n')
  writeFileSync(codexExecutable, '#!/usr/bin/env node\n')
  chmodSync(bunExecutable, 0o755)
  chmodSync(codexExecutable, 0o755)

  assert.deepEqual(resolveAgentProcessCommand(codexExecutable, ['exec'], '/Users/tom', { PATH: directory }), {
    executable: bunExecutable,
    arguments: [codexExecutable, 'exec'],
  })
})

test('accepts successful Codex status output without depending on its wording', () => {
  assert.equal(agentAuthenticationState('codex', 0, 'Logged in using ChatGPT'), 'authenticated')
  assert.equal(agentAuthenticationState('codex', 0, 'Authenticated with an access token'), 'authenticated')
  assert.equal(agentAuthenticationState('codex', 1, 'Logged in using ChatGPT'), 'unknown')
  assert.equal(agentAuthenticationState('codex', 0, 'Not logged in'), 'signed-out')
})

test('does not turn an inconclusive Codex probe into a login loop', () => {
  assert.equal(agentAuthenticationState('codex', 127, '/usr/bin/env: node: No such file or directory'), 'unknown')
})

test('uses the authenticated CLI when multiple Codex installations exist', () => {
  assert.equal(
    selectAgentStatusProbe('codex', [
      { executable: '/opt/homebrew/bin/codex', code: 1, output: 'Not logged in' },
      { executable: '/Users/tom/.bun/bin/codex', code: 0, output: 'Logged in using ChatGPT' },
    ])?.executable,
    '/Users/tom/.bun/bin/codex'
  )
})

test('prefers an explicit signed-out probe over a broken installation', () => {
  assert.equal(
    selectAgentStatusProbe('codex', [
      { executable: '/opt/homebrew/bin/codex', code: 127, output: 'node: command not found' },
      { executable: '/Users/tom/.bun/bin/codex', code: 1, output: 'Not logged in' },
    ])?.executable,
    '/Users/tom/.bun/bin/codex'
  )
})

test('reads Claude authentication from its JSON status', () => {
  assert.equal(agentAuthenticationState('claude', 0, '{"loggedIn":true}'), 'authenticated')
  assert.equal(agentAuthenticationState('claude', 0, 'Update available\n{"loggedIn":true}'), 'authenticated')
  assert.equal(agentAuthenticationState('claude', 0, '{"loggedIn":false}'), 'signed-out')
  assert.equal(agentAuthenticationState('claude', 1, 'not-json'), 'unknown')
})
