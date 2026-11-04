import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'node:test'
import { normalizeAgentComputer, type RemoteAgentComputer } from '@remember/shared'
import { initializeCodexServer } from '../codexAppServer'
import { type CodexRemoteCheckpoint, stopCodexRemoteCheckpoint } from '../codexRemoteRecovery'
import { connectCodexWebSocket } from '../codexWebSocket'
import { runCodexWorker } from '../codexWorker'

// Use the test runner's existing WebSocket server; production uses Node's WebSocket client.
const require = createRequire(import.meta.url)
const { wsServer } = require(join(dirname(require.resolve('playwright-core')), 'lib/utilsBundle.js'))
type Message = { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown }
type Socket = {
  send: (data: string) => void
  terminate: () => void
  on: (event: string, callback: (data: Buffer) => void) => void
}
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

async function fixture(
  handle: (message: Message, socket: Socket, connection: number) => void,
  background: () => unknown[] = () => []
) {
  const host = new wsServer({ host: '127.0.0.1', port: 0 })
  const sockets = new Set<Socket>()
  let connections = 0
  host.on('connection', (socket: Socket) => {
    sockets.add(socket)
    const connection = ++connections
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as Message
      handle(message, socket, connection)
      if (message.method === 'thread/backgroundTerminals/list')
        reply(socket, message, { data: background(), nextCursor: null })
    })
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    host.once('listening', resolve)
    host.once('error', reject)
  })
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.terminate()
        host.close(resolve)
      })
  )
  return {
    kind: 'remote',
    endpoint: `ws://127.0.0.1:${host.address().port}/`,
    workspace: '/Users/ai/Remember Agent/workspace',
  } satisfies RemoteAgentComputer
}

const send = (socket: Socket, message: Message) => socket.send(JSON.stringify(message))
const reply = (socket: Socket, request: Message, result: unknown = {}) => send(socket, { id: request.id, result })
const thread = (turns: unknown[] = []) => ({ id: 'remote-thread', turns, status: { type: 'idle' } })
const finalTurn = {
  id: 'remote-turn',
  status: 'completed',
  items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'Result on the mini' }],
}
function complete(socket: Socket) {
  send(socket, { method: 'item/completed', params: { threadId: 'remote-thread', item: finalTurn.items[0] } })
  send(socket, { method: 'turn/completed', params: { threadId: 'remote-thread', turn: finalTurn } })
}
function options(remote: RemoteAgentComputer) {
  return {
    remote,
    cwd: remote.workspace,
    version: 'test',
    model: 'test',
    effort: 'low',
    prompt: 'A synthetic test request',
    signal: new AbortController().signal,
    onThread: () => {},
    onUsage: () => {},
    onCheckpoint: (_checkpoint: CodexRemoteCheckpoint | null) => {},
    report: () => {},
    ask: async () => ({ id: 'test', action: 'accept' as const, values: {} }),
  }
}

test('remote endpoint validation rejects public hosts, credentials, non-WebSocket URLs and relative workspaces', () => {
  assert.deepEqual(normalizeAgentComputer(undefined), { kind: 'local' })
  assert.equal(
    normalizeAgentComputer({
      kind: 'remote',
      endpoint: 'ws://127.0.0.1:47832',
      workspace: '/Users/ai/Remember Agent/workspace',
    }).kind,
    'remote'
  )
  for (const endpoint of [
    'ws://example.com:80',
    'http://127.0.0.1:123',
    'ws://user:secret@localhost:123',
    'ws://localhost:123/?token=secret',
    'ws://localhost:123/path',
  ]) {
    assert.throws(() => normalizeAgentComputer({ kind: 'remote', endpoint, workspace: '/workspace' }))
  }
  assert.throws(() =>
    normalizeAgentComputer({ kind: 'remote', endpoint: 'ws://localhost:123', workspace: '../workspace' })
  )
})

