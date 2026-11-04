'use client'

import { Listbox, ListboxButton, ListboxOption, ListboxOptions, MenuItems } from '@headlessui/react'
import { Check as IconCheckmark1Small, ChevronDown as IconChevronDownSmall } from 'lucide-react'
import type { ComponentProps } from 'react'
import { twMerge } from 'tailwind-merge'

const dropdownPanelStyle =
  'z-50 rounded-xl bg-white p-1 shadow-raised outline-none transition-[opacity,transform] duration-100 ease-out data-closed:scale-[0.98] data-closed:opacity-0 motion-reduce:transition-none'

export const dropdownItemStyle =
  'flex h-8 w-full cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 text-left font-medium text-slate-600 text-sm outline-none transition-colors duration-100 ease-out hover:bg-slate-100 hover:text-slate-900 data-focus:bg-slate-100 data-focus:text-slate-900 [&>svg]:size-3.5 [&>svg]:shrink-0 motion-reduce:transition-none'

export const dropdownDangerItemStyle = `${dropdownItemStyle} text-danger-700 hover:bg-danger-100 hover:text-danger-700 data-focus:bg-danger-100 data-focus:text-danger-700`

export function DropdownMenuItems({ className, transition = true, ...props }: ComponentProps<typeof MenuItems>) {
  return <MenuItems transition={transition} className={twMerge(dropdownPanelStyle, className)} {...props} />
}

export function DropdownSelect<Option extends string>({
  ariaLabel,
  className,
  disabled = false,
  formatLabel,
  onChange,
  options,
  value,
}: {
  ariaLabel: string
  className?: string
  disabled?: boolean
  formatLabel: (option: Option) => string
  onChange: (value: Option) => void
  options: readonly Option[]
  value: Option
}) {
  return (
    <Listbox value={value} disabled={disabled} onChange={onChange}>
      <ListboxButton
        aria-label={ariaLabel}
        className={twMerge(
          'group flex h-8 min-w-44 cursor-pointer items-center justify-between gap-3 rounded-lg bg-white px-2.5 text-left text-slate-700 text-ui shadow-raised outline-none transition-[background-color,box-shadow,color] duration-150 ease-out hover:bg-slate-50 hover:text-slate-900 hover:shadow-raised-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 data-disabled:cursor-wait data-disabled:bg-slate-50 data-disabled:text-slate-400 data-disabled:shadow-none motion-reduce:transition-none',
          className
        )}
      >
        <span className="truncate font-medium">{formatLabel(value)}</span>
        <IconChevronDownSmall
          className="size-3 shrink-0 text-slate-400 transition-transform duration-150 group-data-open:rotate-180 motion-reduce:transition-none"
          aria-hidden="true"
        />
      </ListboxButton>
      <ListboxOptions
        anchor="bottom end"
        transition
        className={twMerge(dropdownPanelStyle, 'mt-1 w-[var(--button-width)] min-w-44 origin-top-right')}
      >
        {options.map((option) => (
          <ListboxOption
            key={option}
            value={option}
            className={twMerge(
              dropdownItemStyle,
              'group justify-between gap-3 data-selected:font-medium data-selected:text-slate-900'
            )}
          >
            <span className="truncate">{formatLabel(option)}</span>
            <IconCheckmark1Small
              className="size-3.5 shrink-0 text-slate-700 opacity-0 group-data-selected:opacity-100"
              aria-hidden="true"
            />
          </ListboxOption>
        ))}
      </ListboxOptions>
    </Listbox>
  )
}
