'use client'

import { DashboardContentHeader } from '@internal/components/DashboardContentHeader'
import { useI18n } from '@internal/locales'
import { Button } from '@internal/ui/Button'
import { Container } from '@internal/ui/Container'
import { Spinner } from '@internal/ui/Spinner'
import { type ReactNode, useState } from 'react'

export function DashboardLoadError({
  title,
  message,
  onRetry,
  pageHeader,
}: {
  title: string
  message: string
  onRetry: () => Promise<void>
  pageHeader?: ReactNode
}) {
  const { t } = useI18n()
  const [retrying, setRetrying] = useState(false)

  async function retry() {
    if (retrying) return
    setRetrying(true)
    try {
      await onRetry()
    } finally {
      setRetrying(false)
    }
  }

  return (
    <>
      {pageHeader}
      <Container className="flex grow flex-col gap-6 py-8 md:py-12">
        {pageHeader ? null : <DashboardContentHeader title={title} />}
        <div className="flex min-h-64 flex-col items-center justify-center px-6 text-center">
          <p className="max-w-sm text-pretty text-slate-600 text-sm" role="alert">
            {message}
          </p>
          <Button
            size="small"
            variant="outline"
            color="secondary"
            className="mt-4"
            disabled={retrying}
            onClick={() => void retry()}
          >
            {retrying ? <Spinner size="xs" /> : null}
            {t('Probeer opnieuw')}
          </Button>
        </div>
      </Container>
    </>
  )
}