test('real WebSocket worker streams, handles approvals and never sends local tool paths or process environment', async () => {
  const requests: Message[] = []
  let approval = 0
  const remote = await fixture((message, socket) => {
    requests.push(message)
    if (message.method === 'initialize') reply(socket, message)
    if (message.method === 'thread/read') reply(socket, message, { thread: thread([finalTurn]) })
    if (message.method === 'thread/start') reply(socket, message, { thread: thread() })
    if (message.method === 'turn/start') {
      reply(socket, message, { turn: { id: 'remote-turn' } })
      send(socket, { method: 'turn/started', params: { threadId: 'remote-thread', turn: { id: 'remote-turn' } } })
      send(socket, {
        id: 'approval',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'remote-thread',
          turnId: 'remote-turn',
          itemId: 'command',
          command: 'echo synthetic',
          cwd: remote.workspace,
        },
      })
    }
    if (message.id === 'approval') {
      assert.deepEqual(message.result, { decision: 'accept' })
      complete(socket)
    }
  })
  let checkpoint: CodexRemoteCheckpoint | null = null
  const result = await runCodexWorker({
    ...options(remote),
    ask: async () => {
      approval += 1
      return { id: 'test', action: 'accept', values: {} }
    },
    onCheckpoint: (value: CodexRemoteCheckpoint | null) => {
      checkpoint = value
    },
  })
  assert.equal(result.response, 'Result on the mini')
  assert.equal(approval, 1)
  assert.equal(checkpoint, null)
  const settings = requests.find((request) => request.method === 'thread/start')?.params
  assert.equal(settings?.cwd, remote.workspace)
  assert.deepEqual(settings?.config, { web_search: 'live', 'sandbox_workspace_write.network_access': true })
  assert.equal(JSON.stringify(requests).includes('/Users/jan'), false)
  assert.equal(JSON.stringify(requests).includes('process.env'), false)
})

test('dropped turn/start response keeps a durable checkpoint; explicit recovery reads completed work without replay', async () => {
  let starts = 0
  const remote = await fixture((message, socket) => {
    if (message.method === 'initialize') reply(socket, message)
    if (message.method === 'thread/start') reply(socket, message, { thread: thread() })
    if (message.method === 'turn/start') {
      starts += 1
      socket.terminate()
    }
    if (message.method === 'thread/read') reply(socket, message, { thread: thread([finalTurn]) })
  })
  let checkpoint: CodexRemoteCheckpoint | null = null
  await assert.rejects(
    runCodexWorker({
      ...options(remote),
      onCheckpoint: (value: CodexRemoteCheckpoint | null) => {
        checkpoint = value
      },
    }),
    /remote-recovery-required/
  )
  assert.ok(checkpoint)
  const result = await runCodexWorker({
    ...options(remote),
    recovery: checkpoint,
    onCheckpoint: (value: CodexRemoteCheckpoint | null) => {
      checkpoint = value
    },
  })
  assert.equal(result.response, 'Result on the mini')
  assert.equal(starts, 1)
  assert.equal(checkpoint, null)
})

