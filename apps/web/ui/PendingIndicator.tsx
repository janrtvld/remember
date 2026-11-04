'use client'

import { useEffect, useState } from 'react'
import { Spinner, type SpinnerProps } from './Spinner'

// Local reads usually finish before a loading indicator would be useful.
export function PendingIndicator(props: SpinnerProps) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const timeout = window.setTimeout(() => setVisible(true), 300)
    return () => window.clearTimeout(timeout)
  }, [])

  return visible ? <Spinner {...props} /> : null
}
