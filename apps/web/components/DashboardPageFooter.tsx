'use client'

import { type ReactNode, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'

export function DashboardPageFooter({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null)

  useLayoutEffect(() => {
    setTarget(document.getElementById('dashboard-page-footer'))
  }, [])

  return target ? createPortal(children, target) : null
}
