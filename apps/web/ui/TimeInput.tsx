'use client'

import { type InputHTMLAttributes, useEffect, useRef, useState } from 'react'

export interface TimeInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onBlur' | 'onChange' | 'onKeyDown' | 'type' | 'value'> {
  value: string
  onCommit: (value: string) => void
}

export function TimeInput({ value, onCommit, onFocus, ...props }: TimeInputProps) {
  const [draft, setDraft] = useState(value)
  const isEditingRef = useRef(false)

  useEffect(() => {
    if (!isEditingRef.current) setDraft(value)
  }, [value])

  const commit = () => {
    isEditingRef.current = false
    if (!draft) {
      setDraft(value)
      return
    }
    if (draft !== value) onCommit(draft)
  }

  return (
    <input
      {...props}
      type="time"
      value={draft}
      onFocus={(event) => {
        isEditingRef.current = true
        onFocus?.(event)
      }}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
      }}
    />
  )
}
