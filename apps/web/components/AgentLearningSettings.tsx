'use client'

import { useLocalBridge } from '@internal/context/LocalBridgeProvider'
import { useI18n } from '@internal/locales'
import { Switch } from '@internal/ui/Switch'
import { useState } from 'react'
import { AgentSettingItem } from './AgentSettingItem'

export function AgentLearningSettings() {
  const local = useLocalBridge()
  const { t } = useI18n()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function changeEnabled(enabled: boolean) {
    setPending(true)
    setError(null)
    try {
      await local.updateSettings({ agentLearningEnabled: enabled })
    } catch {
      setError(t('De keuze kon niet worden opgeslagen. Probeer het opnieuw.'))
    } finally {
      setPending(false)
    }
  }

  const enabled = local.settings?.agentLearningEnabled ?? false

  return (
    <AgentSettingItem
      title={t('Leren van agents')}
      description={
        error ? (
          <span className="text-danger-700" role="alert">
            {error}
          </span>
        ) : (
          t('Organiseer kennis uit je agentgesprekken automatisch in je Wiki’s.')
        )
      }
    >
      <Switch
        checked={enabled}
        disabled={pending || !local.settings}
        onChange={(value) => void changeEnabled(value)}
        aria-label={t('Leren van agents')}
      />
    </AgentSettingItem>
  )
}
