import assert from 'node:assert/strict'
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { ensureCliAccessAt, getCliSetupStatusAt, installCliAccessAt, resolveCliSetupPaths } from '../cliSetupFiles'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('CLI setup files', () => {
  it('installs the command and provider-aware skills for Codex and Claude', async () => {
    const root = await mkdtemp(join(tmpdir(), 'remember-cli-setup-'))
    temporaryDirectories.push(root)
    const home = join(root, 'home')
    const resources = join(root, 'resources')
    await mkdir(join(resources, 'remember-skill'), { recursive: true })
    await mkdir(join(resources, 'memorize-skill'), { recursive: true })
    await writeFile(join(resources, 'remember'), '#!/bin/sh\necho remember\n')
    await chmod(join(resources, 'remember'), 0o755)
    await writeFile(
      join(resources, 'remember-skill', 'SKILL.md'),
      'REMEMBER_AGENT={{AGENT_PROVIDER}} remember status\n'
    )
    await writeFile(
      join(resources, 'memorize-skill', 'SKILL.md'),
      'REMEMBER_AGENT={{AGENT_PROVIDER}} remember wiki write\n'
    )
    const paths = resolveCliSetupPaths(home, resources)
    await mkdir(join(resources, 'remember-skill', 'references'))
    await writeFile(join(resources, 'remember-skill', 'references', 'requests.md'), 'Provider {{AGENT_PROVIDER}}')

    const before = await getCliSetupStatusAt(paths, paths.commandDirectory)
    assert.equal(before.installed, false)

    const after = await installCliAccessAt(paths)
    assert.equal(after.installed, true)
    assert.equal(after.upToDate, true)
    assert.equal(after.commandInstalled, true)
    assert.equal(after.codexSkillInstalled, true)
    assert.equal(after.claudeSkillInstalled, true)
    await access(paths.commandTarget)
    assert.equal(await readFile(paths.codexSkillTarget, 'utf8'), 'REMEMBER_AGENT=codex remember status\n')
    assert.equal(await readFile(paths.claudeSkillTarget, 'utf8'), 'REMEMBER_AGENT=claude remember status\n')
    assert.equal(await readFile(paths.codexMemorizeSkillTarget, 'utf8'), 'REMEMBER_AGENT=codex remember wiki write\n')
    assert.equal(await readFile(paths.claudeMemorizeSkillTarget, 'utf8'), 'REMEMBER_AGENT=claude remember wiki write\n')
    const reference = join(home, '.codex', 'skills', 'remember', 'references', 'requests.md')
    assert.equal(await readFile(reference, 'utf8'), 'Provider codex')
    await rm(reference)
    assert.equal((await getCliSetupStatusAt(paths)).upToDate, false)
    await ensureCliAccessAt(paths)
    assert.equal(await readFile(reference, 'utf8'), 'Provider codex')
  })

  it('keeps access installed when a development build replaces the bundled command or skills', async () => {
    const root = await mkdtemp(join(tmpdir(), 'remember-cli-status-'))
    temporaryDirectories.push(root)
    const home = join(root, 'home')
    const resources = join(root, 'resources')
    const paths = resolveCliSetupPaths(home, resources)
    await mkdir(join(resources, 'remember-skill'), { recursive: true })
    await mkdir(join(resources, 'memorize-skill'), { recursive: true })
    await mkdir(paths.commandDirectory, { recursive: true })
    await writeFile(paths.commandSource, 'current')
    await writeFile(paths.skillSource, 'skill')
    await writeFile(paths.memorizeSkillSource, 'memorize skill')
    await installCliAccessAt(paths)
    await writeFile(paths.commandTarget, 'old')
    await chmod(paths.commandTarget, 0o755)

    const status = await getCliSetupStatusAt(paths)
    assert.equal(status.commandInstalled, true)
    assert.equal(status.installed, true)
    assert.equal(status.upToDate, false)

    assert.equal((await ensureCliAccessAt(paths)).upToDate, true)
    assert.equal(await readFile(paths.commandTarget, 'utf8'), 'current')

    await writeFile(paths.codexSkillTarget, 'updated development skill')
    const changedSkill = await getCliSetupStatusAt(paths)
    assert.equal(changedSkill.installed, true)
    assert.equal(changedSkill.upToDate, false)
    assert.equal((await ensureCliAccessAt(paths)).upToDate, true)
    assert.equal(await readFile(paths.codexSkillTarget, 'utf8'), 'skill')

    await chmod(paths.commandTarget, 0o644)
    const notExecutable = await getCliSetupStatusAt(paths)
    assert.equal(notExecutable.commandInstalled, false)
    assert.equal(notExecutable.installed, false)
    assert.equal(notExecutable.upToDate, false)
    assert.equal((await ensureCliAccessAt(paths)).upToDate, true)

    await writeFile(paths.codexSkillTarget, ' ')
    assert.equal((await getCliSetupStatusAt(paths)).installed, false)
    await rm(paths.claudeSkillTarget)
    assert.equal((await getCliSetupStatusAt(paths)).claudeSkillInstalled, false)
    assert.equal((await ensureCliAccessAt(paths)).upToDate, true)
  })

  it('updates existing CLI access after an app upgrade', async () => {
    const root = await mkdtemp(join(tmpdir(), 'remember-cli-update-'))
    temporaryDirectories.push(root)
    const home = join(root, 'home')
    const resources = join(root, 'resources')
    const paths = resolveCliSetupPaths(home, resources)
    await mkdir(join(resources, 'remember-skill'), { recursive: true })
    await mkdir(join(resources, 'memorize-skill'), { recursive: true })
    await mkdir(paths.commandDirectory, { recursive: true })
    await writeFile(paths.commandSource, 'current command')
    await writeFile(paths.skillSource, 'current {{AGENT_PROVIDER}} skill')
    await writeFile(paths.memorizeSkillSource, 'current {{AGENT_PROVIDER}} memorize skill')
    await writeFile(paths.commandTarget, 'old command')
    await chmod(paths.commandTarget, 0o755)

    const status = await ensureCliAccessAt(paths)

    assert.equal(status.installed, true)
    assert.equal(await readFile(paths.commandTarget, 'utf8'), 'current command')
    assert.equal(await readFile(paths.codexSkillTarget, 'utf8'), 'current codex skill')
    assert.equal(await readFile(paths.claudeSkillTarget, 'utf8'), 'current claude skill')
    assert.equal(await readFile(paths.codexMemorizeSkillTarget, 'utf8'), 'current codex memorize skill')
    assert.equal(await readFile(paths.claudeMemorizeSkillTarget, 'utf8'), 'current claude memorize skill')
  })

  it('upgrades an existing read-only setup with the memorize skill', async () => {
    const root = await mkdtemp(join(tmpdir(), 'remember-cli-memorize-skill-'))
    temporaryDirectories.push(root)
    const home = join(root, 'home')
    const resources = join(root, 'resources')
    const paths = resolveCliSetupPaths(home, resources)
    await mkdir(join(resources, 'remember-skill'), { recursive: true })
    await mkdir(join(resources, 'memorize-skill'), { recursive: true })
    await mkdir(paths.commandDirectory, { recursive: true })
    await mkdir(join(home, '.codex', 'skills', 'remember'), { recursive: true })
    await mkdir(join(home, '.claude', 'skills', 'remember'), { recursive: true })
    await writeFile(paths.commandSource, 'current command')
    await writeFile(paths.skillSource, 'current {{AGENT_PROVIDER}} skill')
    await writeFile(paths.memorizeSkillSource, 'current {{AGENT_PROVIDER}} memorize skill')
    await writeFile(paths.commandTarget, 'current command')
    await chmod(paths.commandTarget, 0o755)
    await writeFile(paths.codexSkillTarget, 'current codex skill')
    await writeFile(paths.claudeSkillTarget, 'current claude skill')

    assert.equal((await getCliSetupStatusAt(paths)).installed, false)

    const status = await ensureCliAccessAt(paths)
    assert.equal(status.installed, true)
    assert.equal(await readFile(paths.codexMemorizeSkillTarget, 'utf8'), 'current codex memorize skill')
    assert.equal(await readFile(paths.claudeMemorizeSkillTarget, 'utf8'), 'current claude memorize skill')
  })

  it('replaces the previously bundled tell-remember and memoize skills with memorize', async () => {
    const root = await mkdtemp(join(tmpdir(), 'remember-cli-memorize-migration-'))
    temporaryDirectories.push(root)
    const home = join(root, 'home')
    const resources = join(root, 'resources')
    const paths = resolveCliSetupPaths(home, resources)
    await mkdir(join(resources, 'remember-skill'), { recursive: true })
    await mkdir(join(resources, 'memorize-skill'), { recursive: true })
    await mkdir(paths.commandDirectory, { recursive: true })
    await mkdir(join(home, '.codex', 'skills', 'remember'), { recursive: true })
    await mkdir(join(home, '.claude', 'skills', 'remember'), { recursive: true })
    await mkdir(join(home, '.codex', 'skills', 'tell-remember'), { recursive: true })
    await mkdir(join(home, '.claude', 'skills', 'tell-remember'), { recursive: true })
    await mkdir(join(home, '.codex', 'skills', 'memoize'), { recursive: true })
    await mkdir(join(home, '.claude', 'skills', 'memoize'), { recursive: true })
    await writeFile(paths.commandSource, 'current command')
    await writeFile(paths.skillSource, 'current {{AGENT_PROVIDER}} skill')
    await writeFile(paths.memorizeSkillSource, 'current {{AGENT_PROVIDER}} memorize skill')
    await writeFile(paths.commandTarget, 'current command')
    await chmod(paths.commandTarget, 0o755)
    await writeFile(paths.codexSkillTarget, 'current codex skill')
    await writeFile(paths.claudeSkillTarget, 'current claude skill')
    await writeFile(paths.codexLegacyTellRememberSkillTarget, 'old codex tell skill')
    await writeFile(paths.claudeLegacyTellRememberSkillTarget, 'old claude tell skill')
    await writeFile(paths.codexLegacyMemoizeSkillTarget, 'old codex memoize skill')
    await writeFile(paths.claudeLegacyMemoizeSkillTarget, 'old claude memoize skill')

    const status = await ensureCliAccessAt(paths)

    assert.equal(status.installed, true)
    assert.equal(await readFile(paths.codexMemorizeSkillTarget, 'utf8'), 'current codex memorize skill')
    assert.equal(await readFile(paths.claudeMemorizeSkillTarget, 'utf8'), 'current claude memorize skill')
    await assert.rejects(access(paths.codexLegacyTellRememberSkillTarget))
    await assert.rejects(access(paths.claudeLegacyTellRememberSkillTarget))
    await assert.rejects(access(paths.codexLegacyMemoizeSkillTarget))
    await assert.rejects(access(paths.claudeLegacyMemoizeSkillTarget))

    await writeFile(paths.codexLegacyTellRememberSkillTarget, 'old codex tell skill')
    await writeFile(paths.claudeLegacyTellRememberSkillTarget, 'old claude tell skill')
    await writeFile(paths.codexLegacyMemoizeSkillTarget, 'old codex memoize skill')
    await writeFile(paths.claudeLegacyMemoizeSkillTarget, 'old claude memoize skill')
    assert.equal((await ensureCliAccessAt(paths)).installed, true)
    await assert.rejects(access(paths.codexLegacyTellRememberSkillTarget))
    await assert.rejects(access(paths.claudeLegacyTellRememberSkillTarget))
    await assert.rejects(access(paths.codexLegacyMemoizeSkillTarget))
    await assert.rejects(access(paths.claudeLegacyMemoizeSkillTarget))
  })

  it('installs CLI access automatically on first start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'remember-cli-automatic-'))
    temporaryDirectories.push(root)
    const home = join(root, 'home')
    const resources = join(root, 'resources')
    const paths = resolveCliSetupPaths(home, resources)
    await mkdir(join(resources, 'remember-skill'), { recursive: true })
    await mkdir(join(resources, 'memorize-skill'), { recursive: true })
    await writeFile(paths.commandSource, 'current command')
    await writeFile(paths.skillSource, 'current skill')
    await writeFile(paths.memorizeSkillSource, 'current memorize skill')

    const status = await ensureCliAccessAt(paths)

    assert.equal(status.installed, true)
    await access(paths.commandTarget)
    await access(paths.codexSkillTarget)
    await access(paths.claudeSkillTarget)
    await access(paths.codexMemorizeSkillTarget)
    await access(paths.claudeMemorizeSkillTarget)
  })
})
