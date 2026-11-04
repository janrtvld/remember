import { LoaderCircle as IconLoadingCircle } from 'lucide-react'
import type { ComponentProps } from 'react'
import { twMerge } from 'tailwind-merge'

const spinnerSizes = {
  xs: 'size-3',
  sm: 'size-3.5',
  md: 'size-4',
  lg: 'size-[18px]',
  xl: 'size-5',
}

export interface SpinnerProps
  extends Omit<ComponentProps<typeof IconLoadingCircle>, 'aria-hidden' | 'aria-label' | 'size'> {
  label?: string
  size?: keyof typeof spinnerSizes
}

export function Spinner({ className, label, size = 'md', ...props }: SpinnerProps) {
  const icon = (
    <IconLoadingCircle
      aria-hidden="true"
      className={twMerge(
        'shrink-0 animate-spin text-slate-500 motion-reduce:animate-none [&_path]:[stroke-width:2.5]',
        spinnerSizes[size],
        className
      )}
      {...props}
    />
  )

  if (!label) return icon
  return (
    <output aria-label={label} className="inline-flex shrink-0">
      {icon}
    </output>
  )
}
