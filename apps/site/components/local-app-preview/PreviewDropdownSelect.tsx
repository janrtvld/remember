'use client'

import { Check as IconCheckmark1Small, ChevronDown as IconChevronDownSmall } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

export function PreviewDropdownSelect<Option extends string>({
  ariaLabel,
  className = '',
  onChange,
  options,
  size = 'default',
  value,
}: {
  ariaLabel: string
  className?: string
  onChange: (value: Option) => void
  options: ReadonlyArray<{ value: Option; label: string }>
  size?: 'compact' | 'default' | 'large'
  value: Option
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const selected = options.find((option) => option.value === value) ?? options[0]

  useEffect(() => {
    if (!open) return
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePress)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePress)
  }, [open])

  return (
    <div
      ref={rootRef}
      className={`relative ${className}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false)
      }}
    >
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={`group flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg bg-white px-2.5 text-left text-ui text-slate-700 shadow-raised outline-none transition-[background-color,box-shadow,color] duration-150 ease-out hover:bg-slate-50 hover:text-slate-900 hover:shadow-raised-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 motion-reduce:transition-none ${
          size === 'large' ? 'h-9 min-w-44' : size === 'compact' ? 'h-8 min-w-[7.5rem]' : 'h-8 min-w-44'
        }`}
      >
        <span className="truncate font-medium">{selected?.label ?? value}</span>
        <IconChevronDownSmall
          className={`size-3 shrink-0 text-slate-400 transition-transform duration-150 motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <div
          role="listbox"
          aria-label={ariaLabel}
          className="absolute top-full right-0 z-50 mt-1 w-full min-w-44 rounded-xl bg-white p-1 shadow-raised"
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              onClick={() => {
                onChange(option.value)
                setOpen(false)
              }}
              className="flex h-8 w-full cursor-pointer select-none items-center justify-between gap-3 rounded-lg px-2.5 text-left font-medium text-sm text-slate-600 outline-none transition-colors duration-100 ease-out hover:bg-slate-100 hover:text-slate-900 focus-visible:bg-slate-100 focus-visible:text-slate-900 motion-reduce:transition-none"
            >
              <span className="truncate">{option.label}</span>
              <IconCheckmark1Small
                className={`size-3.5 shrink-0 text-slate-700 ${option.value === value ? 'opacity-100' : 'opacity-0'}`}
                aria-hidden="true"
              />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
