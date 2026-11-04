export const MAX_RESIDENT_REPLY_REFERENCES = 64

export type BriefingReplyReference = {
  actionId: string
  messageId: string
  resultId: string
  resultHash: string
}

export type InitiativeReplyReference = {
  kind: 'initiative'
  decisionId: string
  messageId: string
  inputHash: string
}

export type ResidentReplyReference = BriefingReplyReference | InitiativeReplyReference

export function isInitiativeReplyReference(reference: ResidentReplyReference): reference is InitiativeReplyReference {
  return 'kind' in reference && reference.kind === 'initiative'
}

export function sameReplyReference(a: ResidentReplyReference, b: ResidentReplyReference) {
  if (isInitiativeReplyReference(a)) {
    return (
      isInitiativeReplyReference(b) &&
      a.decisionId === b.decisionId &&
      a.messageId === b.messageId &&
      a.inputHash === b.inputHash
    )
  }
  return (
    !isInitiativeReplyReference(b) &&
    a.actionId === b.actionId &&
    a.messageId === b.messageId &&
    a.resultId === b.resultId &&
    a.resultHash === b.resultHash
  )
}
