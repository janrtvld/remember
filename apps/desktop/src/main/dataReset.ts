import { app } from 'electron'
import { deleteLocalDataAt } from './dataResetFiles'
import { deleteModel } from './voiceNotes/models'

export async function deleteAllLocalData(): Promise<void> {
  await deleteModel()
  await deleteLocalDataAt(app.getPath('userData'))
}
