'use client'

import { DayIntroduction } from '@internal/components/DayIntroduction'
import { DayView } from '@internal/components/DayView'
import { useLocalBridge } from '@internal/context/LocalBridgeProvider'
import { useI18n } from '@internal/locales'
import { Button } from '@internal/ui/Button'
import { useState } from 'react'

export function StarterPreview() {
  const [open, setOpen] = useState(true)
  const { locale } = useI18n()
  const { settings } = useLocalBridge()
  return (
    <>
      <DayView view="day" />
      {!open && (
        <div className="fixed right-6 bottom-6 z-40">
          <Button color="secondary" onClick={() => setOpen(true)}>
            {locale === 'nl' ? 'Uitleg opnieuw bekijken' : 'Show introduction again'}
          </Button>
        </div>
      )}
      {settings && (
        <DayIntroduction
          open={open}
          provider={settings.dayAnalysisProvider ?? settings.defaultAgentProvider}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
