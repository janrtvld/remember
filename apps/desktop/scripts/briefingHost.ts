import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createBriefingHost } from '../../../experiments/always-on-agent/briefing-host.mjs'
import { validateBriefingSlot } from '../../../experiments/always-on-agent/briefing-protocol.mjs'
import { createBriefingExecutor } from '../src/main/briefingExecutor'

// Build this entrypoint for the two explicitly provisioned private QA hosts.
// Configuration selects only a pinned local executable and a preprovisioned slot.
const configPath = process.argv[2]
if (!configPath || !path.isAbsolute(configPath)) throw new Error('briefing-config-required')
const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
if (Object.keys(config).sort().join(',') !== 'executable,slot') throw new Error('briefing-config-keys')
if (typeof config.executable !== 'string' || !path.isAbsolute(config.executable))
  throw new Error('briefing-config-executable')
const slot = validateBriefingSlot(config.slot)
const executor = createBriefingExecutor({
  executable: config.executable,
  env: process.env,
  runtimeDirectory: path.join(slot.directory, 'executor'),
})
const host = createBriefingHost({ slot, executor })
await host.listen()
process.stdout.write(`${JSON.stringify({ type: 'ready', pid: process.pid, socketPath: host.socketPath, slot })}\n`)
let closing = false
const close = async () => {
  if (closing) return
  closing = true
  try {
    await host.close()
    process.exitCode = 0
  } catch {
    closing = false
    process.stderr.write('briefing-close-requires-exact-stop\n')
  }
}
process.on('SIGTERM', () => {
  void close()
})
process.on('SIGINT', () => {
  void close()
})
