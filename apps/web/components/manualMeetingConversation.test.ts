import assert from 'node:assert/strict'
import { test } from 'node:test'
import { conversationSummaryStatus } from './manualMeetingConversation'

test('active analysis and queued requests hide stale failures and Retry', () => {
  for (const revinoteState of ['idle', 'busy', 'queued'] as const) {
    assert.deepEqual(
      conversationSummaryStatus(
        { processing: 'processing', processingError: 'revinote' },
        revinoteState,
        'Previous attempt failed'
      ),
      { pending: true, retryable: false }
    )
  }
  for (const revinoteState of ['busy', 'queued'] as const) {
    assert.deepEqual(conversationSummaryStatus({ processingError: 'revinote' }, revinoteState, null), {
      pending: true,
      retryable: false,
    })
  }
})

test('Retry requires an idle retryable failure', () => {
  assert.deepEqual(conversationSummaryStatus({}, 'idle', null), { pending: false, retryable: false })
  assert.deepEqual(conversationSummaryStatus({ processingError: 'audio' }, 'idle', null), {
    pending: false,
    retryable: false,
  })
  assert.deepEqual(conversationSummaryStatus({ processingError: 'revinote' }, 'idle', null), {
    pending: false,
    retryable: true,
  })
  assert.deepEqual(conversationSummaryStatus({}, 'idle', 'Upload failed'), { pending: false, retryable: true })
})
