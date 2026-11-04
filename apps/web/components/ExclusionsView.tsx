'use client'

import { DashboardContentHeader } from '@internal/components/DashboardContentHeader'
import { useI18n } from '@internal/locales'
import { Container } from '@internal/ui/Container'
import { CaptureControls } from './CaptureControls'
import { ExclusionsSettings } from './ExclusionsSettings'

export function ExclusionsView() {
  const { t } = useI18n()

  return (
    <Container className="flex grow flex-col gap-7 py-8 md:py-12">
      <DashboardContentHeader title={t('Privacy')} action={<CaptureControls />} />

      <section aria-label={t('Instellingen voor uitsluitingen')}>
        <ExclusionsSettings />
      </section>
    </Container>
  )
}
