import assert from 'node:assert/strict'
import test from 'node:test'
import type { RendererErrorReport } from '@remember/shared'
import { installRendererErrorReporting } from '../lib/errorReporting'

test('browser errors without Error objects retain source locations and only fixed diagnostic reasons', (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const target = new EventTarget()
  Object.defineProperty(globalThis, 'window', { value: target, configurable: true })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  const reports: RendererErrorReport[] = []
  const uninstall = installRendererErrorReporting({ reportRendererError: (input) => reports.push(input) })
  const emit = (input: Partial<ErrorEvent>) => target.dispatchEvent(Object.assign(new Event('error'), input))

  emit({
    message: 'Private document text\nMore private text',
    error: null,
    filename: 'file:///Users/synthetic/Remember/app.asar/web/_next/static/chunks/app.js',
    lineno: 42,
    colno: 7,
  })
  assert.equal(reports[0].reason, 'missing-error-object')
  assert.match(reports[0].stack ?? '', /_next\/static\/chunks\/app\.js:42:7/)
  assert.doesNotMatch(reports[0].stack ?? '', /Users\/synthetic|Private document|More private/)

  emit({ message: 'ResizeObserver loop completed with undelivered notifications.', error: null })
  assert.equal(reports[1].reason, 'resize-observer-loop')
  assert.equal(reports[1].stack, null)
  emit({ message: 'Script error.', error: null })
  assert.equal(reports[2].reason, 'script-error')

  const error = new TypeError('Synthetic failure')
  error.stack = 'TypeError: Synthetic failure\n    at render (file:///app/_next/static/chunks/real.js:8:2)'
  emit({ message: error.message, error, filename: 'wrong.js', lineno: 99, colno: 99 })
  assert.equal(reports[3].stack, error.stack)
  assert.equal(reports[3].reason, undefined)
  uninstall()
  emit({ message: 'After cleanup', error: null })
  assert.equal(reports.length, 4)
})