test('reconnect aborts stale approvals and only accepts a fresh request on the original active turn', async () => {
  let starts = 0
  let asks = 0
  let staleSignal: AbortSignal | undefined
  const active = { id: 'remote-turn', status: 'inProgress', items: [] }
  const remote = await fixture((message, socket, connection) => {
    if (message.method === 'initialize') reply(socket, message)
    if (message.method === 'thread/start') reply(socket, message, { thread: thread() })
    if (message.method === 'turn/start') {
      starts += 1
      reply(socket, message, { turn: active })
      send(socket, { method: 'turn/started', params: { threadId: 'remote-thread', turn: active } })
      send(socket, {
        id: 'old-approval',
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'remote-thread', itemId: 'command', command: 'echo synthetic' },
      })
      setTimeout(() => socket.terminate(), 30)
    }
    if (message.method === 'thread/read') reply(socket, message, { thread: thread([asks >= 2 ? finalTurn : active]) })
    if (message.method === 'thread/resume') {
      assert.equal(connection, 2)
      assert.deepEqual(message.params, { threadId: 'remote-thread' })
      reply(socket, message, { thread: thread([active]) })
      send(socket, {
        id: 'new-approval',
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'remote-thread', itemId: 'command', command: 'echo synthetic' },
      })
    }
    if (message.id === 'new-approval') complete(socket)
    assert.notEqual(message.id, 'old-approval')
  })
  let checkpoint: CodexRemoteCheckpoint | null = null
  await assert.rejects(
    runCodexWorker({
      ...options(remote),
      onCheckpoint: (value: CodexRemoteCheckpoint | null) => {
        checkpoint = value
      },
      ask: (_request, signal) => {
        asks += 1
        staleSignal = signal
        return new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        )
      },
    }),
    /remote-recovery-required/
  )
  assert.equal(staleSignal?.aborted, true)
  const result = await runCodexWorker({
    ...options(remote),
    recovery: checkpoint,
    ask: async () => {
      asks += 1
      return { id: 'test', action: 'accept', values: {} }
    },
  })
  assert.equal(result.response, 'Result on the mini')
  assert.equal(asks, 2)
  assert.equal(starts, 1)
})

test('remote cancellation waits for authoritative stopped state and clears the checkpoint only after confirmation', async () => {
  let status = 'inProgress'
  let reads = 0
  let interrupts = 0
  const abort = new AbortController()
  const remote = await fixture((message, socket) => {
    if (message.method === 'initialize') reply(socket, message)
    if (message.method === 'thread/start') reply(socket, message, { thread: thread() })
    if (message.method === 'turn/start') {
      reply(socket, message, { turn: { id: 'remote-turn' } })
      send(socket, { method: 'turn/started', params: { threadId: 'remote-thread', turn: { id: 'remote-turn' } } })
    }
    if (message.method === 'turn/interrupt') {
      interrupts += 1
      status = 'interrupted'
      reply(socket, message)
    }
    if (message.method === 'thread/read') {
      reads += 1
      reply(socket, message, { thread: thread([{ id: 'remote-turn', status, items: [] }]) })
    }
  })
  let checkpoint: CodexRemoteCheckpoint | null = null
  await assert.rejects(
    runCodexWorker({
      ...options(remote),
      signal: abort.signal,
      onCheckpoint: (value: CodexRemoteCheckpoint | null) => {
        checkpoint = value
      },
      report: (_type, id) => {
        if (id === 'codex-started') abort.abort()
      },
    }),
    /agent-cancelled/
  )
  assert.equal(checkpoint, null)
  assert.equal(interrupts, 1)
  assert.ok(reads > 0)
})

test('lost stop acknowledgement retains recovery state; later explicit stop reconnects without starting work', async () => {
  const methods: string[] = []
  let interrupts = 0
  const remote = await fixture((message, socket) => {
    if (message.method) methods.push(message.method)
    if (message.method === 'initialize') reply(socket, message)
    if (message.method === 'thread/read')
      reply(socket, message, {
        thread: thread([{ id: 'remote-turn', status: interrupts > 1 ? 'interrupted' : 'inProgress', items: [] }]),
      })
    if (message.method === 'turn/interrupt') {
      interrupts += 1
      if (interrupts === 1) socket.terminate()
      else reply(socket, message)
    }
  })
  const checkpoint = { computer: remote, threadId: 'remote-thread', turnId: 'remote-turn', previousTurnId: null }
  await assert.rejects(stopCodexRemoteCheckpoint(checkpoint, 'test'), /remote-(?:disconnected|unavailable)/)
  await stopCodexRemoteCheckpoint(checkpoint, 'test')
  assert.equal(methods.includes('turn/start'), false)
  assert.equal(methods.includes('thread/resume'), false)
})

