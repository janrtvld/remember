import type { ReactNode } from 'react'

export function AgentSettingItem({
  title,
  info,
  description,
  children,
}: {
  title: string
  info?: ReactNode
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <li className="grid min-h-[64px] gap-2 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <h3 className="font-medium text-slate-900 text-ui">{title}</h3>
          {info}
        </div>
        {description ? (
          <div className="mt-0.5 text-pretty text-slate-500 text-xs leading-[1.5]">{description}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 sm:justify-end">{children}</div>
    </li>
  )
}
