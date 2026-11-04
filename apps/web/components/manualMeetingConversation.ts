import { type ConversationSummary, type Day, resolveConversationReference } from '@remember/shared'
import { type ConversationSpaceContext, withConversationSpaceContext } from './conversationSpaceContext'

export function conversationAtReference(conversations: ConversationSummary[], reference: string) {
  try {
    return resolveConversationReference(conversations, reference)
  } catch {
    return null
  }
}

export function conversationAnalysisPending(processing: ConversationSummary['processing']) {
  switch (processing) {
    case 'processing':
      return true
    case 'merging':
    case undefined:
      return false
    default: {
      const _exhaustive: never = processing
      return _exhaustive
    }
  }
}

export function conversationSummaryStatus(
  conversation: Pick<ConversationSummary, 'processing' | 'processingError'>,
  revinoteState: 'idle' | 'busy' | 'queued',
  revinoteError: string | null
) {
  const pending = conversationAnalysisPending(conversation.processing) || revinoteState !== 'idle'
  const retryable = !pending && (conversation.processingError === 'revinote' || Boolean(revinoteError))
  return { pending, retryable }
}

export function conversationForManualMeeting(days: Day[], meetingId: string) {
  for (const day of days) {
    const conversation = day.memory?.conversations.find((candidate) => candidate.manualMeetingId === meetingId)
    if (conversation) return { day, conversation }
  }
  return null
}

export function manualMeetingPendingHref(meetingId: string, context: ConversationSpaceContext | null = null) {
  return withConversationSpaceContext(`/conversations/pending/?meeting=${encodeURIComponent(meetingId)}`, context)
}
