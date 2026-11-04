import { Title } from '@internal/ui/Title'
import type { ReactNode } from 'react'
import { twMerge } from 'tailwind-merge'

export function DashboardContentHeader({
  title,
  action,
  className,
}: {
  title: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <header className={twMerge('flex min-h-10 items-start justify-between gap-4', className)}>
      <Title className="min-w-0 flex-1 text-balance leading-[1.15] tracking-[-0.015em]">{title}</Title>
      {action}
    </header>
  )
}
