import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Codex, type Usage } from '@openai/codex-sdk'
import {
  BRIEFING_LIMITS,
  type BriefingExecution,
  type BriefingSpec,
  validateBriefingSpec,
} from '../../../../experiments/always-on-agent/briefing-protocol.mjs'
import schema from '../../../../experiments/proactive-agent/briefing-models/schema.v1.json'
import { validateBriefingOutput } from '../../../../experiments/proactive-agent/briefing-models/validateOutput.mjs'
import { buildCodexSdkConfiguration } from './dailyReview/codexAgentSdk'

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
// The launcher observes the real child exit. An AbortError is not an exit receipt.
const launcher = `import {spawn} from 'node:child_process'
import {openSync,writeSync,fsyncSync,closeSync} from 'node:fs'
const record=value=>{const fd=openSync(process.env.REMEMBER_BRIEFING_LIFECYCLE,'a',0o600);try{writeSync(fd,JSON.stringify(value)+'\\n');fsyncSync(fd)}finally{closeSync(fd)}}
const child=spawn(process.env.REMEMBER_BRIEFING_REAL_EXECUTABLE,process.argv.slice(2),{stdio:'inherit',env:process.env})
child.once('spawn',()=>record({kind:'spawn',pid:child.pid,at:Date.now()}))
child.once('error',()=>{record({kind:'spawn-error',at:Date.now()});process.exitCode=127})
for(const signal of ['SIGTERM','SIGINT','SIGHUP'])process.on(signal,()=>{if(child.pid)child.kill(signal)})
child.once('close',(code,signal)=>{record({kind:'exit',pid:child.pid??null,code,signal,at:Date.now()});process.exitCode=code??128})
`

