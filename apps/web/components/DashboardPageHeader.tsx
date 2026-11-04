'use client'

import { type ReactNode, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'

export function DashboardPageHeader({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null)

  useLayoutEffect(() => {
    setTarget(document.getElementById('dashboard-page-header'))
  }, [])

  return target ? createPortal(children, target) : null
}
