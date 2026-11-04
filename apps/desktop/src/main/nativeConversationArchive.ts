import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { dailyReviewDirectory, getEvidenceStore } from './dailyReview/evidenceRepository'
import { createArchiveRunner } from './residentArchiveTool'
import { createResidentConversationArchive } from './residentConversationArchive'

export function createNativeConversationArchive(assertCurrent: () => void) {
  return createResidentConversationArchive({
    runCLI: createArchiveRunner(
      app.isPackaged ? join(process.resourcesPath, 'remember') : join(app.getAppPath(), 'native', 'remember'),
      dailyReviewDirectory(),
      assertCurrent
    ),
    readSessions: (date) => getEvidenceStore().readConversationSessions(date),
    readImported: () =>
      JSON.parse(readFileSync(join(app.getPath('userData'), 'integrations', 'revinote', 'meetings.json'), 'utf8')),
    assertCurrent,
  })
}
