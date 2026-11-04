'use client'

import type { DictationState } from '@remember/shared'
import { Mic as IconMicrophone, Square as IconStop } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { getDictationBridge } from '../lib/dictationBridge'
import { useI18n } from '../locales'
import { IconButton } from '../ui/IconButton'
import { Spinner } from '../ui/Spinner'

export function ComposerDictation({
  disabled,
  onTranscript,
  onBusyChange,
}: {
  disabled: boolean
  onTranscript: (text: string) => boolean
  onBusyChange: (busy: boolean) => void
}) {
  const { t } = useI18n()
  const [state, setState] = useState<DictationState | null>(null)
  const [error, setError] = useState<'recording' | 'length' | null>(null)
  const [busy, setBusy] = useState(false)
  const delivery = useRef<((text: string) => boolean) | null>(null)
  const busyChanged = useRef(onBusyChange)
  busyChanged.current = onBusyChange

  useEffect(() => {
    const bridge = getDictationBridge()
    if (!bridge) return
    let active = true
    let receivedState = false
    const accept = (next: DictationState) => {
      if (!active) return
      setState(next)
      if (!delivery.current) return
      const running = ['starting', 'recording', 'transcribing'].includes(next.status)
      busyChanged.current(running)
      if (!running) {
        const receive = delivery.current
        delivery.current = null
        setBusy(false)
        if ((next.status === 'done' || next.status === 'idle') && next.text.trim()) {
          setError(receive(next.text.trim()) ? null : 'length')
        } else if (next.status === 'error') {
          setError('recording')
        }
      }
    }
    const unsubscribe = bridge.onState((next) => {
      receivedState = true
      accept(next)
    })
    void bridge
      .getState()
      .then((next) => {
        if (!receivedState) accept(next)
      })
      .catch(() => {
        if (active) setError('recording')
      })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const recording = state?.status === 'recording'
  const processing = busy && (!recording || state?.status === 'transcribing')
  const otherRecording = !delivery.current && ['starting', 'recording', 'transcribing'].includes(state?.status ?? '')
  const label = recording && delivery.current ? t('Dictatie stoppen') : t('Dicteren')

  async function toggle() {
    const bridge = getDictationBridge()
    if (!bridge || otherRecording || processing) return
    setError(null)
    if (!recording) {
      delivery.current = onTranscript
      setBusy(true)
      busyChanged.current(true)
    }
    try {
      await bridge.toggle('composer')
    } catch {
      delivery.current = null
      setBusy(false)
      busyChanged.current(false)
      setError('recording')
    }
  }

  return (
    <span className="relative flex shrink-0 items-center">
      <IconButton
        type="button"
        aria-label={label}
        title={label}
        aria-pressed={Boolean(recording && delivery.current)}
        aria-busy={processing}
        tone={recording && delivery.current ? 'danger' : 'neutral'}
        disabled={(!delivery.current && disabled) || !state || otherRecording || processing}
        onClick={() => void toggle()}
      >
        {processing ? (
          <Spinner size="xs" />
        ) : recording && delivery.current ? (
          <IconStop className="size-4" aria-hidden />
        ) : (
          <IconMicrophone className="size-4" aria-hidden />
        )}
      </IconButton>
      {error ? (
        <span
          role="alert"
          className="absolute bottom-full right-0 mb-2 w-64 rounded-lg bg-white p-3 text-danger-700 text-xs shadow-raised"
        >
          {error === 'length'
            ? t('Je bericht is te lang. Je dictatie staat in Notes.')
            : state?.error === 'model-required'
              ? t('Download eerst het dictatiemodel in Notes.')
              : t('Dicteren mislukt. Probeer opnieuw of open Notes.')}{' '}
          <Link href="/notes/" className="underline">
            {t('Open Notes')}
          </Link>
        </span>
      ) : null}
    </span>
  )
}