test('WebSocket close rejects in-flight RPCs and resolved requests cannot send a late approval', async () => {
  let resolved!: () => void
  let aborted = false
  const remote = await fixture((message, socket) => {
    if (message.method === 'initialize') reply(socket, message)
    if (message.method === 'probe') {
      send(socket, { id: 'pending', method: 'approval', params: {} })
      setTimeout(() => {
        send(socket, { method: 'serverRequest/resolved', params: { requestId: 'pending' } })
        setTimeout(() => socket.terminate(), 20)
      }, 20)
    }
    assert.notEqual(message.id, 'pending')
  })
  const server = await connectCodexWebSocket(remote.endpoint, {
    onClose: () => {},
    onNotification: () => {},
    onRequest: (_method, _params, signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true
          resolve({ decision: 'accept' })
          resolved()
        })
      }),
  })
  const approvalResolved = new Promise<void>((resolve) => {
    resolved = resolve
  })
  await initializeCodexServer(server, 'test')
  await assert.rejects(server.request('probe', {}), /remote-(?:disconnected|unavailable)/)
  await approvalResolved
  assert.equal(aborted, true)
  await assert.rejects(server.request('after-close', {}), /closed/)
})

test('remote dynamic tools route through the local client with source results and active-turn identity', async () => {
  const declarations: unknown[] = []
  let calls = 0
  const remote = await fixture((message, socket) => {
    if (message.method === 'initialize') reply(socket, message)
    if (message.method === 'thread/read') reply(socket, message, { thread: thread([finalTurn]) })
    if (message.method === 'thread/start') {
      declarations.push(message.params?.dynamicTools)
      reply(socket, message, { thread: thread() })
    }
    if (message.method === 'turn/start') {
      reply(socket, message, { turn: { id: 'remote-turn' } })
      send(socket, { method: 'turn/started', params: { threadId: 'remote-thread', turn: { id: 'remote-turn' } } })
      send(socket, {
        id: 'client-tool',
        method: 'item/tool/call',
        params: {
          threadId: 'remote-thread',
          turnId: 'remote-turn',
          callId: 'memory-1',
          tool: 'remember_memory',
          arguments: { action: 'read', spaceId: 'personal', slug: 'test' },
        },
      })
    }
    if (message.id === 'client-tool') {
      assert.deepEqual(message.result, {
        success: true,
        contentItems: [
          {
            type: 'inputText',
            text: JSON.stringify({
              revision: 'r1',
              url: '/wiki/page/?space=personal&slug=test',
              content: 'Synthetic remembered decision',
            }),
          },
        ],
      })
      complete(socket)
    }
  })
  const result = await runCodexWorker({
    ...options(remote),
    tools: [
      {
        name: 'remember_memory',
        description: 'Synthetic local memory tool',
        inputSchema: { type: 'object' },
        call: async (input, context) => {
          calls += 1
          assert.deepEqual(input, { action: 'read', spaceId: 'personal', slug: 'test' })
          assert.equal(context.threadId, 'remote-thread')
          assert.equal(context.turnId, 'remote-turn')
          assert.equal(context.callId, 'memory-1')
          assert.equal(context.signal.aborted, false)
          return {
            revision: 'r1',
            url: '/wiki/page/?space=personal&slug=test',
            content: 'Synthetic remembered decision',
          }
        },
      },
    ],
  })
  assert.equal(calls, 1)
  assert.equal(result.response, 'Result on the mini')
  assert.deepEqual(declarations, [
    [
      {
        type: 'function',
        name: 'remember_memory',
        description: 'Synthetic local memory tool',
        inputSchema: { type: 'object' },
      },
    ],
  ])
})

function runningCommand(processId = 'owned-process') {
  return {
    id: 'owned-command',
    type: 'commandExecution',
    source: 'unifiedExecStartup',
    processId,
    status: 'inProgress',
    exitCode: null,
  }
}