export function createBriefingExecutor(options: {
  executable: string
  env: NodeJS.ProcessEnv
  runtimeDirectory: string
}) {
  const configured = { ...options, env: { ...options.env } }
  if (!path.isAbsolute(configured.executable) || !path.isAbsolute(configured.runtimeDirectory))
    throw new Error('briefing-runtime-invalid')
  let active = false
  return {
    async run(
      input: BriefingSpec,
      controls: { signal: AbortSignal; onExecution: (value: BriefingExecution) => void }
    ): Promise<{ rawOutput: string; execution: BriefingExecution; usage: Usage }> {
      const spec = validateBriefingSpec(input)
      if (active) throw new Error('briefing-executor-busy')
      if (controls.signal.aborted) throw new Error('briefing-aborted')
      active = true
      const controller = new AbortController()
      const execution: BriefingExecution = { invocationId: randomUUID(), pid: null, providerThreadId: null, exit: null }
      let error: Error | null = null
      let published = ''
      let lifecyclePath = ''
      let polling: ReturnType<typeof setInterval> | undefined
      const began = performance.now()
      let lastMonotonic = began
      let rejectInterruption!: (reason: Error) => void
      const interruption = new Promise<never>((_, reject) => {
        rejectInterruption = reject
      })
      void interruption.catch(() => undefined)
      const abort = (reason: string) => {
        if (error) return
        error = new Error(reason)
        rejectInterruption(error)
        controller.abort(error)
      }
      const onAbort = () => abort('briefing-aborted')
      controls.signal.addEventListener('abort', onAbort, { once: true })
      if (controls.signal.aborted) onAbort()
      const timeout = setTimeout(() => abort('briefing-timeout'), spec.preparedInput.maxDurationMs)
      const publish = () => {
        const value = JSON.stringify(execution)
        if (published !== value) {
          controls.onExecution(structuredClone(execution))
          published = value
        }
      }
      const observe = () => {
        if (!lifecyclePath || !existsSync(lifecyclePath)) return
        const text = readFileSync(lifecyclePath, 'utf8')
        if (Buffer.byteLength(text) > 8192) throw new Error('briefing-lifecycle-bound')
        const lines = text.split('\n')
        if (lines.at(-1) !== '') lines.pop()
        for (const line of lines.filter(Boolean)) {
          const row = JSON.parse(line) as Record<string, unknown>
          if (row.kind === 'spawn-error') throw new Error('briefing-spawn-failed')
          if (!Number.isSafeInteger(row.pid) || (row.pid as number) <= 0 || !Number.isSafeInteger(row.at))
            throw new Error('briefing-lifecycle-invalid')
          if (execution.pid !== null && execution.pid !== row.pid) throw new Error('briefing-lifecycle-conflict')
          execution.pid = row.pid as number
          if (row.kind === 'exit') {
            if ((row.code === null && row.signal === null) || (row.code !== null && !Number.isInteger(row.code)))
              throw new Error('briefing-lifecycle-invalid')
            const exit = { code: row.code as number | null, signal: row.signal as string | null, at: row.at as number }
            if (execution.exit && JSON.stringify(execution.exit) !== JSON.stringify(exit))
              throw new Error('briefing-lifecycle-conflict')
            execution.exit = exit
          } else if (row.kind !== 'spawn') throw new Error('briefing-lifecycle-invalid')
        }
        publish()
      }
      const check = () => {
        if (error || controller.signal.aborted) throw error ?? new Error('briefing-aborted')
        const now = performance.now()
        if (now < lastMonotonic) throw new Error('briefing-monotonic-regression')
        lastMonotonic = now
        if (now - began >= spec.preparedInput.maxDurationMs) {
          abort('briefing-timeout')
          throw error
        }
      }
      let rawOutput = ''
      let usage: Usage | null = null
      let sdkPending = false
      try {
        mkdirSync(configured.runtimeDirectory, { recursive: true, mode: 0o700 })
        const directory = mkdtempSync(path.join(configured.runtimeDirectory, 'invocation-'))
        lifecyclePath = path.join(directory, 'lifecycle.jsonl')
        const modulePath = path.join(directory, 'observe.mjs')
        const executable = path.join(directory, 'observe-codex')
        writeFileSync(modulePath, launcher, { mode: 0o600 })
        writeFileSync(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(modulePath)} "$@"\n`, {
          mode: 0o700,
        })
        const configuration = buildCodexSdkConfiguration({
          executable,
          env: {
            ...configured.env,
            REMEMBER_BRIEFING_REAL_EXECUTABLE: configured.executable,
            REMEMBER_BRIEFING_LIFECYCLE: lifecyclePath,
          },
          cwd: directory,
          model: spec.preparedInput.model,
          effort: spec.preparedInput.effort,
          schema,
          toolsDisabled: true,
          abortController: controller,
        })
        publish()
        polling = setInterval(() => {
          try {
            observe()
          } catch {
            abort('briefing-lifecycle-observation-failed')
          }
        }, 10)
        const work = async () => {
          check()
          const client = new Codex(configuration.client)
          const thread = client.startThread(configuration.thread)
          const stream = await thread.runStreamed(
            `${spec.preparedInput.systemPrompt}\n${spec.preparedInput.prompt}`,
            configuration.turn
          )
          let completed = false
          let count = 0
          let diagnostics = 0
          for await (const event of stream.events) {
            check()
            if (++count > BRIEFING_LIMITS.maxEvents) throw new Error('briefing-event-bound')
            if (completed) throw new Error('briefing-event-after-completion')
            if (event.type === 'thread.started') {
              if (!event.thread_id || (execution.providerThreadId && execution.providerThreadId !== event.thread_id))
                throw new Error('briefing-thread-conflict')
              execution.providerThreadId = event.thread_id
              observe()
              publish()
            } else if (event.type === 'turn.completed') {
              if (!event.usage || Object.values(event.usage).some((value) => !Number.isSafeInteger(value) || value < 0))
                throw new Error('briefing-usage-invalid')
              usage = { ...event.usage }
              completed = true
            } else if (event.type === 'turn.failed' || event.type === 'error')
              throw new Error('briefing-inference-failed')
            else if (
              event.type === 'item.started' ||
              event.type === 'item.updated' ||
              event.type === 'item.completed'
            ) {
              if (event.item.type === 'error') {
                if (++diagnostics > 8 || Buffer.byteLength(event.item.message) > 2048)
                  throw new Error('briefing-diagnostic-bound')
                appendFileSync(
                  path.join(directory, 'diagnostics.jsonl'),
                  JSON.stringify({
                    type: 'error',
                    eventType: event.type,
                    eventIndex: count,
                    message: event.item.message,
                  }) + '\n',
                  { mode: 0o600 }
                )
                continue
              }
              if (event.item.type !== 'agent_message' && event.item.type !== 'reasoning')
                throw new Error('briefing-unexpected-tool')
              if (Buffer.byteLength(event.item.text) > spec.preparedInput.maxOutputBytes)
                throw new Error('briefing-output-bound')
              if (event.item.type === 'agent_message') rawOutput = event.item.text
            } else if (event.type !== 'turn.started') throw new Error('briefing-event-invalid')
          }
          check()
          if (!completed || !execution.providerThreadId || !rawOutput.trim())
            throw new Error('briefing-stream-incomplete')
          if (!validateBriefingOutput(rawOutput, JSON.parse(spec.preparedInput.prompt)).valid)
            throw new Error('briefing-output-invalid')
        }
        sdkPending = true
        const running = work().finally(() => {
          sdkPending = false
        })
        await Promise.race([running, interruption])
      } catch (caught) {
        error ??= caught instanceof Error ? caught : new Error('briefing-execution-failed')
        if (sdkPending) controller.abort(error)
      } finally {
        clearTimeout(timeout)
        clearInterval(polling)
        controls.signal.removeEventListener('abort', onAbort)
        if (error && sdkPending) controller.abort(error)
        const exitDeadline = performance.now() + 3000
        while (lifecyclePath && !execution.exit && performance.now() < exitDeadline) {
          try {
            observe()
          } catch {
            error ??= new Error('briefing-lifecycle-observation-failed')
            break
          }
          if (!execution.exit) await sleep(10)
        }
        active = false
      }
      if (error) throw error
      if (!execution.pid || !execution.exit || execution.exit.code !== 0 || execution.exit.signal !== null)
        throw new Error('briefing-exit-unconfirmed')
      if (!usage) throw new Error('briefing-usage-missing')
      return { rawOutput, execution: structuredClone(execution), usage }
    },
  }
}
