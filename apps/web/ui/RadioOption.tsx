import type { ReactNode } from 'react'
import { twMerge } from 'tailwind-merge'

export function RadioOption({
  name,
  value,
  checked,
  disabled = false,
  title,
  description,
  action,
  className,
  onChange,
}: {
  name: string
  value?: string
  checked: boolean
  disabled?: boolean
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  className?: string
  onChange: () => void
}) {
  return (
    <div className={twMerge('group/radio-option flex min-h-11 items-start', disabled && 'opacity-60', className)}>
      <label
        className={twMerge('flex min-w-0 flex-1 cursor-pointer items-start gap-3 px-3 py-3', disabled && 'cursor-wait')}
      >
        <input
          type="radio"
          name={name}
          value={value}
          checked={checked}
          disabled={disabled}
          onChange={onChange}
          className="peer sr-only"
        />
        <span
          aria-hidden="true"
          className={twMerge(
            'mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full border bg-white transition-[background-color,border-color] duration-150 ease-out peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-slate-400 motion-reduce:transition-none',
            checked ? 'border-blue-700 bg-blue-700' : 'border-slate-300 group-hover/radio-option:border-slate-400'
          )}
        >
          <span className={twMerge('size-1.5 rounded-full', checked ? 'bg-on-brand' : 'bg-transparent')} />
        </span>
        <span className="min-w-0">
          <span className="block font-medium text-slate-900 text-sm">{title}</span>
          {description ? <span className="mt-0.5 block text-slate-500 text-xs leading-4">{description}</span> : null}
        </span>
      </label>
      {action ? <div className="flex shrink-0 items-start py-2.5 pr-2">{action}</div> : null}
    </div>
  )
}
