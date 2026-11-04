#!/usr/bin/env node

import { spawn } from 'node:child_process'

const [timeoutArgument, command, ...args] = process.argv.slice(2)
const timeoutSeconds = Number(timeoutArgument)

if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || !command) {
  console.error('Usage: run-with-timeout.mjs <seconds> <command> [args...]')
  process.exit(2)
}

const child = spawn(command, args, {
  detached: true,
  stdio: 'inherit',
})
let timedOut = false

const signalProcessGroup = (signal) => {
  if (child.pid === undefined) return

  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

const timeout = setTimeout(() => {
  timedOut = true
  console.error(`[release] command exceeded ${timeoutSeconds}s; terminating it`)
  signalProcessGroup('SIGTERM')
  setTimeout(() => signalProcessGroup('SIGKILL'), 5_000).unref()
}, timeoutSeconds * 1_000)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => signalProcessGroup(signal))
}

child.once('error', (error) => {
  clearTimeout(timeout)
  console.error(`[release] failed to start ${command}: ${error.message}`)
  process.exitCode = 1
})

child.once('exit', (code, signal) => {
  clearTimeout(timeout)

  if (timedOut) {
    process.exitCode = 124
    return
  }

  if (signal) {
    console.error(`[release] command terminated by ${signal}`)
    process.exitCode = 1
    return
  }

  process.exitCode = code ?? 1
})
