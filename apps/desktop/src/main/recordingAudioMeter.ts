import { CHANNELS } from '@remember/shared'
import { BrowserWindow } from 'electron'
import { createRecordingAudioMeter } from './recordingAudioMeterCore'

export const publishRecordingAudioLevel = createRecordingAudioMeter((sample) => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(CHANNELS.recordingAudioLevel, sample)
  }
})
