const assert = require('node:assert/strict')
const { once } = require('node:events')
const { mkdtemp, writeFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { test } = require('node:test')
const { WebSocketServer } = require('ws')

test('desktop bundling sends masked audio frames without an optional native addon', { timeout: 30_000 }, async (t) => {
  const { build, loadConfigFromFile } = await import('vite')
  const root = path.resolve(__dirname, '../..')
  const loaded = await loadConfigFromFile(
    { command: 'build', mode: 'production' },
    path.join(root, 'electron.vite.config.ts')
  )
  assert.ok(loaded)
  const directory = await mkdtemp(path.join(tmpdir(), 'remember-ws-bundle-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const entry = path.join(directory, 'entry.mjs')
  await writeFile(entry, `export { default } from ${JSON.stringify(require.resolve('ws'))};`)
  await build({
    ...loaded.config.main,
    configFile: false,
    logLevel: 'silent',
    ssr: { noExternal: ['ws'] },
    build: {
      ssr: entry,
      outDir: path.join(directory, 'out'),
      minify: false,
      rollupOptions: { output: { entryFileNames: 'socket.mjs', format: 'es' } },
    },
  })
  const { default: BundledWebSocket } = await import(pathToFileURL(path.join(directory, 'out/socket.mjs')).href)
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false })
  t.after(() => {
    for (const client of server.clients) client.terminate()
    server.close()
  })
  await once(server, 'listening')
  const accepted = once(server, 'connection')
  const client = new BundledWebSocket(`ws://127.0.0.1:${server.address().port}`)
  t.after(() => client.terminate())
  const [peer] = await accepted
  const received = once(peer, 'message')
  await once(client, 'open')
  const audio = Buffer.alloc(96_000, 7)
  client.send(audio)
  const [message] = await received
  assert.deepEqual(message, audio)
})
