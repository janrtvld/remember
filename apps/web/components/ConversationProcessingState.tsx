'use client'

import { useI18n } from '@internal/locales'

export function ConversationProcessingLines({ kind = 'text' }: { kind?: 'text' | 'actions' }) {
  const { t } = useI18n()
  if (kind === 'actions') {
    return (
      <div className="mt-3 flex w-2/3 flex-col gap-1" role="status" aria-label={t('Gesprek verwerken')}>
        {[0, 1, 2].map((item) => (
          <span key={item} className="flex w-full items-center gap-2">
            <span className="size-2 shrink-0 rounded bg-slate-200" aria-hidden="true" />
            <span className="h-5 w-full animate-pulse rounded-md bg-slate-200 motion-reduce:animate-none" />
          </span>
        ))}
      </div>
    )
  }
  return (
    <div className="mt-3 grid gap-2" role="status" aria-label={t('Gesprek verwerken')}>
      <span className="h-5 animate-pulse rounded-md bg-slate-200 motion-reduce:animate-none" />
      <span className="h-5 w-4/5 animate-pulse rounded-md bg-slate-200 motion-reduce:animate-none" />
      <span className="h-5 w-2/3 animate-pulse rounded-md bg-slate-200 motion-reduce:animate-none" />
    </div>
  )
}

export function ConversationAudioSkeleton() {
  const { t } = useI18n()
  return (
    <span
      className="flex h-6 w-full max-w-[18rem] min-w-0 items-center gap-2"
      role="status"
      aria-label={t('Audio laden')}
    >
      <span className="-ml-1 size-6 shrink-0 animate-pulse rounded-md bg-slate-200 motion-reduce:animate-none" />
      <span className="h-4 w-9 shrink-0 animate-pulse rounded bg-slate-200 motion-reduce:animate-none" />
      <span className="h-1 min-w-12 flex-1 animate-pulse rounded-full bg-slate-200 motion-reduce:animate-none" />
      <span className="h-4 w-9 shrink-0 animate-pulse rounded bg-slate-200 motion-reduce:animate-none" />
      <span className="size-6 shrink-0 animate-pulse rounded-md bg-slate-200 motion-reduce:animate-none" />
    </span>
  )
}
