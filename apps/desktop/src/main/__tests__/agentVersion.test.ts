import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readAgentVersion } from '../agentVersion'

test('shares an asynchronous version probe and retains diagnostic output from a nonzero exit', async (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'remember-agent-version-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const executable = path.join(directory, 'agent')
  writeFileSync(executable, '#!/bin/sh\n/bin/sleep 0.05\nprintf "agent 1.2.3"\nprintf "warning" >&2\nexit 1\n', {
    mode: 0o755,
  })
  let timerFired = false
  const timer = setTimeout(() => {
    timerFired = true
  }, 0)
  context.after(() => clearTimeout(timer))
  const pending = readAgentVersion(executable, directory, directory, {})
  assert.equal(readAgentVersion(executable, directory, directory, {}), pending)
  assert.equal(await pending, 'agent 1.2.3\nwarning')
  assert.equal(timerFired, true)
  assert.equal(readAgentVersion(executable, directory, directory, {}), pending)
})

test('treats unavailable version metadata as optional', async (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'remember-agent-version-missing-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  assert.equal(await readAgentVersion(path.join(directory, 'missing-agent'), directory, directory, {}), null)
})