test('stop after reconnect terminates only the exact owned turn session, even when that turn is already interrupted', async () => {
  const methods: Message[] = []
  let command = runningCommand() as Record<string, unknown>
  const unrelated = {
    id: 'older-turn',
    status: 'interrupted',
    items: [{ ...runningCommand('other-process'), id: 'other-command' }],
  }
  const remote = await fixture(
    (message, socket) => {
      methods.push(message)
      if (message.method === 'initialize') reply(socket, message)
      if (message.method === 'thread/read')
        reply(socket, message, {
          thread: thread([unrelated, { id: 'remote-turn', status: 'interrupted', items: [command] }]),
        })
      if (message.method === 'thread/backgroundTerminals/terminate') {
        assert.deepEqual(message.params, { threadId: 'remote-thread', processId: 'owned-process' })
        reply(socket, message, { terminated: true })
        command = { ...command, status: 'failed', exitCode: -1 }
      }
    },
    () => [
      { itemId: 'other-command', processId: 'other-process' },
      ...(command.exitCode === null ? [{ itemId: 'owned-command', processId: 'owned-process' }] : []),
    ]
  )
  await stopCodexRemoteCheckpoint(
    { computer: remote, threadId: 'remote-thread', turnId: 'remote-turn', previousTurnId: 'older-turn' },
    'test'
  )
  assert.equal(methods.filter((message) => message.method === 'thread/backgroundTerminals/terminate').length, 1)
  assert.equal(
    methods.some((message) =>
      ['turn/start', 'turn/interrupt', 'process/kill', 'command/exec/terminate'].includes(String(message.method))
    ),
    false
  )
})

test('a terminal notification cannot clear a cancelled checkpoint before its yielded process has actually exited', async () => {
  const abort = new AbortController()
  let turnStatus = 'inProgress'
  let command = runningCommand() as Record<string, unknown>
  let terminated = 0
  const updates: (CodexRemoteCheckpoint | null)[] = []
  let checkpoint: CodexRemoteCheckpoint | null = null
  const remote = await fixture(
    (message, socket) => {
      if (message.method === 'initialize') reply(socket, message)
      if (message.method === 'thread/start') reply(socket, message, { thread: thread() })
      if (message.method === 'turn/start') {
        reply(socket, message, { turn: { id: 'remote-turn' } })
        send(socket, { method: 'turn/started', params: { threadId: 'remote-thread', turn: { id: 'remote-turn' } } })
      }
      if (message.method === 'thread/read')
        reply(socket, message, { thread: thread([{ id: 'remote-turn', status: turnStatus, items: [command] }]) })
      if (message.method === 'turn/interrupt') {
        turnStatus = 'interrupted'
        reply(socket, message)
        send(socket, {
          method: 'turn/completed',
          params: { threadId: 'remote-thread', turn: { id: 'remote-turn', status: 'interrupted', items: [command] } },
        })
      }
      if (message.method === 'thread/backgroundTerminals/terminate') {
        terminated += 1
        assert.deepEqual(message.params, { threadId: 'remote-thread', processId: 'owned-process' })
        assert.equal(updates.includes(null), false, 'Turn completion alone must not clear recovery state')
        if (terminated === 1) socket.terminate()
        else {
          command = { ...command, status: 'failed', exitCode: -1 }
          reply(socket, message, { terminated: true })
        }
      }
    },
    () => (command.exitCode === null ? [{ itemId: 'owned-command', processId: 'owned-process' }] : [])
  )
  await assert.rejects(
    runCodexWorker({
      ...options(remote),
      signal: abort.signal,
      onCheckpoint: (value: CodexRemoteCheckpoint | null) => {
        checkpoint = value
        updates.push(value)
      },
      report: (_type, id) => {
        if (id === 'codex-started') abort.abort()
      },
    }),
    /codex-remote-stop-unconfirmed/
  )
  assert.ok(checkpoint)
  assert.equal(updates.includes(null), false)
  await stopCodexRemoteCheckpoint(checkpoint, 'test')
  assert.equal(terminated, 2)
})

