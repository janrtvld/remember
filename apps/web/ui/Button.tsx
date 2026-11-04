'use client'

import { type ButtonHTMLAttributes, forwardRef } from 'react'
import { twMerge } from 'tailwind-merge'

const baseStyle =
  'inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap font-medium outline-none transition-[background-color,border-color,box-shadow,color,filter,transform] duration-150 ease-out focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 active:scale-[0.98] disabled:cursor-not-allowed disabled:text-slate-500! disabled:text-opacity-100 disabled:shadow-none disabled:brightness-100 disabled:transform-none motion-reduce:transition-none'

const solidDangerStyle =
  'bg-danger-700 text-on-danger shadow-raised hover:brightness-90 disabled:bg-slate-100 disabled:[background-image:none]'

const buttonStyles = {
  solid: {
    primary:
      'bg-brand-gradient text-on-brand shadow-raised hover:brightness-110 hover:text-on-brand disabled:bg-slate-100 disabled:[background-image:none]',
    secondary: 'bg-slate-100 text-slate-700 shadow-raised hover:bg-slate-200 hover:text-slate-900',
    danger: solidDangerStyle,
  },
  text: {
    primary: 'text-brand-gradient hover:brightness-110',
    secondary: 'text-slate-700 hover:text-slate-500',
    danger: 'text-danger-700 hover:brightness-90',
  },
  outline: {
    primary:
      'bg-white text-slate-700 shadow-raised hover:bg-slate-50 hover:text-slate-900 hover:shadow-raised-hover disabled:bg-slate-50',
    secondary:
      'bg-white text-slate-700 shadow-raised hover:bg-slate-50 hover:text-slate-900 hover:shadow-raised-hover disabled:bg-slate-50',
    danger: 'bg-white text-danger-700 shadow-raised hover:bg-danger-100 hover:shadow-raised-hover disabled:bg-slate-50',
  },
}

const radiusStyles = {
  small: 'rounded-md',
  medium: 'rounded-lg',
  full: 'rounded-full',
}

const buttonSizes = {
  small:
    "relative h-8 min-h-0 px-2.5 py-1.5 text-sm before:absolute before:-inset-y-1 before:inset-x-0 before:content-['']",
  medium:
    "relative h-9 min-h-0 px-4 text-md before:absolute before:-inset-y-0.5 before:inset-x-0 before:content-[''] sm:px-5",
  large: 'h-10 min-h-0 px-6 text-md md:text-lg',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  color?: keyof (typeof buttonStyles)['solid']
  variant?: keyof typeof buttonStyles
  size?: keyof typeof buttonSizes
  radius?: keyof typeof radiusStyles
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'solid', color = 'primary', size = 'small', radius = 'medium', type = 'button', className, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={twMerge(baseStyle, buttonStyles[variant][color], buttonSizes[size], radiusStyles[radius], className)}
      {...props}
    />
  )
})
