'use client'

import { DashboardContentHeader } from '@internal/components/DashboardContentHeader'
import { useI18n } from '@internal/locales'
import { Container } from '@internal/ui/Container'
import { PendingIndicator } from '@internal/ui/PendingIndicator'

export function ActivitiesLoadingState() {
  const { t } = useI18n()
  return (
    <Container className="flex grow flex-col gap-6 py-8 md:py-12">
      <DashboardContentHeader title={t('Activiteit')} />
      <PendingIndicator label={t('Activiteit laden')} />
    </Container>
  )
}
