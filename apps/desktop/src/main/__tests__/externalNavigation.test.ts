import assert from 'node:assert/strict'
import test from 'node:test'
import { externalNavigationUrl } from '../externalNavigation'

test('renderer links can open ordinary web pages and mail', () => {
  for (const value of [
    'https://example.com/page?query=work#notes',
    'http://localhost:3000/',
    'mailto:hello@example.com?subject=Meeting',
  ])
    assert.equal(externalNavigationUrl(value), value)
})

test('renderer content cannot invoke local files, executable URLs, or arbitrary application handlers', () => {
  for (const value of [
    'file:///Applications/Calculator.app',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vscode://file/private/tmp/untrusted',
    'x-apple.systempreferences:com.apple.preference.security',
    'smb://example.com/share',
    'remember://unknown',
    'https://user:password@example.com/',
    '//example.com',
    '/wiki/',
    '',
  ])
    assert.equal(externalNavigationUrl(value), null, value)
})
