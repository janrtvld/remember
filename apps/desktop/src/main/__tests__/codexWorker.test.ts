import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { createAgentInteractions } from '../agentInteractions'
import { createCodexAppServer, initializeCodexServer } from '../codexAppServer'
import { runCodexWorker } from '../codexWorker'
import { answerCodexWorkerRequest } from '../codexWorkerRequests'
import { installedCodexWorkerTools } from '../codexWorkerTools'

const directories: string[] = []
function directory() {
  const root = mkdtempSync(path.join(tmpdir(), 'remember-worker-test-'))
  directories.push(root)
  return root
}
afterEach(() => {
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fakeServer(body: string) {
  const root = directory()
  const executable = path.join(root, 'codex')
  writeFileSync(
    executable,
    `#!/usr/bin/env node\nconst lines = require('node:readline').createInterface({input: process.stdin});\nconst send = message => process.stdout.write(JSON.stringify(message)+'\\n');\nlines.on('line', line => {const message = JSON.parse(line); ${body} });\n`,
    { mode: 0o700 }
  )
  return { root, executable }
}

test('App Server handles string-id server requests and rejects calls after close', async () => {
  const fixture = fakeServer(`if(message.method === 'initialize') send({id:message.id,result:{}});
    if(message.method === 'probe') {global.probe = message.id;send({id:'approval-1',method:'approval',params:{command:'echo synthetic'}})}
    if(message.id === 'approval-1') send({id:global.probe,result:message.result});`)
  const server = createCodexAppServer({
    executable: fixture.executable,
    cwd: fixture.root,
    env: process.env,
    onNotification: () => {},
    onClose: () => {},
    onRequest: async (method, params) => {
      assert.equal(method, 'approval')
      assert.deepEqual(params, { command: 'echo synthetic' })
      return { decision: 'decline' }
    },
  })
  try {
    await initializeCodexServer(server, 'test')
    assert.deepEqual(await server.request('probe', {}), { decision: 'decline' })
  } finally {
    server.close()
  }
  await assert.rejects(server.request('after-close', {}), /closed/)
})

test('Worker resumes through App Server, saves thread before turn, streams and records only last-turn usage', async () => {
  const fixture = fakeServer(`
    if(message.method === 'initialize') send({id:message.id,result:{}});
    if(message.method === 'thread/resume') { if(message.params.threadId !== 'thread-1') process.exit(2);send({id:message.id,result:{thread:{id:'thread-1'}}}) }
    if(message.method === 'turn/start') {
      send({id:message.id,result:{turn:{id:'turn-2'}}});
      send({method:'turn/started',params:{threadId:'thread-1',turn:{id:'turn-2'}}});
      send({method:'item/agentMessage/delta',params:{threadId:'thread-1',itemId:'answer',delta:'Verified'}});
      send({method:'item/completed',params:{threadId:'thread-1',item:{id:'answer',type:'agentMessage',phase:'final_answer',text:'Verified result'}}});
      send({method:'thread/tokenUsage/updated',params:{threadId:'thread-1',tokenUsage:{last:{inputTokens:10,cachedInputTokens:2,outputTokens:3},total:{inputTokens:1000}}}});
      send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-2',status:'completed'}}});
    }`)
  const events: string[] = []
  const usage: unknown[] = []
  const result = await runCodexWorker({
    executable: fixture.executable,
    env: process.env,
    cwd: fixture.root,
    providerHome: fixture.root,
    version: 'test',
    model: 'test',
    effort: 'low',
    prompt: 'test',
    threadId: 'thread-1',
    signal: new AbortController().signal,
    onThread: (id) => events.push(id),
    report: (_type, _id, text) => events.push(text),
    onUsage: (value) => usage.push(value),
    ask: async () => {
      throw new Error('unexpected approval')
    },
  })
  assert.deepEqual(result, { response: 'Verified result', threadId: 'thread-1' })
  assert.ok(events.indexOf('thread-1') < events.indexOf('Verified'))
  assert.deepEqual(usage, [{ input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 }])
})

test('Worker interruption terminates a stalled turn', async () => {
  const fixture = fakeServer(`if(message.method === 'initialize') send({id:message.id,result:{}});
    if(message.method === 'thread/start') send({id:message.id,result:{thread:{id:'thread-1'}}});
    if(message.method === 'turn/start') {send({id:message.id,result:{}});send({method:'turn/started',params:{threadId:'thread-1',turn:{id:'turn-1'}}})}
    if(message.method === 'turn/interrupt') send({id:message.id,result:{}});`)
  const abort = new AbortController()
  await assert.rejects(
    runCodexWorker({
      executable: fixture.executable,
      env: process.env,
      cwd: fixture.root,
      providerHome: fixture.root,
      version: 'test',
      model: 'test',
      effort: 'low',
      prompt: 'test',
      signal: abort.signal,
      onThread: () => {},
      onUsage: () => {},
      report: (_type, id) => {
        if (id === 'codex-started') abort.abort()
      },
      ask: async () => {
        throw new Error('unexpected approval')
      },
    }),
    /cancelled/
  )
})

test('permission decisions are scoped to the provider request and declined grants stay empty', async () => {
  const permissions = { network: { enabled: true } }
  const ask = async () => ({ id: 'request', action: 'accept' as const, values: { permissions: 'extra access' } })
  assert.deepEqual(await answerCodexWorkerRequest('item/permissions/requestApproval', { permissions }, ask), {
    permissions,
    scope: 'turn',
  })
  assert.deepEqual(
    await answerCodexWorkerRequest('item/permissions/requestApproval', { permissions }, async () => ({
      id: 'request',
      action: 'decline',
      values: {},
    })),
    { permissions: {}, scope: 'turn' }
  )
  await assert.rejects(answerCodexWorkerRequest('unknown', {}, ask), /Unsupported/)
  await assert.rejects(
    answerCodexWorkerRequest(
      'mcpServer/elicitation/request',
      { mode: 'form', requestedSchema: { type: 'object', properties: { nested: { type: 'object' } } } },
      ask
    ),
    /not supported/
  )
})

test('interaction answers cannot be replayed and abort clears pending requests', async () => {
  const interactions = createAgentInteractions(() => {})
  const abort = new AbortController()
  const request = {
    turnId: 'turn-1',
    title: 'Question',
    detail: '',
    fields: [{ id: 'answer', label: 'Answer', required: true }],
    actions: [{ id: 'accept' as const, label: 'Answer' }],
  }
  const promise = interactions.ask(request, abort.signal)
  const id = interactions.list()[0].id
  assert.throws(() => interactions.answer({ id, action: 'accept', values: {} }), /required/)
  const answer = { id, action: 'accept', values: { answer: 'yes' } }
  interactions.answer(answer)
  assert.deepEqual(await promise, answer)
  assert.throws(() => interactions.answer(answer), /expired/)
  const cancelled = interactions.ask(request, abort.signal)
  abort.abort()
  await assert.rejects(cancelled, /cancelled/)
  assert.deepEqual(interactions.list(), [])
})

test('installed OpenAI tools resolve current launchers without loading unrelated plugins', () => {
  const root = directory()
  assert.deepEqual(installedCodexWorkerTools(root), {})
  const dir = path.join(root, 'plugins/cache/openai-bundled/unified-computer-use/2.0')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'launcher'), '')
  writeFileSync(
    path.join(dir, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        cua_repl: {
          command: './launcher',
          env: {
            TEST: 'yes',
            BROWSER_USE_AVAILABLE_BACKENDS: 'chrome,iab',
            CUA_REPL_ENABLED_SURFACES: 'browser,computer',
          },
        },
        unrelated: { command: '/bin/sh' },
      },
    })
  )
  const tools = installedCodexWorkerTools(root)
  assert.deepEqual(Object.keys(tools), ['cua_repl'])
  assert.equal(tools.cua_repl.command, path.join(dir, 'launcher'))
  assert.equal(tools.cua_repl.env?.CODEX_HOME, root)
  assert.equal(tools.cua_repl.env?.BROWSER_USE_AVAILABLE_BACKENDS, 'chrome')
  assert.equal(tools.cua_repl.env?.CUA_REPL_ENABLED_SURFACES, 'browser,computer')
})

