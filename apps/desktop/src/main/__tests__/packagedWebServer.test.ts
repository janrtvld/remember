import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createPackagedWebServer } from '../packagedWebServer'

test('serves exported navigation payloads as Flight data instead of forcing document reloads', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'remember-web-'))
  const route = path.join(root, 'conversations', 'live')
  await mkdir(route, { recursive: true })
  await writeFile(path.join(route, 'index.html'), '<html>Conversation</html>')
  await writeFile(path.join(route, 'index.txt'), '0:payload')
  await writeFile(path.join(route, '__next._tree.txt'), '0:tree')
  const server = createPackagedWebServer(root)
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    for (const file of ['index.txt', '__next._tree.txt']) {
      const response = await fetch(`${origin}/conversations/live/${file}?_rsc=navigation`)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-type'), 'text/x-component; charset=utf-8')
      assert.equal(response.headers.get('cache-control'), 'no-cache')
      assert.match(await response.text(), /^0:/)
    }
    const document = await fetch(`${origin}/conversations/live/?start=1`)
    assert.equal(document.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.equal((await fetch(`${origin}/missing.txt`)).status, 404)
    assert.equal((await fetch(`${origin}/%2e%2e%2foutside.txt`)).status, 403)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await rm(root, { recursive: true, force: true })
  }
})
