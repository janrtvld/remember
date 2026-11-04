type SyncMeeting = { id: string; status: string }

export const REVINOTE_COMPLETION_POLL_MS = 10_000

export function hasPendingRevinotePostProcesses(
  submissions: Readonly<Record<string, { meetingId: string; settledAt?: number }>>,
  importedMeetings: Readonly<Record<string, SyncMeeting>>
) {
  return Object.values(submissions).some(
    (submission) => submission.settledAt == null && !importedMeetings[submission.meetingId]
  )
}

// Finished meetings still need attention; processed meetings are already handled in Revinote.
export function shouldImportRevinoteMeeting(meeting: SyncMeeting) {
  return meeting.status === 'finished'
}

export function mergeRevinoteSyncMeetings<T extends SyncMeeting>(
  existing: Record<string, T>,
  incoming: readonly T[],
  authoritative: boolean
) {
  const meetings = authoritative
    ? {}
    : Object.fromEntries(Object.entries(existing).filter(([, meeting]) => shouldImportRevinoteMeeting(meeting)))
  for (const meeting of incoming) {
    if (shouldImportRevinoteMeeting(meeting)) meetings[meeting.id] = meeting
    else if (meeting.status === 'failed' || meeting.status === 'processed') delete meetings[meeting.id]
  }
  return meetings
}

export function failedRevinotePostProcessEpisodes(
  submissions: Readonly<Record<string, { meetingId: string }>>,
  incoming: readonly SyncMeeting[]
) {
  const failedMeetingIds = new Set(incoming.flatMap((meeting) => (meeting.status === 'failed' ? [meeting.id] : [])))
  return Object.entries(submissions).flatMap(([episodeId, submission]) =>
    failedMeetingIds.has(submission.meetingId) ? [{ episodeId, meetingId: submission.meetingId }] : []
  )
}

export function preparedUploadCanRestart(stage: 'prepared' | 'uploaded', completeStatus: number) {
  return completeStatus === 400 && stage === 'prepared'
}

export function changedRevinoteMeetingIds(
  knownVersions: ReadonlyMap<string, string>,
  meetings: ReadonlyArray<{ id: string; updatedAt: string }>
) {
  return new Set(
    meetings.filter((meeting) => knownVersions.get(meeting.id) !== meeting.updatedAt).map((meeting) => meeting.id)
  )
}
