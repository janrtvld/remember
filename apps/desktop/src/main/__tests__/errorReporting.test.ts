import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { registerHooks } from 'node:module'
import { after, test } from 'node:test'

let ready = false
let finishAppReady: () => void
const appReady = new Promise<void>((resolve) => {
  finishAppReady = resolve
})
const requests: { signal: AbortSignal; body: unknown }[] = []
let holdRequests = false
let protocolRegistrations = 0
const electronKey = '__rememberErrorReportingElectron'
const fakeSession = {
  protocol: { handle: () => undefined },
  fetch: async (_url: string, options: { signal: AbortSignal; body: unknown }) => {
    requests.push(options)
    if (holdRequests) {
      await new Promise<void>((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      })
    }
    return new Response(null, { status: 200 })
  },
}
const app = Object.assign(new EventEmitter(), {
  isPackaged: true,
  name: 'Remember Test',
  getVersion: () => '0.0.0-test',
  getAppPath: () => '/synthetic/remember',
  isReady: () => ready,
  whenReady: () => appReady,
})
Object.assign(globalThis, {
  [electronKey]: {
    app,
    session: { defaultSession: fakeSession, fromPartition: () => fakeSession },
    ipcMain: Object.assign(new EventEmitter(), { handle: () => undefined }),
    protocol: { registerSchemesAsPrivileged: () => protocolRegistrations++ },
  },
})
const originalElectronVersion = process.versions.electron
Object.defineProperty(process.versions, 'electron', { value: '45.2.1', configurable: true })
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? { url: 'remember-test:error-reporting-electron', shortCircuit: true }
      : next(specifier, context)
  },
  load(url, context, next) {
    return url === 'remember-test:error-reporting-electron'
      ? {
          format: 'module',
          source: `export const { app, session, ipcMain, protocol, screen, BrowserWindow, powerMonitor, webContents, net, crashReporter, autoUpdater, dialog } = globalThis.${electronKey}`,
          shortCircuit: true,
        }
      : next(url, context)
  },
})
const reporting = await import('../errorReporting')
const Sentry = await import('@sentry/electron/main')
hooks.deregister()
Reflect.deleteProperty(globalThis, electronKey)

after(() => {
  reporting.setErrorReportingEnabled(false)
  if (originalElectronVersion === undefined) Reflect.deleteProperty(process.versions, 'electron')
  else Object.defineProperty(process.versions, 'electron', { value: originalElectronVersion, configurable: true })
})

async function settleEvents() {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
}

test('real Sentry client drops pending reports on disable and reenables without reinstalling Electron hooks', async (t) => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Reporting tests must not send real network requests'))
  reporting.initializeErrorReporting(false)
  const client = Sentry.getClient()
  assert(client)
  assert.equal(client.getOptions().enabled, false)
  assert.equal(client.getOptions().sendClientReports, false)
  assert.equal(protocolRegistrations, 1)

  reporting.reportAppError(new Error('synthetic disabled error'), { area: 'test', code: 'disabled' })
  Sentry.captureException(new Error('synthetic SDK error while disabled'))
  await settleEvents()
  assert.equal(requests.length, 0)

  reporting.setErrorReportingEnabled(true)
  reporting.reportAppError(new Error('synthetic pre-ready error'), { area: 'test', code: 'pre-ready' })
  await settleEvents()
  reporting.setErrorReportingEnabled(false)
  reporting.setErrorReportingEnabled(true)
  ready = true
  finishAppReady()
  await settleEvents()
  assert.equal(requests.length, 0, 'a request waiting for Electron ready must not survive an off/on cycle')

  holdRequests = true
  reporting.reportAppError(new Error('synthetic in-flight error'), { area: 'test', code: 'in-flight' })
  await settleEvents()
  assert.equal(requests.length, 1)
  reporting.setErrorReportingEnabled(false)
  assert.equal(requests[0]?.signal.aborted, true, 'disable cancels an active upload synchronously')
  holdRequests = false
  await settleEvents()

  reporting.setErrorReportingEnabled(true)
  let finishProcessing!: () => void
  const processing = new Promise<void>((resolve) => {
    finishProcessing = resolve
  })
  let holdProcessing = true
  client.addEventProcessor(async (event) => {
    if (holdProcessing) await processing
    return event
  })
  reporting.reportAppError(new Error('synthetic pending processor error'), { area: 'test', code: 'pending' })
  await settleEvents()
  reporting.setErrorReportingEnabled(false)
  reporting.setErrorReportingEnabled(true)
  holdProcessing = false
  finishProcessing()
  await settleEvents()
  assert.equal(requests.length, 1, 'old events in an async processor must not resume after reenable')

  reporting.reportAppError(new Error('synthetic new error'), { area: 'test', code: 'reenabled' })
  await settleEvents()
  assert.equal(requests.length, 2)
  assert.equal(Sentry.getClient(), client)
  assert.equal(protocolRegistrations, 1)
  assert.match(String(requests[1]?.body), /reenabled/)
})
