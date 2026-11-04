import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { getClaudeMcpSetupStatusAt, installClaudeMcpAt, resolveClaudeMcpSetupPaths } from '../claudeMcpSetupFiles'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'remember-claude-mcp-'))
  temporaryDirectories.push(home)
  const command = join(home, '.local', 'bin', 'remember')
  await mkdir(join(home, '.local', 'bin'), { recursive: true })
  await writeFile(command, '#!/bin/sh\n')
  await chmod(command, 0o755)
  const paths = resolveClaudeMcpSetupPaths(home, command)
  await mkdir(dirname(paths.config), { recursive: true })
  return paths
}

describe('Claude MCP setup files', () => {
  it('adds Remember while preserving the rest of Claude config', async () => {
    const paths = await setup()
    await writeFile(
      paths.config,
      JSON.stringify({ theme: 'dark', mcpServers: { paper: { command: '/Applications/Paper.app/paper' } } })
    )

    const status = await installClaudeMcpAt(paths)
    const config = JSON.parse(await readFile(paths.config, 'utf8'))

    assert.equal(status.connected, true)
    assert.deepEqual(config.mcpServers.paper, { command: '/Applications/Paper.app/paper' })
    assert.deepEqual(config.mcpServers.remember, { command: paths.command, args: ['mcp'] })
    assert.equal(config.theme, 'dark')
    assert.equal((await stat(paths.config)).mode & 0o777, 0o600)
  })

  it('migrates the stale Claude Code registration to Claude Desktop', async () => {
    const paths = await setup()
    await writeFile(
      paths.legacyCodeConfig,
      JSON.stringify({
        theme: 'dark',
        mcpServers: { remember: { type: 'stdio', command: paths.command, args: ['mcp'] } },
      })
    )

    const status = await installClaudeMcpAt(paths)
    const desktopConfig = JSON.parse(await readFile(paths.config, 'utf8'))
    const codeConfig = JSON.parse(await readFile(paths.legacyCodeConfig, 'utf8'))

    assert.equal(status.connected, true)
    assert.deepEqual(desktopConfig.mcpServers.remember, { command: paths.command, args: ['mcp'] })
    assert.deepEqual(codeConfig, { theme: 'dark', mcpServers: {} })
  })

  it('is idempotent for the installed Remember server', async () => {
    const paths = await setup()
    assert.equal((await installClaudeMcpAt(paths)).connected, true)
    assert.equal((await installClaudeMcpAt(paths)).connected, true)
  })

  it('does not overwrite an existing Remember server', async () => {
    const paths = await setup()
    const original = { mcpServers: { remember: { type: 'http', url: 'http://127.0.0.1:9999/mcp' } } }
    await writeFile(paths.config, JSON.stringify(original))

    const status = await installClaudeMcpAt(paths)

    assert.equal(status.conflict, true)
    assert.deepEqual(JSON.parse(await readFile(paths.config, 'utf8')), original)
  })

  it('does not remove a different Claude Code server on conflict', async () => {
    const paths = await setup()
    const desktopConfig = { mcpServers: { remember: { command: '/another/remember', args: ['mcp'] } } }
    const codeConfig = { mcpServers: { remember: { command: '/custom/remember', args: ['serve'] } } }
    await writeFile(paths.config, JSON.stringify(desktopConfig))
    await writeFile(paths.legacyCodeConfig, JSON.stringify(codeConfig))

    const status = await installClaudeMcpAt(paths)

    assert.equal(status.conflict, true)
    assert.deepEqual(JSON.parse(await readFile(paths.legacyCodeConfig, 'utf8')), codeConfig)
  })

  it('rejects malformed config without replacing it', async () => {
    const paths = await setup()
    await writeFile(paths.config, '{ broken')

    await assert.rejects(installClaudeMcpAt(paths))
    assert.equal(await readFile(paths.config, 'utf8'), '{ broken')
  })

  it('adds a scoped development server without touching production or Claude Code', async () => {
    const paths = { ...(await setup()), serverName: 'remember-dev', dataDirectory: '/isolated/tom/daily-review' }
    paths.command = '/isolated/tom/bin/remember'
    const production = { command: '/Users/jan/.local/bin/remember', args: ['mcp'] }
    const originalCode = JSON.stringify({ mcpServers: { remember: production } })
    await writeFile(paths.config, JSON.stringify({ theme: 'dark', mcpServers: { remember: production } }))
    await writeFile(paths.legacyCodeConfig, originalCode)

    assert.equal((await installClaudeMcpAt(paths)).connected, true)
    assert.equal((await installClaudeMcpAt(paths)).connected, true)
    const config = JSON.parse(await readFile(paths.config, 'utf8'))
    assert.deepEqual(config.mcpServers.remember, production)
    assert.deepEqual(config.mcpServers['remember-dev'], {
      command: paths.command,
      args: ['mcp'],
      env: { REMEMBER_DATA_DIR: paths.dataDirectory },
    })
    assert.equal(config.theme, 'dark')
    assert.equal(await readFile(paths.legacyCodeConfig, 'utf8'), originalCode)
  })

  it('does not overwrite another development profile', async () => {
    const paths = { ...(await setup()), serverName: 'remember-dev', dataDirectory: '/isolated/tom/daily-review' }
    const original = {
      mcpServers: {
        'remember-dev': {
          command: '/isolated/jan/bin/remember',
          args: ['mcp'],
          env: { REMEMBER_DATA_DIR: '/isolated/jan/daily-review' },
        },
      },
    }
    await writeFile(paths.config, JSON.stringify(original))

    assert.equal((await installClaudeMcpAt(paths)).conflict, true)
    assert.deepEqual(JSON.parse(await readFile(paths.config, 'utf8')), original)
  })

  it('reports a disabled or mismatched-profile server as a conflict', async () => {
    const paths = { ...(await setup()), dataDirectory: '/isolated/tom/daily-review' }
    for (const extra of [{ disabled: true }, { env: { REMEMBER_DATA_DIR: '/another/daily-review' } }]) {
      await writeFile(
        paths.config,
        JSON.stringify({ mcpServers: { remember: { command: paths.command, args: ['mcp'], ...extra } } })
      )
      const status = await getClaudeMcpSetupStatusAt(paths)
      assert.equal(status.connected, false)
      assert.equal(status.conflict, true)
    }
  })
})
