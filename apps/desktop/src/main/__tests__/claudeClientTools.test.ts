import assert from 'node:assert/strict'
import { type TestContext, test } from 'node:test'
import { createClaudeClientToolServer } from '../claudeClientTools'
import type { CodexClientTool } from '../codexClientTools'

type RpcResponse = {
  id: number
  result?: {
    isError?: boolean
    content?: { type: string; text: string }[]
    tools?: { name: string; inputSchema: { additionalProperties?: boolean } }[]
  }
  error?: { message: string }
}

async function fixture(
  t: TestContext,
  options: { abort?: boolean; abortDuringCall?: boolean; revokeDuringCall?: boolean } = {}
) {
  const controller = new AbortController()
  let current = true
  const calls: Parameters<CodexClientTool['call']>[] = []
  const definition: CodexClientTool = {
    name: 'remember_data',
    description: 'Read only the selected permitted source.',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['read'] } },
      required: ['action'],
      additionalProperties: false,
    },
    async call(input, context) {
      calls.push([input, context])
      if (options.revokeDuringCall) current = false
      if (options.abortDuringCall) controller.abort(new Error('agent-cancelled'))
      return { text: 'private-result' }
    },
  }
  const client = createClaudeClientToolServer([definition], {
    turnId: 'turn-1',
    threadId: () => 'session-1',
    signal: controller.signal,
    assertCurrent: () => {
      if (!current) throw new Error('assistant-context-changed')
    },
  })
  t.after(() => client.server.instance.close())
  const pending = new Map<number, (response: RpcResponse) => void>()
  const transport: Parameters<typeof client.server.instance.server.connect>[0] = {
    async start() {},
    async close() {},
    async send(message) {
      const response = JSON.parse(JSON.stringify(message)) as RpcResponse
      if (typeof response.id === 'number') {
        pending.get(response.id)?.(response)
        pending.delete(response.id)
      }
    },
  }
  await client.server.instance.server.connect(transport)
  let id = 0
  const request = (method: string, params: Record<string, unknown>) => {
    const requestId = ++id
    const response = new Promise<RpcResponse>((resolve) => pending.set(requestId, resolve))
    assert(transport.onmessage)
    transport.onmessage({ jsonrpc: '2.0', id: requestId, method, params })
    return response
  }
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'remember-test', version: '1' },
  })
  transport.onmessage?.({ jsonrpc: '2.0', method: 'notifications/initialized' })
  if (options.abort) controller.abort(new Error('agent-cancelled'))
  return { ...client, calls, request }
}

test('Claude exposes only the supplied scoped tools and preserves their strict input schema', async (t) => {
  const f = await fixture(t)
  assert.deepEqual(f.allowedTools, ['mcp__remember__remember_data'])
  const listed = await f.request('tools/list', {})
  assert.deepEqual(
    listed.result?.tools?.map(({ name }) => name),
    ['remember_data']
  )
  assert.equal(listed.result?.tools?.[0].inputSchema.additionalProperties, false)
  const valid = await f.request('tools/call', { name: 'remember_data', arguments: { action: 'read' } })
  assert.equal(valid.result?.isError, undefined)
  assert.deepEqual(JSON.parse(valid.result?.content?.[0].text ?? ''), { text: 'private-result' })
  assert.equal(f.calls.length, 1)
  assert.deepEqual(f.calls[0]?.[0], { action: 'read' })
  assert.equal(f.calls[0]?.[1].threadId, 'session-1')
  assert.equal(f.calls[0]?.[1].turnId, 'turn-1')
  assert.equal(f.calls[0]?.[1].signal.aborted, false)
})

test('invalid or unknown tool requests cannot reach the Remember validator or side effects', async (t) => {
  const f = await fixture(t)
  for (const arguments_ of [{ action: 'write' }, { action: 3 }, { action: 'read', extra: 'ignored?' }]) {
    const response = await f.request('tools/call', { name: 'remember_data', arguments: arguments_ })
    assert(response.error || response.result?.isError)
  }
  const unknown = await f.request('tools/call', { name: 'Bash', arguments: { command: 'anything' } })
  assert(unknown.error || unknown.result?.isError)
  assert.equal(f.calls.length, 0)
})

test('an aborted turn cannot enter a tool call', async (t) => {
  const f = await fixture(t, { abort: true })
  const response = await f.request('tools/call', { name: 'remember_data', arguments: { action: 'read' } })
  assert.equal(response.result?.isError, true)
  assert.match(response.result?.content?.[0].text ?? '', /agent-cancelled/)
  assert.equal(f.calls.length, 0)
})

test('context revocation during a tool read withholds its result', async (t) => {
  const f = await fixture(t, { revokeDuringCall: true })
  const response = await f.request('tools/call', { name: 'remember_data', arguments: { action: 'read' } })
  assert.equal(response.result?.isError, true)
  assert.equal(response.result?.content?.[0].text, 'assistant-context-changed')
  assert.equal(JSON.stringify(response).includes('private-result'), false)
  assert.equal(f.calls.length, 1)
})

test('cancellation reaches an in-flight tool and withholds its late result', async (t) => {
  const f = await fixture(t, { abortDuringCall: true })
  const response = await f.request('tools/call', { name: 'remember_data', arguments: { action: 'read' } })
  assert.equal(response.result?.isError, true)
  assert.match(response.result?.content?.[0].text ?? '', /agent-cancelled/)
  assert.equal(JSON.stringify(response).includes('private-result'), false)
  assert.equal(f.calls[0]?.[1].signal.aborted, true)
})
