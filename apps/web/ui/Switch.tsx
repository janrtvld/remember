'use client'

import { Switch as HeadlessSwitch } from '@headlessui/react'
import { type ComponentPropsWithoutRef, forwardRef } from 'react'
import { twMerge } from 'tailwind-merge'

const controlSizes = {
  small: 'h-8 w-10 rounded-md',
  medium: 'h-10 w-12 rounded-lg',
}

const trackSizes = {
  small: 'h-5 w-9',
  medium: 'h-6 w-10',
}

const thumbSizes = {
  small: 'top-0.5 left-0.5 size-4',
  medium: 'top-1 left-1 size-4',
}

export interface SwitchProps
  extends Omit<ComponentPropsWithoutRef<typeof HeadlessSwitch>, 'as' | 'children' | 'className'> {
  className?: string
  size?: keyof typeof controlSizes
}

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { className, size = 'medium', ...props },
  ref
) {
  return (
    <HeadlessSwitch
      ref={ref}
      className={twMerge(
        'group flex shrink-0 cursor-pointer items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-slate-400 data-[disabled]:cursor-wait',
        controlSizes[size],
        className
      )}
      {...props}
    >
      <span
        className={twMerge(
          'pointer-events-none relative rounded-full bg-switch-track transition-colors duration-150 ease-out group-data-[checked]:bg-blue-700 group-data-[disabled]:opacity-50 motion-reduce:transition-none',
          trackSizes[size]
        )}
      >
        <span
          className={twMerge(
            'absolute rounded-full bg-switch-thumb ring-2 ring-switch-thumb-ring shadow-softer transition-[background-color,transform] duration-150 ease-out group-data-[checked]:translate-x-4 group-data-[checked]:bg-switch-thumb-checked motion-reduce:transition-none',
            thumbSizes[size]
          )}
        />
      </span>
    </HeadlessSwitch>
  )
})
