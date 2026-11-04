import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  type BriefingExecution,
  type BriefingSpec,
  hashBriefingText,
  hashBriefingValue,
} from '../../../../../experiments/always-on-agent/briefing-protocol.mjs'
import { createBriefingExecutor } from '../briefingExecutor'

const usage = {
  input_tokens: 10,
  output_tokens: 10,
  cached_input_tokens: 0,
  reasoning_output_tokens: 0,
  cache_write_input_tokens: 0,
}
const line = { text: 'Done', quotes: [{ sourceId: 's1', quote: 'Atlas is done.' }] }
const answer = JSON.stringify({ version: 1, kind: 'silent', reason: line, briefing: null })
const warnings = [
  'Under-development features enabled: skip_host_skill_discovery. Under-development features are incomplete and may behave unpredictably.',
  'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed.',
]
function setup(mode = 'valid', duration = 3000) {
  const root = mkdtempSync(path.join(tmpdir(), 'brief-exec-'))
  mkdirSync(path.join(root, 'auth'))
  writeFileSync(path.join(root, 'auth', 'auth.json'), '{}')
  const executable = path.join(root, 'fake-codex.mjs')
  writeFileSync(
    executable,
    `#!${process.execPath}\nimport{appendFileSync}from'node:fs';let input='';for await(const c of process.stdin)input+=c;appendFileSync(process.env.TRACE,JSON.stringify({pid:process.pid,argv:process.argv.slice(2),input})+'\\n');const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');if(['warnings','warning-only','warning-large'].includes(process.env.MODE)){for(const [i,message]of ${JSON.stringify(warnings)}.entries())emit({type:'item.completed',item:{id:'warning-'+i,type:'error',message:process.env.MODE==='warning-large'?'x'.repeat(2049):message}})}emit({type:'thread.started',thread_id:'actual-fixture-thread'});if(process.env.MODE==='warning-only')process.exit(0);if(process.env.MODE==='failed'){emit({type:'turn.failed',error:{message:'fixture failure'}});process.exit(0)}if(process.env.MODE==='top-error'){emit({type:'error',message:'fixture failure'});process.exit(0)}if(process.env.MODE==='held'){setInterval(()=>{},1000)}else{if(process.env.MODE==='tool')emit({type:'item.completed',item:{id:'bad',type:'command_execution',command:'echo not-run',status:'completed',aggregated_output:'',exit_code:0}});if(process.env.MODE==='many')for(let i=0;i<513;i++)emit({type:'item.updated',item:{id:'r',type:'reasoning',text:'x'}});emit({type:'item.completed',item:{id:'a',type:'agent_message',text:process.env.MODE==='large'?'x'.repeat(17000):${JSON.stringify(answer)}}});if(process.env.MODE!=='incomplete')emit({type:'turn.completed',usage:${JSON.stringify(usage)}})}\n`,
    { mode: 0o700 }
  )
  const packet = { sources: [{ sourceId: 's1', text: 'Atlas is done.', revision: hashBriefingText('Atlas is done.') }] }
  const spec: BriefingSpec = {
    version: 1,
    preparedInput: {
      prompt: JSON.stringify(packet),
      systemPrompt: 'Only synthesize permitted context.',
      model: 'gpt-5.6-luna',
      effort: 'low',
      threadId: null,
      tools: [],
      maxInputBytes: 49152,
      maxOutputBytes: 16384,
      maxDurationMs: duration,
    },
    sourcePacketHash: hashBriefingValue(packet),
    deadlineAt: 1,
    outputBasename: 'briefing.md',
    workspace: path.join(root, 'workspace'),
  }
  const executor = createBriefingExecutor({
    runtimeDirectory: path.join(root, 'runtime'),
    executable,
    env: { ...process.env, CODEX_HOME: path.join(root, 'auth'), TRACE: path.join(root, 'trace.jsonl'), MODE: mode },
  })
  const observations: BriefingExecution[] = []
  const controller = new AbortController()
  return {
    root,
    spec,
    executor,
    controller,
    observations,
    run: () =>
      executor.run(spec, { signal: controller.signal, onExecution: (e) => observations.push(structuredClone(e)) }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}
test('real SDK fixture records actual CLI PID/exit, exact prompt, tools disabled', async () => {
  const f = setup()
  try {
    const result = await f.run()
    assert.equal(result.rawOutput, answer)
    assert.equal(result.execution.providerThreadId, 'actual-fixture-thread')
    assert.equal(result.execution.exit?.code, 0)
    assert.ok(result.execution.pid)
    process.kill(result.execution.pid!, 0)
    assert.fail('fixture must have exited')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e
    const trace = JSON.parse(readFileSync(path.join(f.root, 'trace.jsonl'), 'utf8'))
    assert.equal(trace.input, f.spec.preparedInput.systemPrompt + '\n' + f.spec.preparedInput.prompt)
    assert.equal(f.observations.at(-1)?.pid, trace.pid)
    const args = trace.argv.join(' ')
    assert.match(args, /shell_tool=false/)
    assert.match(args, /network_access=false/)
    assert.match(args, /--sandbox read-only/)
    assert.equal(f.observations.at(-1)?.exit?.code, 0)
  } finally {
    f.cleanup()
  }
})
for (const [mode, reason] of [
  ['tool', 'briefing-unexpected-tool'],
  ['warning-only', 'briefing-stream-incomplete'],
  ['warning-large', 'briefing-diagnostic-bound'],
  ['failed', 'briefing-inference-failed'],
  ['top-error', 'briefing-inference-failed'],
  ['many', 'briefing-event-bound'],
  ['large', 'briefing-output-bound'],
  ['incomplete', 'briefing-stream-incomplete'],
] as const)
  test(`reject ${mode} without returning a writer payload`, async () => {
    const f = setup(mode)
    try {
      await assert.rejects(f.run(), new RegExp(reason))
      assert.ok(f.observations.some((x) => x.exit))
    } finally {
      f.cleanup()
    }
  })
test('Stop aborts actual held process, observed exit is independent of Abort rejection', async () => {
  const f = setup('held')
  try {
    const run = f.run()
    for (let i = 0; i < 200 && !f.observations.some((x) => x.pid); i++) await new Promise((r) => setTimeout(r, 10))
    assert.ok(f.observations.some((x) => x.pid))
    f.controller.abort()
    await assert.rejects(run, /briefing-aborted/)
    assert.ok(f.observations.at(-1)?.exit)
    assert.throws(() => process.kill(f.observations.at(-1)!.pid!, 0), { code: 'ESRCH' })
  } finally {
    f.cleanup()
  }
})
test('deadline has no provider retry and has observed local exit', async () => {
  const f = setup('held', 500)
  try {
    await assert.rejects(f.run(), /briefing-timeout/)
    assert.equal(readdirSync(path.join(f.root, 'runtime')).length, 1)
    assert.ok(f.observations.at(-1)?.exit)
  } finally {
    f.cleanup()
  }
})

test('observed SDK diagnostic warnings remain bounded evidence and do not reject successful completion', async () => {
  const f = setup('warnings')
  try {
    const result = await f.run()
    assert.equal(result.rawOutput, answer)
    assert.equal(result.execution.exit?.code, 0)
    const invocation = readdirSync(path.join(f.root, 'runtime'))[0]!
    const records = readFileSync(path.join(f.root, 'runtime', invocation, 'diagnostics.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((row) => JSON.parse(row))
    assert.deepEqual(
      records.map((row) => row.message),
      warnings
    )
    assert.deepEqual(
      records.map((row) => row.eventIndex),
      [1, 2]
    )
    assert.ok(records.every((row) => row.type === 'error' && row.eventType === 'item.completed'))
  } finally {
    f.cleanup()
  }
})
