import { DashboardShell } from '@internal/components/DashboardShell'
import { type ReactNode, Suspense } from 'react'

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <DashboardShell>
      <Suspense fallback={null}>{children}</Suspense>
    </DashboardShell>
  )
}
