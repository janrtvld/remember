import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { createConnection, createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import type { RemoteAgentComputer } from '@remember/shared'
import type { Page } from 'playwright-core'
import { initializeCodexServer } from '../../src/main/codexAppServer'
import { readRemoteThread, remoteTurns, stopCodexRemoteCheckpoint } from '../../src/main/codexRemoteRecovery'
import { connectCodexWebSocket } from '../../src/main/codexWebSocket'
import type { ResidentRemoteRun } from '../../src/main/residentAgentStore'
import { qaRemoteWorkspace, qaSshTarget } from './remoteConfig'

const ssh = promisify(execFile)
const stopButton = /^(Stoppen|Stop)$/
const retryButton = /^(Opnieuw proberen|Try again|Retry)$/

type Options = {
  directory: string
  launch: () => Promise<Page>
  close: () => Promise<void>
  checks: string[]
  endpoint?: string
  workspace?: string
}

type OwnedTurn = {
  filename: string
  marker: string
  instruction: string
  userId: string
  messageId: string
  checkpoint: ResidentRemoteRun
  observedCommandItemIds: string[]
  expectedFinishAfter: number
}

async function ownedProxy(endpoint: string) {
  const target = new URL(endpoint)
  assert.equal(target.protocol, 'ws:')
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
  assert(target.port && !target.username && !target.password)
  const sockets = new Set<Socket>()
  let blocked = false
  const server = createServer((client) => {
    if (blocked) return client.destroy()
    const upstream = createConnection({ host: target.hostname.replace(/^\[|\]$/g, ''), port: Number(target.port) })
    sockets.add(client)
    sockets.add(upstream)
    const closePair = () => {
      client.destroy()
      upstream.destroy()
      sockets.delete(client)
      sockets.delete(upstream)
    }
    client.on('error', closePair).on('close', closePair)
    upstream.on('error', closePair).on('close', closePair)
    client.pipe(upstream).pipe(client)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert(address && typeof address === 'object')
  return {
    endpoint: `ws://127.0.0.1:${address.port}/`,
    block(value: boolean) {
      blocked = value
      if (blocked) for (const socket of sockets) socket.destroy()
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function localState(directory: string) {
  const db = new DatabaseSync(join(directory, 'profile/daily-review/assistant/conversation.sqlite'), { readOnly: true })
  try {
    const row = db.prepare('SELECT checkpoint FROM assistant_remote_run WHERE id = 1').get()
    return {
      checkpoint: row ? (JSON.parse(String(row.checkpoint)) as ResidentRemoteRun) : null,
      threadId: db.prepare("SELECT thread_id FROM assistant_thread WHERE provider = 'codex'").get()?.thread_id,
    }
  } finally {
    db.close()
  }
}

function assertCheckpointProgress(actual: ResidentRemoteRun | null, turn: OwnedTurn) {
  assert(actual, 'The owned remote checkpoint must survive interruption')
  const { commandItemIds: actualIds = [], ...actualIdentity } = actual
  const { commandItemIds: _initialIds, ...expectedIdentity } = turn.checkpoint
  assert.deepEqual(actualIdentity, expectedIdentity, 'Only owned command metadata may change within this turn')
  assert(Array.isArray(actualIds) && actualIds.every((id) => typeof id === 'string' && id.length > 0))
  assert.equal(new Set(actualIds).size, actualIds.length, 'Checkpoint command ownership must not contain duplicates')
  assert.deepEqual(
    actualIds.slice(0, turn.observedCommandItemIds.length),
    turn.observedCommandItemIds,
    'Previously observed command ownership must be retained in order'
  )
  turn.observedCommandItemIds = [...actualIds]
}

async function remoteThread(endpoint: string, threadId: string) {
  const server = await connectCodexWebSocket(endpoint, { onNotification: () => {}, onClose: () => {} })
  try {
    await initializeCodexServer(server, 'native-recovery-qa')
    return await readRemoteThread(server, threadId)
  } finally {
    server.close()
  }
}

function quote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`
}

async function remoteFile(workspace: string, filename: string) {
  assert.match(filename, /^remember-recovery-qa-[a-z0-9-]+\.txt$/)
  const file = quote(`${workspace}/${filename}`)
  const { stdout } = await ssh(
    '/usr/bin/ssh',
    [
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'ConnectTimeout=8',
      qaSshTarget(),
      `if test -f ${file}; then cat ${file}; fi`,
    ],
    { timeout: 15_000, maxBuffer: 16_384 }
  )
  return stdout
}

async function waitFor(check: () => Promise<boolean>, label: string, timeout = 120_000) {
  const deadline = Date.now() + timeout
  while (!(await check())) {
    assert(Date.now() < deadline, label)
    await delay(200)
  }
}

async function conversation(page: Page) {
  const requests = await page.evaluate(() => window.remember.getAgentInteractions())
  assert.equal(requests.length, 0, 'This synthetic shell test never approves an unexpected provider request')
  return page.evaluate(() => window.remember.getAssistantConversation())
}

/** Uses the real Mini through a disposable proxy; the existing SSH tunnel remains untouched. */
export async function residentRecoveryQa({
  directory,
  launch,
  close,
  checks,
  endpoint = 'ws://127.0.0.1:47832/',
  workspace = qaRemoteWorkspace(),
}: Options) {
  assert.equal(workspace, qaRemoteWorkspace(), 'Independent SSH proof is scoped to the configured QA workspace')
  const proxy = await ownedProxy(endpoint)
  const computer: RemoteAgentComputer = { kind: 'remote', endpoint: proxy.endpoint, workspace }
  const proof: Record<string, unknown> = { endpoint, proxyEndpoint: proxy.endpoint, workspace, syntheticOnly: true }
  let page: Page | null = null
  let current: OwnedTurn | null = null
  let pendingInstruction: string | null = null
  let configured = false

  const snapshot = async (name: string) => {
    assert(page)
    const value = { conversation: await conversation(page), local: localState(directory) }
    writeFileSync(join(directory, `resident-recovery-${name}.json`), JSON.stringify(value, null, 2))
    await page.screenshot({ path: join(directory, `resident-recovery-${name}.png`) })
    return value
  }
  const terminal = async () => {
    assert(current)
    const turn = remoteTurns(await remoteThread(endpoint, current.checkpoint.threadId)).find(
      (entry) => entry.id === current?.checkpoint.turnId
    )
    assert(turn, 'The exact owned remote turn must remain inspectable')
    return turn
  }
  const start = async (name: string, seconds: number) => {
    assert(page)
    assert.equal((await conversation(page)).remoteRecoveryRequired, false)
    const nonce = `${Date.now()}-${randomUUID().slice(0, 8)}`
    const filename = `remember-recovery-qa-${name}-${nonce}.txt`
    const marker = `RECOVERY_${nonce}`
    const command = `printf '%s\\n' '${marker}:START' >> '${filename}'; sleep ${seconds}; printf '%s\\n' '${marker}:DONE' >> '${filename}'`
    const instruction = `This is a disposable native recovery test. Run exactly this one shell command once in the current workspace: ${command}\nWait for that same invocation to finish, polling its existing session if needed. Do not repeat the command, create other files, or use other tools. After it finishes, reply briefly.`
    pendingInstruction = instruction
    await page.locator('#assistant-message').fill(instruction)
    await page.locator('#assistant-message').press('Enter')
    let captured: OwnedTurn | null = null
    await waitFor(async () => {
      assert(page)
      const state = await conversation(page)
      const user = state.messages.find((entry) => entry.role === 'user' && entry.text === instruction)
      if (!user) return false
      const assistant = state.messages.findLast((entry) => entry.replyTo === user.id)
      assert(assistant)
      assert(state.activeTurnId, `The new turn stopped before its shell began: ${JSON.stringify(assistant)}`)
      const checkpoint = localState(directory).checkpoint
      if (!checkpoint?.turnId) return false
      assert.equal(checkpoint.messageId, assistant.id)
      captured = {
        filename,
        marker,
        instruction,
        userId: user.id,
        messageId: assistant.id,
        checkpoint,
        observedCommandItemIds: [...(checkpoint.commandItemIds ?? [])],
        expectedFinishAfter: Date.now() + seconds * 1000 + 1000,
      }
      current = captured
      const started = (await remoteFile(workspace, filename)) === `${marker}:START\n`
      if (started) captured.expectedFinishAfter = Date.now() + seconds * 1000 + 1000
      return started
    }, 'The real Mini must start the unique shell invocation before fault injection')
    assert(captured)
    current = captured
    pendingInstruction = null
    assert.equal((await terminal()).status, 'inProgress')
    return current as OwnedTurn
  }

  const assertNoReplay = async (turn: OwnedTurn, expectDone: boolean) => {
    const text = await remoteFile(workspace, turn.filename)
    assert.equal(text, `${turn.marker}:START\n${expectDone ? `${turn.marker}:DONE\n` : ''}`)
    const remote = await remoteThread(endpoint, turn.checkpoint.threadId)
    const matching = remoteTurns(remote).filter((entry) => entry.id === turn.checkpoint.turnId)
    assert.equal(matching.length, 1)
    const items = Array.isArray(matching[0].items) ? matching[0].items : []
    const ownedCommands = items.filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === 'object' && 'type' in item && item.type === 'commandExecution')
    )
    for (const itemId of turn.observedCommandItemIds) {
      const command = ownedCommands.find((item) => item.id === itemId)
      assert(command, `Checkpoint item ${itemId} must belong to the exact owned remote turn`)
      assert.equal(command.source, 'unifiedExecStartup')
      assert(String(command.command).includes(turn.filename) && String(command.command).includes(turn.marker))
    }
    return {
      file: turn.filename,
      contents: text,
      threadId: turn.checkpoint.threadId,
      turnId: turn.checkpoint.turnId,
      status: matching[0].status,
      checkpointCommandItemIds: turn.observedCommandItemIds,
      commands: ownedCommands.map(({ id, processId, source, status, exitCode }) => ({
        id,
        processId,
        source,
        status,
        exitCode,
      })),
    }
  }

  try {
    page = await launch()
    assert.equal((await page.evaluate(() => window.remember.getState())).manualMeeting, null)
    const initial = await conversation(page)
    assert.equal(initial.activeTurnId, null)
    assert.equal(initial.remoteRecoveryRequired, false, 'Do not take ownership of a pre-existing remote checkpoint')
    await page.evaluate(
      (computer) =>
        window.remember.updateSettings({
          agentComputer: computer,
          cloudAnalysisConsent: true,
          offlineMode: false,
          audioCaptureEnabled: false,
          capturePaused: true,
          capturePausedUntil: null,
          capturePauseSources: ['audio', 'capture'],
          liveTaskUpdates: false,
          frequentDayRefresh: false,
          agentLearningEnabled: false,
        }),
      computer
    )
    configured = true
    await page.evaluate(() => window.remember.pauseCapture({ sources: ['audio', 'capture'], durationMs: null }))
    await page.goto(`${new URL(page.url()).origin}/assistant/`)
    await page.locator('#assistant-message').waitFor()
    assert.notEqual((await page.evaluate(() => window.remember.getState())).status, 'recording')

    const recoveryTurn = await start('retry', 25)
    const beforeTurns = remoteTurns(await remoteThread(endpoint, recoveryTurn.checkpoint.threadId)).map(
      (entry) => entry.id
    )
    proxy.block(true)
    await waitFor(
      async () => {
        assert(page)
        return !(await conversation(page)).activeTurnId
      },
      'Disconnect must settle the local worker',
      20_000
    )
    const dropped = await snapshot('disconnected')
    assert.equal(dropped.conversation.messages.at(-1)?.status, 'interrupted')
    assert.equal(dropped.conversation.messages.at(-1)?.error, 'codex-remote-recovery-required')
    assert.equal(dropped.conversation.remoteRecoveryRequired, true)
    assertCheckpointProgress(dropped.local.checkpoint, recoveryTurn)
    await page
      .getByRole('status')
      .filter({ hasText: /(?:verbinding is onderbroken|connection was interrupted)/i })
      .waitFor()
    await page.getByRole('button', { name: stopButton }).waitFor()
    const blockedSend = await page.evaluate(async () => {
      try {
        await window.remember.sendAssistantMessage({ text: 'must-not-be-sent', provider: 'codex' })
        return null
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    })
    assert.match(blockedSend ?? '', /assistant-remote-recovery-required/)
    assert.deepEqual((await conversation(page)).messages, dropped.conversation.messages)
    await close()
    page = null
    page = await launch()
    await page.goto(`${new URL(page.url()).origin}/assistant/`)
    await page.locator('#assistant-message').waitFor()
    const restarted = await snapshot('restart-blocked')
    assert.deepEqual(restarted.conversation.messages, dropped.conversation.messages)
    assert.deepEqual(restarted.local, dropped.local)
    assert.equal(restarted.conversation.remoteRecoveryRequired, true)
    assert.deepEqual((await page.evaluate(() => window.remember.getSettings())).agentComputer, computer)
    assert.notEqual((await page.evaluate(() => window.remember.getState())).status, 'recording')
    await waitFor(
      async () => (await terminal()).status !== 'inProgress',
      'The original disconnected remote turn must finish',
      60_000
    )
    assert.equal(
      (await terminal()).status,
      'completed',
      'A provider-cancelled turn is safe but does not prove completed-turn recovery'
    )
    proxy.block(false)
    await page.getByRole('button', { name: retryButton }).last().click()
    await waitFor(
      async () => {
        assert(page)
        const state = await conversation(page)
        return state.messages.at(-1)?.id !== recoveryTurn.messageId && !state.activeTurnId
      },
      'Retry must recover the original terminal result',
      30_000
    )
    await page.getByRole('button', { name: stopButton }).waitFor({ state: 'hidden' })
    const recovered = await snapshot('recovered')
    assert.equal(recovered.conversation.messages.at(-1)?.status, 'completed')
    assert.equal(recovered.conversation.messages.at(-1)?.replyTo, recoveryTurn.userId)
    assert.equal(
      recovered.conversation.messages.filter((entry) => entry.role === 'user').length,
      dropped.conversation.messages.filter((entry) => entry.role === 'user').length
    )
    assert.equal(recovered.conversation.remoteRecoveryRequired, false)
    assert.equal(recovered.local.checkpoint, null)
    assert.equal(recovered.local.threadId, recoveryTurn.checkpoint.threadId)
    assert.deepEqual(
      remoteTurns(await remoteThread(endpoint, recoveryTurn.checkpoint.threadId)).map((entry) => entry.id),
      beforeTurns,
      'Retry must not create a new remote turn'
    )
    proof.recovery = await assertNoReplay(recoveryTurn, true)
    current = null
    checks.push(
      'Real remote disconnect persists an interrupted checkpoint through full Remember restart; UI Retry recovers the exact original completed turn with one START/DONE and no second remote turn'
    )

    const stoppedTurns: OwnedTurn[] = []
    for (const disconnected of [false, true]) {
      const name = disconnected ? 'stop-disconnected' : 'stop-connected'
      const stoppedTurn = await start(name, 45)
      assertCheckpointProgress(localState(directory).checkpoint, stoppedTurn)
      if (disconnected) {
        proxy.block(true)
        await waitFor(
          async () => {
            assert(page)
            return !(await conversation(page)).activeTurnId
          },
          'Disconnected turn must be recoverable',
          20_000
        )
        await page.getByRole('button', { name: stopButton }).click()
        const stopFailure = page
          .getByRole('alert')
          .filter({ hasText: /(?:kon niet worden gestopt|could not be stopped)/i })
        await stopFailure.waitFor()
        await delay(500)
        assert(
          await stopFailure.isVisible(),
          'A background conversation refresh must not erase an unconfirmed Stop error'
        )
        const unconfirmed = await snapshot('stop-unconfirmed')
        assert.equal(unconfirmed.conversation.remoteRecoveryRequired, true)
        assert.equal(unconfirmed.conversation.messages.at(-1)?.status, 'interrupted')
        assertCheckpointProgress(unconfirmed.local.checkpoint, stoppedTurn)
        proxy.block(false)
      }
      await page.getByRole('button', { name: stopButton }).click()
      await waitFor(
        async () => {
          assert(page)
          const state = await conversation(page)
          return !state.activeTurnId && !state.remoteRecoveryRequired
        },
        'Stop must wait for remote terminal confirmation',
        30_000
      )
      await page.getByRole('button', { name: stopButton }).waitFor({ state: 'hidden' })
      await page
        .getByText(/^(Gestopt|Stopped)$/)
        .nth(disconnected ? 1 : 0)
        .waitFor()
      await page
        .getByRole('alert')
        .filter({ hasText: /(?:kon niet worden gestopt|could not be stopped)/i })
        .waitFor({ state: 'hidden' })
      const stopped = await snapshot(name)
      assert.equal(stopped.conversation.messages.at(-1)?.status, 'cancelled')
      assert.equal(stopped.conversation.messages.at(-1)?.error, null)
      assert.equal(stopped.local.checkpoint, null)
      assert(
        ['interrupted', 'failed'].includes(String((await terminal()).status)),
        'This stop must happen before the synthetic command finishes'
      )
      proof[name] = await assertNoReplay(stoppedTurn, false)
      stoppedTurns.push(stoppedTurn)
      current = null
    }
    const lastDeadline = Math.max(...stoppedTurns.map((turn) => turn.expectedFinishAfter))
    while (Date.now() < lastDeadline) await delay(Math.min(1000, lastDeadline - Date.now()))
    proof.stoppedCommandsAfterOriginalDeadlines = await Promise.all(
      stoppedTurns.map((turn) => assertNoReplay(turn, false))
    )
    checks.push(
      'Connected and disconnected-then-reconnected UI Stop wait for the exact Mini turn to terminate before clearing its checkpoint; independent SSH still shows one START and no DONE after both original shell deadlines'
    )
    proof.fullNativeRestart = true
    proof.existingTunnelUntouched = true
    proof.captureAndAudioDisabled = true
    proof.boundary =
      'Live native IPC and UI, a disposable loopback proxy, actual Mini shell, remote thread history and independent SSH readback. No production profile or tunnel service changed.'
    writeFileSync(join(directory, 'resident-recovery-proof.json'), JSON.stringify(proof, null, 2))
  } catch (error) {
    const failure: Record<string, unknown> = { error: error instanceof Error ? error.message : String(error) }
    const owned = current as OwnedTurn | null
    proxy.block(false)
    try {
      let ownsPending = false
      if (!owned && pendingInstruction && page && !page.isClosed()) {
        const state = await page.evaluate(() => window.remember.getAssistantConversation())
        const checkpoint = localState(directory).checkpoint
        const assistant = state.messages.find((entry) => entry.id === checkpoint?.messageId)
        const user = state.messages.find((entry) => entry.id === assistant?.replyTo)
        if (checkpoint && user?.text === pendingInstruction) {
          ownsPending = true
          await stopCodexRemoteCheckpoint(
            { ...checkpoint, computer: { kind: 'remote', endpoint, workspace } },
            'native-recovery-cleanup'
          )
          failure.exactPendingTurnStopped = { threadId: checkpoint.threadId, turnId: checkpoint.turnId }
        }
      } else if (owned) {
        ownsPending = true
        await stopCodexRemoteCheckpoint(
          { ...owned.checkpoint, computer: { kind: 'remote', endpoint, workspace } },
          'native-recovery-cleanup'
        )
        failure.exactOwnedTurnStopped = { threadId: owned.checkpoint.threadId, turnId: owned.checkpoint.turnId }
      }
      if (ownsPending && page && !page.isClosed()) await page.evaluate(() => window.remember.cancelAssistantTurn())
    } catch (cleanupError) {
      failure.cleanupError = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      failure.remainingOwnedCheckpoint = owned?.checkpoint ?? null
    }
    writeFileSync(join(directory, 'resident-recovery-failure.json'), JSON.stringify(failure, null, 2))
    throw error
  } finally {
    try {
      if (configured && page && !page.isClosed()) {
        const state = await page.evaluate(() => window.remember.getAssistantConversation()).catch(() => null)
        if (state && !state.activeTurnId && !state.remoteRecoveryRequired) {
          await page.evaluate(
            (computer) => window.remember.updateSettings({ agentComputer: computer, offlineMode: true }),
            { kind: 'remote', endpoint, workspace } as RemoteAgentComputer
          )
        }
      }
    } finally {
      await proxy.close()
    }
  }
}
