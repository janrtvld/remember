'use client'

import { Button, type ButtonProps } from '@internal/ui/Button'
import { forwardRef } from 'react'
import { twMerge } from 'tailwind-merge'

const toneStyles = {
  neutral:
    'text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:hover:bg-transparent disabled:hover:text-slate-400',
  accent:
    'text-blue-700 hover:bg-blue-100/70 hover:text-blue-700 disabled:hover:bg-transparent disabled:hover:text-slate-400',
  danger:
    'text-danger-700 hover:bg-danger-100 hover:text-danger-700 disabled:hover:bg-transparent disabled:hover:text-slate-400',
}

const iconButtonSizes = {
  compact: 'size-6 before:-inset-1',
  default: 'size-8 before:-inset-1',
}

export interface IconButtonProps extends Omit<ButtonProps, 'aria-label' | 'color' | 'radius' | 'size' | 'variant'> {
  'aria-label': string
  size?: keyof typeof iconButtonSizes
  tone?: keyof typeof toneStyles
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, size = 'default', tone = 'neutral', ...props },
  ref
) {
  return (
    <Button
      ref={ref}
      size="small"
      variant="text"
      color={tone === 'danger' ? 'danger' : 'secondary'}
      radius="medium"
      className={twMerge('p-0', iconButtonSizes[size], toneStyles[tone], className)}
      {...props}
    />
  )
})
