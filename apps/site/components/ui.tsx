import Image from 'next/image'
import Link from 'next/link'
import type { MouseEventHandler, PropsWithChildren, ReactNode } from 'react'
import { twMerge } from 'tailwind-merge'

export const DOWNLOAD_URL = 'https://github.com/janrtvld/remember/releases/latest/download/Remember-arm64.dmg'

export function Container({
  children,
  className,
  padding = 'regular',
}: PropsWithChildren<{ className?: string; padding?: 'none' | 'regular' }>) {
  return (
    <div className={twMerge('mx-auto w-full max-w-[1200px]', padding === 'regular' && 'px-6 sm:px-8', className)}>
      {children}
    </div>
  )
}

export function Button({
  children,
  href,
  disabled = false,
  variant = 'primary',
  size = 'large',
  className,
  onClick,
}: {
  children: ReactNode
  href: string
  disabled?: boolean
  variant?: 'primary' | 'secondary' | 'outline'
  size?: 'small' | 'large'
  className?: string
  onClick?: MouseEventHandler<HTMLAnchorElement>
}) {
  return (
    <Link
      href={href}
      aria-disabled={disabled || undefined}
      onClick={onClick}
      className={twMerge(
        'inline-flex shrink-0 items-center justify-center gap-2 rounded-xl transition-[transform,filter,background-color] duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500',
        size === 'small'
          ? 'px-3 py-2 text-sm font-semibold active:scale-[0.95]'
          : 'px-8 py-3 text-base font-bold active:scale-[0.98] md:text-lg',
        variant === 'primary'
          ? 'bg-brand-gradient text-slate-100 hover:brightness-110 hover:text-white'
          : variant === 'secondary'
            ? 'bg-slate-100 text-slate-800 hover:bg-slate-200'
            : 'border-slate-300 bg-white text-slate-800 hover:bg-slate-50',
        className
      )}
    >
      {children}
    </Link>
  )
}

export function SectionLabel({ children }: PropsWithChildren) {
  return (
    <div className="mx-auto w-fit rounded-full border border-slate-300 bg-white px-3 py-1 text-sm font-medium">
      {children}
    </div>
  )
}

export function SectionTitle({ children }: PropsWithChildren) {
  return (
    <h2 className="font-marketing text-center text-[24px] font-semibold leading-tight text-slate-900 sm:text-[38px]">
      {children}
    </h2>
  )
}

export function Logo({
  noText = false,
  wordmark = false,
  homeLabel = 'Remember home',
}: {
  noText?: boolean
  wordmark?: boolean
  homeLabel?: string
}) {
  if (wordmark) {
    return (
      <Link
        href="/"
        aria-label={homeLabel}
        className="flex items-center rounded-lg transition-transform duration-150 active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500"
      >
        <Image src="/wordmark.svg" width={5108} height={710} alt="" className="h-3 w-auto" priority />
      </Link>
    )
  }

  return (
    <Link
      href="/"
      aria-label={homeLabel}
      className="flex items-center gap-1.5 rounded-lg transition-transform duration-150 active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500"
    >
      <Image src="/logo.svg" width={96} height={96} alt="" className="size-6" priority />
      {noText ? null : (
        <span className="font-marketing text-lg font-semibold tracking-tight text-slate-700">Remember</span>
      )}
    </Link>
  )
}
