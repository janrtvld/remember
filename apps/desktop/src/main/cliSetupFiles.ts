import { constants } from 'node:fs'
import { access, chmod, copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import type { CliSetupStatus } from '@remember/shared'

export interface CliSetupPaths {
  commandSource: string
  skillSource: string
  memorizeSkillSource: string
  commandDirectory: string
  commandTarget: string
  codexSkillTarget: string
  claudeSkillTarget: string
  codexMemorizeSkillTarget: string
  claudeMemorizeSkillTarget: string
  codexLegacyTellRememberSkillTarget: string
  claudeLegacyTellRememberSkillTarget: string
  codexLegacyMemoizeSkillTarget: string
  claudeLegacyMemoizeSkillTarget: string
  codexHooksTarget: string
  claudeHooksTarget: string
}

export function resolveCliSetupPaths(homeDirectory: string, resourcesDirectory: string): CliSetupPaths {
  const commandDirectory = join(homeDirectory, '.local', 'bin')
  return {
    commandSource: join(resourcesDirectory, 'remember'),
    skillSource: join(resourcesDirectory, 'remember-skill', 'SKILL.md'),
    memorizeSkillSource: join(resourcesDirectory, 'memorize-skill', 'SKILL.md'),
    commandDirectory,
    commandTarget: join(commandDirectory, 'remember'),
    codexSkillTarget: join(homeDirectory, '.codex', 'skills', 'remember', 'SKILL.md'),
    claudeSkillTarget: join(homeDirectory, '.claude', 'skills', 'remember', 'SKILL.md'),
    codexMemorizeSkillTarget: join(homeDirectory, '.codex', 'skills', 'memorize', 'SKILL.md'),
    claudeMemorizeSkillTarget: join(homeDirectory, '.claude', 'skills', 'memorize', 'SKILL.md'),
    codexLegacyTellRememberSkillTarget: join(homeDirectory, '.codex', 'skills', 'tell-remember', 'SKILL.md'),
    claudeLegacyTellRememberSkillTarget: join(homeDirectory, '.claude', 'skills', 'tell-remember', 'SKILL.md'),
    codexLegacyMemoizeSkillTarget: join(homeDirectory, '.codex', 'skills', 'memoize', 'SKILL.md'),
    claudeLegacyMemoizeSkillTarget: join(homeDirectory, '.claude', 'skills', 'memoize', 'SKILL.md'),
    codexHooksTarget: join(homeDirectory, '.codex', 'hooks.json'),
    claudeHooksTarget: join(homeDirectory, '.claude', 'settings.json'),
  }
}

async function fileMatches(source: string, target: string): Promise<boolean> {
  try {
    const [sourceContents, targetContents] = await Promise.all([readFile(source), readFile(target)])
    return sourceContents.equals(targetContents)
  } catch {
    return false
  }
}

function renderSkill(contents: string, provider: 'codex' | 'claude', command?: string) {
  const rendered = contents.replaceAll('{{AGENT_PROVIDER}}', provider)
  return command
    ? rendered.replaceAll('"$HOME/.local/bin/remember"', `'${command.replaceAll("'", "'\\''")}'`)
    : rendered
}

async function skillMatches(source: string, target: string, provider: 'codex' | 'claude') {
  try {
    const [sourceContents, targetContents] = await Promise.all([readFile(source, 'utf8'), readFile(target, 'utf8')])
    if (renderSkill(sourceContents, provider) !== targetContents) return false
    for (const name of await skillReferences(source)) {
      const original = await readFile(join(dirname(source), 'references', name), 'utf8')
      const installed = await readFile(join(dirname(target), 'references', name), 'utf8')
      if (renderSkill(original, provider) !== installed) return false
    }
    return true
  } catch {
    return false
  }
}

async function skillReferences(source: string): Promise<string[]> {
  try {
    return (await readdir(join(dirname(source), 'references'), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function isSkillInstalled(path: string): Promise<boolean> {
  try {
    return (await readFile(path, 'utf8')).trim().length > 0
  } catch {
    return false
  }
}

function isDirectoryOnPath(directory: string, pathValue: string | undefined): boolean {
  return (pathValue ?? '').split(delimiter).some((entry) => entry === directory)
}

export async function getCliSetupStatusAt(paths: CliSetupPaths, pathValue = process.env.PATH): Promise<CliSetupStatus> {
  const [
    commandMatches,
    commandExecutable,
    codexRememberSkillInstalled,
    claudeRememberSkillInstalled,
    codexMemorizeSkillInstalled,
    claudeMemorizeSkillInstalled,
    codexRememberSkillMatches,
    claudeRememberSkillMatches,
    codexMemorizeSkillMatches,
    claudeMemorizeSkillMatches,
  ] = await Promise.all([
    fileMatches(paths.commandSource, paths.commandTarget),
    isExecutable(paths.commandTarget),
    isSkillInstalled(paths.codexSkillTarget),
    isSkillInstalled(paths.claudeSkillTarget),
    isSkillInstalled(paths.codexMemorizeSkillTarget),
    isSkillInstalled(paths.claudeMemorizeSkillTarget),
    skillMatches(paths.skillSource, paths.codexSkillTarget, 'codex'),
    skillMatches(paths.skillSource, paths.claudeSkillTarget, 'claude'),
    skillMatches(paths.memorizeSkillSource, paths.codexMemorizeSkillTarget, 'codex'),
    skillMatches(paths.memorizeSkillSource, paths.claudeMemorizeSkillTarget, 'claude'),
  ])
  const commandInstalled = commandExecutable
  const codexSkillInstalled = codexRememberSkillInstalled && codexMemorizeSkillInstalled
  const claudeSkillInstalled = claudeRememberSkillInstalled && claudeMemorizeSkillInstalled
  return {
    installed: commandInstalled && codexSkillInstalled && claudeSkillInstalled,
    upToDate:
      commandInstalled &&
      commandMatches &&
      codexRememberSkillMatches &&
      claudeRememberSkillMatches &&
      codexMemorizeSkillMatches &&
      claudeMemorizeSkillMatches,
    commandInstalled,
    codexSkillInstalled,
    claudeSkillInstalled,
    commandPath: paths.commandTarget,
    pathAvailable: isDirectoryOnPath(paths.commandDirectory, pathValue),
    error: null,
  }
}

async function installFile(source: string, target: string, mode?: number): Promise<void> {
  await access(source, constants.R_OK)
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.remember-installing`
  await rm(temporary, { force: true })
  await copyFile(source, temporary)
  if (mode != null) await chmod(temporary, mode)
  await rename(temporary, target)
}

export async function installSkill(source: string, target: string, provider: 'codex' | 'claude', command?: string) {
  for (const name of await skillReferences(source)) {
    const reference = join(dirname(target), 'references', name)
    await mkdir(dirname(reference), { recursive: true })
    const contents = renderSkill(await readFile(join(dirname(source), 'references', name), 'utf8'), provider, command)
    await writeFile(`${reference}.remember-installing`, contents, 'utf8')
    await rename(`${reference}.remember-installing`, reference)
  }
  const contents = renderSkill(await readFile(source, 'utf8'), provider, command)
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.remember-installing`
  await rm(temporary, { force: true })
  await writeFile(temporary, contents, 'utf8')
  await rename(temporary, target)
}

async function removeLegacyWriteSkills(paths: CliSetupPaths) {
  await Promise.all([
    rm(paths.codexLegacyTellRememberSkillTarget, { force: true }),
    rm(paths.claudeLegacyTellRememberSkillTarget, { force: true }),
    rm(paths.codexLegacyMemoizeSkillTarget, { force: true }),
    rm(paths.claudeLegacyMemoizeSkillTarget, { force: true }),
  ])
}

export async function installCliAccessAt(paths: CliSetupPaths): Promise<CliSetupStatus> {
  await Promise.all([
    installFile(paths.commandSource, paths.commandTarget, 0o755),
    installSkill(paths.skillSource, paths.codexSkillTarget, 'codex'),
    installSkill(paths.skillSource, paths.claudeSkillTarget, 'claude'),
    installSkill(paths.memorizeSkillSource, paths.codexMemorizeSkillTarget, 'codex'),
    installSkill(paths.memorizeSkillSource, paths.claudeMemorizeSkillTarget, 'claude'),
  ])
  await removeLegacyWriteSkills(paths)
  await retireAgentContextHooks(paths)
  return getCliSetupStatusAt(paths)
}

export async function ensureCliAccessAt(paths: CliSetupPaths): Promise<CliSetupStatus> {
  const status = await getCliSetupStatusAt(paths)
  if (status.upToDate) {
    await removeLegacyWriteSkills(paths)
    await retireAgentContextHooks(paths)
    return status
  }
  return installCliAccessAt(paths)
}

const CONTEXT_EVENTS = ['SessionStart', 'UserPromptSubmit'] as const

function removeOwnedContextHooks(configuration: unknown, command: string) {
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration))
    throw new Error('invalid-hooks-configuration')
  const record = configuration as Record<string, unknown>
  if (record.hooks === undefined) return record
  if (!record.hooks || typeof record.hooks !== 'object' || Array.isArray(record.hooks))
    throw new Error('invalid-hooks-configuration')
  const hooks = { ...(record.hooks as Record<string, unknown>) }
  let changed = false
  for (const event of CONTEXT_EVENTS) {
    const groups = hooks[event]
    if (groups === undefined) continue
    if (!Array.isArray(groups)) throw new Error('invalid-hooks-event')
    const next = groups.flatMap((group: unknown) => {
      if (!group || typeof group !== 'object' || !('hooks' in group) || !Array.isArray(group.hooks))
        throw new Error('invalid-hooks-group')
      const retained = group.hooks.filter(
        (hook: unknown) =>
          !hook ||
          typeof hook !== 'object' ||
          !('type' in hook) ||
          hook.type !== 'command' ||
          !('command' in hook) ||
          hook.command !== command
      )
      if (retained.length === group.hooks.length) return [group]
      changed = true
      return retained.length ? [{ ...group, hooks: retained }] : []
    })
    if (next.length) hooks[event] = next
    else delete hooks[event]
  }
  if (!changed) return record
  const updated = { ...record, hooks } as Record<string, unknown>
  if (!Object.keys(hooks).length) delete updated.hooks
  return updated
}

export async function removeLegacyAgentContextHooksAt(paths: CliSetupPaths) {
  const errors: Array<{ provider: 'codex' | 'claude'; error: string }> = []
  for (const provider of ['codex', 'claude'] as const) {
    const target = provider === 'codex' ? paths.codexHooksTarget : paths.claudeHooksTarget
    try {
      const source = await readFile(target, 'utf8')
      const configuration: unknown = JSON.parse(source)
      const quoted = `'${paths.commandTarget.replaceAll("'", "'\\''")}'`
      const updated = removeOwnedContextHooks(configuration, `${quoted} agent-hook --provider ${provider}`)
      if (updated === configuration) continue
      if ((await readFile(target, 'utf8')) !== source) throw new Error('hooks-configuration-changed')
      const temporary = `${target}.remember-installing`
      await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      errors.push({ provider, error: error instanceof Error ? error.message : 'hooks-unavailable' })
    }
  }
  return errors
}

async function retireAgentContextHooks(paths: CliSetupPaths) {
  for (const { provider, error } of await removeLegacyAgentContextHooksAt(paths))
    console.warn(`[cli-setup] Could not remove retired ${provider} hooks: ${error}`)
}
