import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import type { AssistantConversation } from '@remember/shared'
import type { Page } from 'playwright-core'
import { qaRemoteWorkspace, qaSshTarget } from './remoteConfig'
import { residentMemoryAfterRestartQa, residentMemoryQa } from './residentMemory'

function remoteFile(name: string) {
  const workspace = qaRemoteWorkspace()
  assert.match(name, /^remember-native-qa-[0-9]+\.txt$/)
  const result = spawnSync(
    '/usr/bin/ssh',
    [
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'ConnectTimeout=8',
      qaSshTarget(),
      `cat '${`${workspace}/${name}`.replace(/'/g, "'\\''")}'`,
    ],
    { encoding: 'utf8', timeout: 15_000 }
  )
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

function providerThread(directory: string) {
  const db = new DatabaseSync(join(directory, 'profile/daily-review/assistant/conversation.sqlite'), { readOnly: true })
  try {
    return db.prepare("SELECT thread_id FROM assistant_thread WHERE provider = 'codex'").get()?.thread_id
  } finally {
    db.close()
  }
}

async function finishTurn(page: Page): Promise<AssistantConversation> {
  const deadline = Date.now() + 150_000
  while (true) {
    const state = await page.evaluate(() => window.remember.getAssistantConversation())
    if (!state.activeTurnId) {
      assert.equal(state.messages.at(-1)?.status, 'completed', JSON.stringify(state.messages.at(-1)))
      assert.equal(state.execution, 'remote')
      assert.equal(state.remoteRecoveryRequired, false)
      return state
    }
    const requests = await page.evaluate(() => window.remember.getAgentInteractions())
    assert.equal(requests.length, 0, `Unexpected provider approval requires review: ${JSON.stringify(requests)}`)
    assert(Date.now() < deadline, 'The real remote turn must complete')
    await delay(250)
  }
}

export async function agentComputerSettingsQa(page: Page, directory: string) {
  const workspace = qaRemoteWorkspace()
  const initial = (await page.evaluate(() => window.remember.getSettings())).agentComputer
  await page.goto(`${new URL(page.url()).origin}/agent/`)
  const edit = page.getByRole('button', { name: 'Change agent computer', exact: true })
  await edit.click()
  const form = page.getByRole('form', { name: 'Set up agent computer', exact: true })
  await form.getByRole('button', { name: 'Run on', exact: true }).click()
  await page.getByRole('option', { name: 'Remote computer', exact: true }).click()
  await page.getByLabel('Local connection address', { exact: true }).fill('ws://example.com:47831/')
  await page.getByLabel('Working folder on the remote computer', { exact: true }).fill(workspace)
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await form.getByRole('alert').waitFor()
  assert.equal(await page.locator('#agent-computer-endpoint').getAttribute('aria-invalid'), 'true')
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'agent-computer-endpoint')
  assert.deepEqual((await page.evaluate(() => window.remember.getSettings())).agentComputer, initial)
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  await page.setViewportSize({ width: 720, height: 800 })
  await form.scrollIntoViewIfNeeded()
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'The settings form must fit a narrow window'
  )
  await page.screenshot({ path: join(directory, 'agent-computer-error-narrow.png') })
  await form.getByRole('button', { name: 'Cancel', exact: true }).click()
  await form.waitFor({ state: 'hidden' })
  assert.deepEqual((await page.evaluate(() => window.remember.getSettings())).agentComputer, initial)
  await edit.click()
  await form.getByRole('button', { name: 'Run on', exact: true }).click()
  await page.getByRole('option', { name: 'Remote computer', exact: true }).click()
  await page.getByLabel('Local connection address', { exact: true }).fill('ws://127.0.0.1:47832/')
  await page.getByLabel('Working folder on the remote computer', { exact: true }).fill(workspace)
  await page.screenshot({ path: join(directory, 'agent-computer-form-narrow.png') })
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByText('Agent computer saved.', { exact: true }).waitFor()
  assert.deepEqual((await page.evaluate(() => window.remember.getSettings())).agentComputer, {
    kind: 'remote',
    endpoint: 'ws://127.0.0.1:47832/',
    workspace,
  })
  await page.setViewportSize(viewport)
  await page.screenshot({ path: join(directory, 'agent-computer-saved.png') })
}

