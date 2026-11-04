'use client'

import { useLocalBridge } from '@internal/context/LocalBridgeProvider'
import type { RecordingAudioLevel } from '@remember/shared'
import { useEffect, useState } from 'react'
import { recordingAudioLevelAt } from './recordingAudioLevel'

export function RecordingWave({ active, className }: { active: boolean; className: string }) {
  const { bridge } = useLocalBridge()
  const [level, setLevel] = useState(0)

  useEffect(() => {
    setLevel(0)
    if (!active || !bridge?.onRecordingAudioLevel) return
    const samples = new Map<RecordingAudioLevel['source'], RecordingAudioLevel>()
    const refresh = () => setLevel(recordingAudioLevelAt([...samples.values()], Date.now()))
    const unsubscribe = bridge.onRecordingAudioLevel((sample) => {
      samples.set(sample.source, sample)
      refresh()
    })
    const timer = window.setInterval(refresh, 100)
    return () => {
      unsubscribe()
      window.clearInterval(timer)
    }
  }, [active, bridge])

  const amplitude = active ? level : 0
  return (
    <span className="flex h-4 items-center gap-0.5" data-recording-wave data-level={amplitude} aria-hidden="true">
      {[0.35, 0.7, 1, 0.65, 0.4].map((weight, index) => (
        <span
          key={index}
          className={`block h-4 w-0.5 rounded-full transition-transform duration-75 motion-reduce:transition-none ${className}`}
          style={{ transform: `scaleY(${0.125 + amplitude * weight * 0.875})` }}
        />
      ))}
    </span>
  )
}
