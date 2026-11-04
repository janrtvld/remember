'use client'

import { DashboardPageHeader } from '@internal/components/DashboardPageHeader'
import { useI18n } from '@internal/locales'
import type { ReactNode } from 'react'

export function ConversationsPageHeader({ menu, action }: { menu?: ReactNode; action?: ReactNode }) {
  const { t } = useI18n()

  return (
    <DashboardPageHeader>
      <header className="flex min-h-[43px] items-center justify-between gap-3 border-slate-200 border-b pr-2.5 pl-3">
        <div className="flex min-w-0 items-center">
          <h1 className="flex h-7 items-center px-2 font-medium text-slate-800 text-sm">{t('Gesprekken')}</h1>
          {menu}
        </div>
        {action}
      </header>
    </DashboardPageHeader>
  )
}