test('a successful terminate acknowledgement without a process exit remains unconfirmed', async () => {
  let terminations = 0
  const remote = await fixture(
    (message, socket) => {
      if (message.method === 'initialize') reply(socket, message)
      if (message.method === 'thread/read')
        reply(socket, message, {
          thread: thread([{ id: 'remote-turn', status: 'interrupted', items: [runningCommand()] }]),
        })
      if (message.method === 'thread/backgroundTerminals/terminate') {
        terminations += 1
        reply(socket, message, { terminated: true })
      }
    },
    () => [{ itemId: 'owned-command', processId: 'owned-process' }]
  )
  await assert.rejects(
    stopCodexRemoteCheckpoint(
      { computer: remote, threadId: 'remote-thread', turnId: 'remote-turn', previousTurnId: null },
      'test'
    ),
    /codex-remote-stop-unconfirmed/
  )
  assert.equal(terminations, 1, 'An unconfirmed process is not repeatedly killed or escalated')
})

test('unsupported process termination fails closed without another command or host process kill', async () => {
  const methods: string[] = []
  const remote = await fixture(
    (message, socket) => {
      if (message.method) methods.push(message.method)
      if (message.method === 'initialize') reply(socket, message)
      if (message.method === 'thread/read')
        reply(socket, message, {
          thread: thread([{ id: 'remote-turn', status: 'interrupted', items: [runningCommand()] }]),
        })
      if (message.method === 'thread/backgroundTerminals/terminate')
        socket.send(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Unsupported method' } }))
    },
    () => [{ itemId: 'owned-command', processId: 'owned-process' }]
  )
  await assert.rejects(
    stopCodexRemoteCheckpoint(
      { computer: remote, threadId: 'remote-thread', turnId: 'remote-turn', previousTurnId: null },
      'test'
    ),
    /Unsupported method/
  )
  assert.deepEqual(
    [...new Set(methods)],
    [
      'initialize',
      'initialized',
      'thread/read',
      'thread/backgroundTerminals/list',
      'thread/backgroundTerminals/terminate',
    ]
  )
})

test('retry of an interrupted turn with a still-running process preserves recovery instead of abandoning or replaying it', async () => {
  const methods: string[] = []
  const remote = await fixture((message, socket) => {
    if (message.method) methods.push(message.method)
    if (message.method === 'initialize') reply(socket, message)
    if (message.method === 'thread/read')
      reply(socket, message, {
        thread: thread([{ id: 'remote-turn', status: 'interrupted', items: [runningCommand()] }]),
      })
  })
  let checkpoint: CodexRemoteCheckpoint | null = {
    computer: remote,
    threadId: 'remote-thread',
    turnId: 'remote-turn',
    previousTurnId: null,
  }
  await assert.rejects(
    runCodexWorker({
      ...options(remote),
      recovery: checkpoint,
      onCheckpoint: (value: CodexRemoteCheckpoint | null) => {
        checkpoint = value
      },
    }),
    /codex-remote-recovery-required/
  )
  assert.ok(checkpoint)
  assert.deepEqual(
    [...new Set(methods)],
    ['initialize', 'initialized', 'thread/read', 'thread/backgroundTerminals/list']
  )
})

test('command ownership survives a disconnect in the durable checkpoint when thread/read omits the running item', async () => {
  let checkpoint: CodexRemoteCheckpoint | null = null
  let stopped = false
  let turnStatus = 'inProgress'
  const methods: string[] = []
  const remote = await fixture(
    (message, socket) => {
      if (message.method) methods.push(message.method)
      if (message.method === 'initialize') reply(socket, message)
      if (message.method === 'thread/start') reply(socket, message, { thread: thread() })
      if (message.method === 'turn/start') {
        reply(socket, message, { turn: { id: 'remote-turn' } })
        send(socket, { method: 'turn/started', params: { threadId: 'remote-thread', turn: { id: 'remote-turn' } } })
        send(socket, {
          method: 'item/started',
          params: { threadId: 'remote-thread', turnId: 'remote-turn', item: runningCommand() },
        })
        setTimeout(() => socket.terminate(), 20)
      }
      if (message.method === 'thread/read')
        reply(socket, message, {
          thread: thread([
            {
              id: 'remote-turn',
              status: turnStatus,
              items: stopped ? [{ ...runningCommand(), status: 'failed', exitCode: -1 }] : [],
            },
          ]),
        })
      if (message.method === 'turn/interrupt') {
        turnStatus = 'interrupted'
        reply(socket, message)
      }
      if (message.method === 'thread/backgroundTerminals/terminate') {
        assert.deepEqual(message.params, { threadId: 'remote-thread', processId: 'owned-process' })
        stopped = true
        reply(socket, message, { terminated: true })
      }
    },
    () => (stopped ? [] : [{ itemId: 'owned-command', processId: 'owned-process' }])
  )
  await assert.rejects(
    runCodexWorker({
      ...options(remote),
      onCheckpoint(value: CodexRemoteCheckpoint | null) {
        checkpoint = value
      },
    }),
    /remote-recovery-required/
  )
  assert.ok(checkpoint)
  assert.deepEqual((checkpoint as CodexRemoteCheckpoint).commandItemIds, ['owned-command'])
  const persisted = JSON.parse(JSON.stringify(checkpoint)) as CodexRemoteCheckpoint
  await stopCodexRemoteCheckpoint(persisted, 'test')
  assert.equal(stopped, true)
  assert.equal(methods.includes('thread/resume'), false)
  assert.equal(methods.filter((method) => method === 'turn/start').length, 1)
})

test('reconnected stop uses thread/resume to recover exact live item ownership absent from disk history', async () => {
  let stopped = false
  let resumes = 0
  const remote = await fixture(
    (message, socket) => {
      if (message.method === 'initialize') reply(socket, message)
      if (message.method === 'thread/read')
        reply(socket, message, {
          thread: thread([
            {
              id: 'remote-turn',
              status: 'interrupted',
              items: stopped ? [{ ...runningCommand(), status: 'failed', exitCode: -1 }] : [],
            },
          ]),
        })
      if (message.method === 'thread/resume') {
        resumes += 1
        reply(socket, message, {
          thread: thread([{ id: 'remote-turn', status: 'interrupted', items: [runningCommand()] }]),
        })
      }
      if (message.method === 'thread/backgroundTerminals/terminate') {
        assert.deepEqual(message.params, { threadId: 'remote-thread', processId: 'owned-process' })
        stopped = true
        reply(socket, message, { terminated: true })
      }
    },
    () => (stopped ? [] : [{ itemId: 'owned-command', processId: 'owned-process' }])
  )
  await stopCodexRemoteCheckpoint(
    { computer: remote, threadId: 'remote-thread', turnId: 'remote-turn', previousTurnId: null },
    'test'
  )
  assert.equal(resumes, 1)
  assert.equal(stopped, true)
})

test('unknown background ownership never authorizes a process termination or a successful stop', async () => {
  const methods: string[] = []
  const remote = await fixture(
    (message, socket) => {
      if (message.method) methods.push(message.method)
      if (message.method === 'initialize') reply(socket, message)
      if (message.method === 'thread/read' || message.method === 'thread/resume')
        reply(socket, message, { thread: thread([{ id: 'remote-turn', status: 'interrupted', items: [] }]) })
    },
    () => [{ itemId: 'unknown-command', processId: 'unowned-process' }]
  )
  await assert.rejects(
    stopCodexRemoteCheckpoint(
      { computer: remote, threadId: 'remote-thread', turnId: 'remote-turn', previousTurnId: null },
      'test'
    ),
    /codex-remote-stop-unconfirmed/
  )
  assert.equal(methods.includes('thread/backgroundTerminals/terminate'), false)
  assert.equal(methods.includes('turn/start'), false)
})

for (const recovering of [false, true]) {
  test(`${recovering ? 'recovery of a' : 'a new'} completed turn retains its checkpoint while an owned background command is still running`, async () => {
    let checkpoint: CodexRemoteCheckpoint | null = recovering
      ? {
          computer: {} as RemoteAgentComputer,
          threadId: 'remote-thread',
          turnId: 'remote-turn',
          previousTurnId: null,
          commandItemIds: ['owned-command'],
        }
      : null
    let starts = 0
    const remote = await fixture(
      (message, socket) => {
        if (message.method === 'initialize') reply(socket, message)
        if (message.method === 'thread/start') reply(socket, message, { thread: thread() })
        if (message.method === 'thread/read') reply(socket, message, { thread: thread([finalTurn]) })
        if (message.method === 'turn/start') {
          starts += 1
          reply(socket, message, { turn: { id: 'remote-turn' } })
          send(socket, { method: 'turn/started', params: { threadId: 'remote-thread', turn: { id: 'remote-turn' } } })
          send(socket, {
            method: 'item/started',
            params: { threadId: 'remote-thread', turnId: 'remote-turn', item: runningCommand() },
          })
          complete(socket)
        }
      },
      () => [{ itemId: 'owned-command', processId: 'owned-process' }]
    )
    if (checkpoint) checkpoint.computer = remote
    await assert.rejects(
      runCodexWorker({
        ...options(remote),
        recovery: checkpoint,
        onCheckpoint(value: CodexRemoteCheckpoint | null) {
          checkpoint = value
        },
      }),
      /codex-remote-recovery-required/
    )
    assert.ok(checkpoint)
    assert.equal(starts, recovering ? 0 : 1)
    assert.deepEqual((checkpoint as CodexRemoteCheckpoint).commandItemIds, ['owned-command'])
  })
}

test('command guard after initialization prevents thread and turn dispatch after permission loss', async () => {
  let valid = true
  const methods: string[] = []
  const remote = await fixture((message, socket) => {
    if (message.method) methods.push(message.method)
    if (message.method === 'initialize') {
      valid = false
      reply(socket, message)
    }
    if (message.method === 'thread/start') reply(socket, message, { thread: thread() })
    if (message.method === 'turn/start') socket.terminate()
  })
  let dispatches = 0
  await assert.rejects(
    runCodexWorker({
      ...options(remote),
      assertCurrent: () => {
        if (!valid) throw new Error('permission-lost')
      },
      onDispatch: () => {
        dispatches++
      },
    }),
    /permission-lost/
  )
  assert.equal(dispatches, 0)
  assert.equal(methods.includes('thread/start'), false)
  assert.equal(methods.includes('turn/start'), false)
})

test('command guard rechecks after thread ACK before turn/start and retains checkpoint', async () => {
  let valid = true
  const methods: string[] = []
  const remote = await fixture((message, socket) => {
    if (message.method) methods.push(message.method)
    if (message.method === 'initialize') reply(socket, message)
    if (message.method === 'thread/start') {
      valid = false
      reply(socket, message, { thread: thread() })
    }
    if (message.method === 'turn/start') socket.terminate()
  })
  let checkpoint: CodexRemoteCheckpoint | null = null
  let dispatches = 0
  await assert.rejects(
    runCodexWorker({
      ...options(remote),
      assertCurrent: () => {
        if (!valid) throw new Error('permission-lost')
      },
      onDispatch: () => {
        dispatches++
      },
      onCheckpoint: (value: CodexRemoteCheckpoint | null) => {
        checkpoint = value
      },
    }),
    /remote-recovery-required/
  )
  assert.equal(dispatches, 1)
  assert.equal(methods.includes('turn/start'), false)
  assert.ok(checkpoint)
})
