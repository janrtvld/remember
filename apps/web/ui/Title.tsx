import type { PropsWithChildren } from 'react'
import { twMerge } from 'tailwind-merge'

export function Title({
  children,
  className,
  as: Component = 'h1',
}: PropsWithChildren<{ className?: string; as?: 'h1' | 'h2' | 'h3' }>) {
  return (
    <Component className={twMerge('font-display font-semibold text-slate-900 text-xl sm:text-2xl', className)}>
      {children}
    </Component>
  )
}
