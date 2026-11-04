'use client'

import type { ManualMeeting } from '@remember/shared'
import { useEffect, useState } from 'react'
import { recordingElapsedSeconds } from './recordingDuration'

export function useRecordingClock(meeting: ManualMeeting | null, stopRequestedAt: number | null = null) {
  const [now, setNow] = useState(Date.now)
  const running = meeting?.status === 'recording' && meeting.pausedAt == null && stopRequestedAt == null
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [running])
  const seconds = recordingElapsedSeconds(meeting, now, stopRequestedAt)
  return {
    now,
    running,
    seconds,
    duration: `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`,
  }
}
