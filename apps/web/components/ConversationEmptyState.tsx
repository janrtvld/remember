import type { ReactNode } from 'react'

export function ConversationEmptyState({
  title,
  description,
  action,
  status,
}: {
  title: string
  description: string
  action?: ReactNode
  status?: ReactNode
}) {
  return (
    <section className="relative flex min-h-56 flex-col items-center justify-center rounded-xl border border-black/[0.08] bg-white px-6 py-10 text-center">
      {status ? <div className="absolute top-3 right-3">{status}</div> : null}
      <h2 className="font-medium text-slate-800 text-sm">{title}</h2>
      <p className="mt-1 max-w-sm text-pretty text-slate-500 text-xs">{description}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </section>
  )
}
