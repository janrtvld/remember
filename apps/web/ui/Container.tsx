import type { PropsWithChildren } from 'react'
import { twMerge } from 'tailwind-merge'

export function Container({ className, children }: PropsWithChildren<{ className?: string }>) {
  return <div className={twMerge('mx-auto w-full max-w-[800px] px-4 sm:px-6 lg:px-8', className)}>{children}</div>
}
