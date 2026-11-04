import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, it } from 'node:test'
import { ensureCliAccessAt, removeLegacyAgentContextHooksAt, resolveCliSetupPaths } from '../cliSetupFiles'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'remember-context-hooks-'))
  roots.push(directory)
  const paths = resolveCliSetupPaths(join(directory, "person's home"), join(directory, 'resources'))
  await mkdir(dirname(paths.codexHooksTarget), { recursive: true })
  await mkdir(dirname(paths.claudeHooksTarget), { recursive: true })
  const command = (provider: string) =>
    `'${paths.commandTarget.replaceAll("'", "'\\''")}' agent-hook --provider ${provider}`
  return { paths, command }
}

it('removes only retired Remember hooks and preserves unrelated hooks and settings', async () => {
  const { paths, command } = await fixture()
  const unrelated = { type: 'command', command: 'existing-user-hook', timeout: 10 }
  const codexHook = { type: 'command', command: command('codex'), timeout: 2 }
  const claudeHook = { type: 'command', command: command('claude'), timeout: 2 }
  await writeFile(
    paths.codexHooksTarget,
    JSON.stringify({
      description: 'My hooks',
      hooks: {
        Stop: [{ hooks: [unrelated] }],
        SessionStart: [{ hooks: [codexHook] }],
        UserPromptSubmit: [{ matcher: '', hooks: [unrelated, codexHook] }, { hooks: [] }],
      },
    })
  )
  await writeFile(
    paths.claudeHooksTarget,
    JSON.stringify({
      model: 'unchanged',
      permissions: { allow: ['Read'] },
      hooks: { SessionStart: [{ hooks: [claudeHook] }], UserPromptSubmit: [{ hooks: [claudeHook] }] },
    })
  )
  assert.deepEqual(await removeLegacyAgentContextHooksAt(paths), [])
  assert.deepEqual(JSON.parse(await readFile(paths.codexHooksTarget, 'utf8')), {
    description: 'My hooks',
    hooks: { Stop: [{ hooks: [unrelated] }], UserPromptSubmit: [{ matcher: '', hooks: [unrelated] }, { hooks: [] }] },
  })
  assert.deepEqual(JSON.parse(await readFile(paths.claudeHooksTarget, 'utf8')), {
    model: 'unchanged',
    permissions: { allow: ['Read'] },
  })
  const removed = await readFile(paths.codexHooksTarget, 'utf8')
  assert.deepEqual(await removeLegacyAgentContextHooksAt(paths), [])
  assert.equal(await readFile(paths.codexHooksTarget, 'utf8'), removed)
})

it('leaves malformed provider configuration untouched while cleaning the other provider', async () => {
  const { paths, command } = await fixture()
  await writeFile(
    paths.codexHooksTarget,
    JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: command('codex') }] }] },
    })
  )
  await writeFile(paths.claudeHooksTarget, '{ invalid configuration')
  const errors = await removeLegacyAgentContextHooksAt(paths)
  assert.equal(errors.length, 1)
  assert.equal(errors[0]?.provider, 'claude')
  assert.deepEqual(JSON.parse(await readFile(paths.codexHooksTarget, 'utf8')), {})
  assert.equal(await readFile(paths.claudeHooksTarget, 'utf8'), '{ invalid configuration')
})

it('does not rewrite unrelated configuration or create missing provider files', async () => {
  const { paths } = await fixture()
  const unrelated =
    '{ "hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": "remember-helper agent-hook"}]}]} }\n'
  await writeFile(paths.codexHooksTarget, unrelated)
  assert.deepEqual(await removeLegacyAgentContextHooksAt(paths), [])
  assert.equal(await readFile(paths.codexHooksTarget, 'utf8'), unrelated)
  await assert.rejects(access(paths.claudeHooksTarget))
})

it('normal CLI maintenance retires hooks even when the command and skills are already up to date', async () => {
  const { paths, command } = await fixture()
  await mkdir(dirname(paths.skillSource), { recursive: true })
  await mkdir(dirname(paths.memorizeSkillSource), { recursive: true })
  await writeFile(paths.commandSource, '#!/bin/sh\necho remember\n')
  await writeFile(paths.skillSource, 'REMEMBER_AGENT={{AGENT_PROVIDER}} remember wiki read\n')
  await writeFile(paths.memorizeSkillSource, 'REMEMBER_AGENT={{AGENT_PROVIDER}} remember wiki write\n')
  assert.equal((await ensureCliAccessAt(paths)).upToDate, true)
  await writeFile(
    paths.codexHooksTarget,
    JSON.stringify({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: command('codex') }] }] },
    })
  )
  assert.equal((await ensureCliAccessAt(paths)).upToDate, true)
  assert.deepEqual(JSON.parse(await readFile(paths.codexHooksTarget, 'utf8')), {})
  assert.equal(await readFile(paths.commandTarget, 'utf8'), '#!/bin/sh\necho remember\n')
  assert.equal(await readFile(paths.codexSkillTarget, 'utf8'), 'REMEMBER_AGENT=codex remember wiki read\n')
  assert.equal(await readFile(paths.claudeMemorizeSkillTarget, 'utf8'), 'REMEMBER_AGENT=claude remember wiki write\n')
})