test('provider resolution cancels the corresponding pending interaction', async () => {
  const fixture = fakeServer(`if(message.method==='initialize') send({id:message.id,result:{}});
    if(message.method==='probe') {send({id:'question',method:'question',params:{}});setTimeout(()=>{send({method:'serverRequest/resolved',params:{requestId:'question'}});send({id:message.id,result:{}})},20)}`)
  const interactions = createAgentInteractions(() => {})
  const server = createCodexAppServer({
    executable: fixture.executable,
    cwd: fixture.root,
    env: process.env,
    onClose: () => {},
    onNotification: () => {},
    onRequest: (_method, _params, signal) =>
      interactions.ask(
        { turnId: 'turn', title: 'Question', detail: '', fields: [], actions: [{ id: 'accept', label: 'Accept' }] },
        signal
      ),
  })
  try {
    await initializeCodexServer(server, 'test')
    await server.request('probe', {})
    assert.deepEqual(interactions.list(), [])
  } finally {
    server.close()
  }
})

test('Worker streams commentary and indexed summaries as progress, never as the final answer', async () => {
  const fixture = fakeServer(`
    if(message.method === 'initialize') send({id:message.id,result:{}});
    if(message.method === 'thread/start') send({id:message.id,result:{thread:{id:'thread-1'}}});
    if(message.method === 'turn/start') {
      if(message.params.summary !== 'auto') process.exit(2);
      send({id:message.id,result:{turn:{id:'turn-1'}}});
      const notify = (method, extra) => send({method,params:{threadId:'thread-1',turnId:'turn-1',...extra}});
      notify('item/started',{item:{id:'update',type:'agentMessage',phase:'commentary',text:''}});
      notify('item/agentMessage/delta',{itemId:'update',delta:'Ik vergelijk '});
      notify('item/agentMessage/delta',{itemId:'update',delta:'de bronnen.'});
      notify('item/completed',{item:{id:'update',type:'agentMessage',phase:'commentary',text:'Ik vergelijk de bronnen.'}});
      notify('item/reasoning/summaryTextDelta',{itemId:'reason',summaryIndex:0,delta:'Bronnen lezen.'});
      notify('item/reasoning/summaryTextDelta',{itemId:'reason',summaryIndex:1,delta:'Verschillen '});
      notify('item/reasoning/summaryTextDelta',{itemId:'reason',summaryIndex:1,delta:'controleren.'});
      notify('item/completed',{item:{id:'reason',type:'reasoning',summary:['Bronnen lezen.','Verschillen controleren.'],content:['PRIVATE RAW REASONING']}});
      notify('item/completed',{item:{id:'snapshot',type:'reasoning',summary:['Conclusie toetsen.'],content:[]}});
      notify('item/completed',{item:{id:'answer',type:'agentMessage',phase:'final_answer',text:'Het resultaat.'}});
      notify('turn/completed',{turn:{id:'turn-1',status:'completed'}});
    }
  `)
  const updates: Array<{ type: string; id: string; text: string }> = []
  const result = await runCodexWorker({
    executable: fixture.executable,
    env: process.env,
    cwd: fixture.root,
    providerHome: fixture.root,
    version: 'test',
    model: 'test',
    effort: 'low',
    prompt: 'test',
    signal: new AbortController().signal,
    onThread: () => {},
    onUsage: () => {},
    report: (type, id, text) => updates.push({ type, id, text }),
    ask: async () => {
      throw new Error('unexpected approval')
    },
  })
  assert.equal(result.response, 'Het resultaat.')
  assert.deepEqual(
    updates.filter((event) => event.type === 'response').map((event) => event.text),
    ['Het resultaat.']
  )
  assert.ok(updates.some((event) => event.type === 'reasoning' && event.text === 'Ik vergelijk '))
  assert.ok(updates.some((event) => event.id === 'reason:summary:1' && event.text === 'Verschillen controleren.'))
  assert.ok(updates.some((event) => event.id === 'snapshot:summary:0' && event.text === 'Conclusie toetsen.'))
  assert.ok(updates.every((event) => !event.text.includes('PRIVATE RAW REASONING')))
})
