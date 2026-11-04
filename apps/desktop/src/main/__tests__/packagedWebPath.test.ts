import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { resolvePackagedWebPath } from '../packagedWebPath'

const root = path.resolve('/Applications/Remember.app/Contents/Resources/web')

test('serves static-export pages with or without a trailing slash', () => {
  assert.equal(resolvePackagedWebPath(root, '/'), path.join(root, 'index.html'))
  assert.equal(resolvePackagedWebPath(root, '/wiki'), path.join(root, 'wiki', 'index.html'))
  assert.equal(resolvePackagedWebPath(root, '/wiki/'), path.join(root, 'wiki', 'index.html'))
  assert.equal(resolvePackagedWebPath(root, '/wiki/page/'), path.join(root, 'wiki', 'page', 'index.html'))
  assert.equal(resolvePackagedWebPath(root, '/day/conversation/'), path.join(root, 'day', 'conversation', 'index.html'))
  assert.equal(
    resolvePackagedWebPath(root, '/startup-error/data-version/'),
    path.join(root, 'startup-error', 'data-version', 'index.html')
  )
})

test('preserves assets and static route payloads', () => {
  assert.equal(
    resolvePackagedWebPath(root, '/_next/static/chunks/app.js'),
    path.join(root, '_next', 'static', 'chunks', 'app.js')
  )
  assert.equal(resolvePackagedWebPath(root, '/wiki/index.txt'), path.join(root, 'wiki', 'index.txt'))
})

test('rejects paths outside the packaged web root', () => {
  assert.equal(resolvePackagedWebPath(root, '/../Info.plist'), null)
  assert.equal(resolvePackagedWebPath(root, '/%2e%2e/Info.plist'), null)
})
