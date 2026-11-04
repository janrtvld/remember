import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeRendererErrorReport,
  privacySafeError,
  sanitizeDiagnosticText,
  sanitizeSentryEvent,
} from '../errorReportingSanitizer'

test('sanitizeDiagnosticText removes credentials, identities, home paths, and URL queries', () => {
  const sanitized = sanitizeDiagnosticText(
    'Bearer secret-token jan@example.com /Users/jan/Documents/day.txt https://example.com/path?token=secret'
  )
  assert.equal(sanitized, 'Bearer [redacted] [email] ~/Documents/day.txt https://example.com/path?[redacted]')
})

test('sanitizeSentryEvent keeps only the debugging fields we explicitly allow', () => {
  const sanitized = sanitizeSentryEvent({
    event_id: 'event-id',
    message: 'Failed for jan@example.com',
    user: { email: 'jan@example.com' },
    request: { url: 'https://remember.computer/day?private=1' },
    breadcrumbs: [{ message: 'private click' }],
    tags: { app_area: 'day-report', secret_tag: 'private' },
    contexts: { device: { name: 'Jans MacBook' } },
    extra: {
      prompt: 'private prompt',
      diagnostics: { attempt: 2, stdout_bytes: 123, working_directory: '/Users/jan/private' },
    },
    debug_meta: {
      images: [
        {
          type: 'sourcemap',
          code_file: '/Applications/Remember.app/Contents/Resources/app.asar/out/main/index.js',
          debug_id: '9f16b970-2e13-4fd9-b002-1ff8a5f0c142',
          private_field: 'private',
        },
      ],
    },
    exception: {
      values: [
        {
          type: 'Error',
          value: 'Bad file /Users/jan/private.txt',
          stacktrace: {
            frames: [
              {
                filename: '/Applications/Remember.app/Contents/Resources/app.asar/out/main/index.js?token=secret',
                function: 'refreshDay',
                lineno: 42,
                vars: { prompt: 'private' },
              },
            ],
          },
        },
      ],
    },
  })

  assert.equal(sanitized.message, 'Error')
  assert.deepEqual(sanitized.tags, { app_area: 'day-report' })
  assert.deepEqual(sanitized.extra, { diagnostics: { attempt: 2, stdout_bytes: 123 } })
  assert.deepEqual(sanitized.user, { ip_address: '0.0.0.0' })
  assert.deepEqual(sanitized.debug_meta, {
    images: [
      {
        type: 'sourcemap',
        code_file: 'app.asar/out/main/index.js',
        code_id: undefined,
        debug_id: '9f16b970-2e13-4fd9-b002-1ff8a5f0c142',
      },
    ],
  })
  assert.equal(sanitized.request, undefined)
  assert.equal(sanitized.breadcrumbs, undefined)
  assert.equal(sanitized.contexts, undefined)
  assert.equal(sanitized.exception?.values?.[0]?.value, 'Error')
  assert.doesNotMatch(JSON.stringify(sanitized), /private|jan@example\.com/)
  assert.deepEqual(sanitized.exception?.values?.[0]?.stacktrace?.frames?.[0], {
    filename: 'app.asar/out/main/index.js',
    function: 'refreshDay',
    lineno: 42,
    colno: undefined,
    in_app: undefined,
  })
})

test('privacySafeError retains sanitized code locations but replaces the original message', () => {
  const original = new Error('Prompt contained jan@example.com')
  original.stack = 'Error: Prompt contained jan@example.com\n    at refreshDay (/Users/jan/project/index.ts:42:1)'
  const safe = privacySafeError(original, 'agent-invalid-response')
  assert.match(safe.stack ?? '', /^Error: agent-invalid-response/)
  assert.match(safe.stack ?? '', /~\/project\/index.ts:42:1/)
  assert.doesNotMatch(safe.stack ?? '', /jan@example\.com/)
})

test('normalizeRendererErrorReport rejects unknown payloads and sanitizes accepted reports', () => {
  assert.equal(normalizeRendererErrorReport({ source: 'console', message: 'nope', name: 'Error' }), null)
  assert.deepEqual(
    normalizeRendererErrorReport({
      source: 'error',
      name: 'TypeError',
      message: 'Failed for jan@example.com',
      stack: 'TypeError: Failed\n at run (/Users/jan/app.js:1:1)',
    }),
    {
      source: 'error',
      name: 'TypeError',
      message: 'Failed for [email]',
      stack: 'TypeError: Failed\nat run (~/app.js:1:1)',
    }
  )
})