export async function residentRemoteQa(options: {
  directory: string
  launch: () => Promise<Page>
  close: () => Promise<void>
  checks: string[]
}) {
  const { directory, launch, close, checks } = options
  const workspace = qaRemoteWorkspace()
  let page = await launch()
  await page.evaluate(() =>
    window.remember.updateSettings({
      offlineMode: false,
      cloudAnalysisConsent: true,
      liveTaskUpdates: false,
      frequentDayRefresh: false,
      audioCaptureEnabled: false,
      capturePaused: true,
    })
  )
  await agentComputerSettingsQa(page, directory)
  checks.push(
    'Agent computer settings validate, preserve settings on Cancel, save through IPC, and fit a narrow native window'
  )
  const filename = `remember-native-qa-${Date.now()}.txt`
  const marker = `REMEMBER_NATIVE_REMOTE_${Date.now()}`
  const origin = new URL(page.url()).origin
  await page.goto(`${origin}/assistant/`)
  const composer = page.locator('#assistant-message')
  await composer.fill(
    `Use a real shell tool in the current workspace to create ${filename} containing exactly ${marker} followed by a newline. Read it back using the shell. Do nothing else. Reply briefly.`
  )
  await composer.press('Enter')
  await page.waitForFunction(() =>
    window.remember.getAssistantConversation().then((value) => value.messages.length >= 2)
  )
  const before = await finishTurn(page)
  assert.equal(remoteFile(filename), `${marker}\n`, 'Independent SSH must verify the tool result on the Mac mini')
  const thread = providerThread(directory)
  assert.equal(typeof thread, 'string')
  await page.screenshot({ path: join(directory, 'remote-completed.png') })
  await close()
  page = await launch()
  await page.goto(`${new URL(page.url()).origin}/assistant/`)
  await page.locator('#assistant-message').waitFor()
  assert.deepEqual((await page.evaluate(() => window.remember.getAssistantConversation())).messages, before.messages)
  assert.equal(providerThread(directory), thread)
  await page
    .locator('#assistant-message')
    .fill(
      `Read ${filename} from the previous turn using a real shell tool. Append exactly RESTART_OK followed by a newline, once. Read it back. Do nothing else.`
    )
  await page.locator('#assistant-message').press('Enter')
  await page.waitForFunction(() =>
    window.remember
      .getAssistantConversation()
      .then((value) => value.messages.filter((message) => message.role === 'user').length === 2)
  )
  const after = await finishTurn(page)
  assert.equal(providerThread(directory), thread, 'The real remote provider thread must resume after native restart')
  assert.equal(remoteFile(filename), `${marker}\nRESTART_OK\n`)
  await page.screenshot({ path: join(directory, 'remote-after-restart.png') })
  writeFileSync(
    join(directory, 'remote-proof.json'),
    JSON.stringify(
      {
        computer: qaSshTarget(),
        workspace,
        filename,
        thread,
        nativeComposer: true,
        actualRemoteShell: true,
        independentSshReadback: true,
        fullNativeRestart: true,
        sameRemoteThread: true,
        persistedMessages: after.messages.length,
        boundary:
          'Live Codex on the Mac mini through the real SSH tunnel and native Remember IPC. Synthetic instructions and disposable QA context; no production capture or accounts changed.',
      },
      null,
      2
    )
  )
  checks.push(
    'Real native composer executes a shell task on the Mac mini; SSH confirms the file; full Remember restart resumes the same remote thread and file'
  )
  await residentMemoryQa({ page, directory, checks })
  await close()
  page = await launch()
  await residentMemoryAfterRestartQa({ page, directory, checks })
  await page.evaluate(() => window.remember.updateSettings({ offlineMode: true }))
}
