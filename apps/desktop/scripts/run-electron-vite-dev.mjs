import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const localEnvironment = new URL('../.env.local', import.meta.url)
if (existsSync(localEnvironment)) process.loadEnvFile(localEnvironment)

const require = createRequire(import.meta.url)
const electronViteDirectory = path.dirname(require.resolve('electron-vite/package.json'))
const electronViteCli = path.join(electronViteDirectory, 'bin/electron-vite.js')
const usesProcessGroup = process.platform !== 'win32'

const child = spawn(process.execPath, [electronViteCli, 'dev', '--watch', '--ignoreConfigWarning'], {
  detached: usesProcessGroup,
  stdio: 'inherit',
})

if (child.pid == null) throw new Error('electron-vite did not start')

const childProcessId = child.pid
const signalChild = (signal) => {
  try {
    process.kill(usesProcessGroup ? -childProcessId : childProcessId, signal)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

const isChildRunning = () => {
  try {
    process.kill(usesProcessGroup ? -childProcessId : childProcessId, 0)
    return true
  } catch (error) {
    return error.code !== 'ESRCH'
  }
}

let isShuttingDown = false
let shutdownDeadline = 0

function waitForShutdown() {
  if (!isChildRunning()) {
    process.exitCode = 0
    return
  }
  if (Date.now() >= shutdownDeadline) {
    signalChild('SIGKILL')
    process.exitCode = 0
    return
  }
  setTimeout(waitForShutdown, 50)
}

function shutdown() {
  if (isShuttingDown) return
  isShuttingDown = true
  shutdownDeadline = Date.now() + 5_000
  signalChild('SIGTERM')
  waitForShutdown()
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

child.once('error', (error) => {
  console.error('[electron-vite] failed to start:', error)
  process.exitCode = 1
})

child.once('exit', (code, signal) => {
  if (isShuttingDown) return
  process.exitCode = signal == null ? (code ?? 1) : 1
})
