'use client'

import {
  Dialog,
  DialogBackdrop,
  DialogDescription,
  DialogPanel,
  DialogTitle,
  Menu,
  MenuButton,
  MenuItem,
} from '@headlessui/react'
import { DashboardContentHeader } from '@internal/components/DashboardContentHeader'
import { useLocalBridge } from '@internal/context/LocalBridgeProvider'
import { useI18n } from '@internal/locales'
import { Button } from '@internal/ui/Button'
import { Container } from '@internal/ui/Container'
import { DropdownMenuItems, DropdownSelect, dropdownItemStyle } from '@internal/ui/Dropdown'
import { IconButton } from '@internal/ui/IconButton'
import { PendingIndicator } from '@internal/ui/PendingIndicator'
import { Spinner } from '@internal/ui/Spinner'
import { Switch } from '@internal/ui/Switch'
import {
  type AgentProvider,
  type AgentRunContextCategory,
  type AgentRunTrace,
  type AgentSetup,
  type AgentTraceAction,
  type AgentTraceEvent,
  CLAUDE_ANALYSIS_EFFORTS,
  CLAUDE_ANALYSIS_MODELS,
  type ClaudeMcpSetupStatus,
  type CliSetupStatus,
  type CodexModel,
  compatibleCodexEffort,
  type Day,
  FALLBACK_CODEX_MODELS,
  type LocalSettings,
  MAX_FREQUENT_DAY_REFRESH_INTERVAL_MINUTES,
  MIN_FREQUENT_DAY_REFRESH_INTERVAL_MINUTES,
} from '@remember/shared'
import {
  Check as IconCheckmark1Small,
  X as IconCrossSmall,
  Ellipsis as IconDotGrid1x3HorizontalTight,
  TriangleAlert as IconExclamationTriangle,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AgentLearningSettings } from './AgentLearningSettings'
import { AgentProviderPicker } from './AgentProviderPicker'
import { AgentSettingItem } from './AgentSettingItem'
import { AgentUsageSection } from './AgentUsageSection'
import { agentSetupPresentation } from './agentSetupPresentation'

const cliActionLabels: Record<Exclude<AgentTraceAction, 'day-refresh'>, string> = {
  'agent-learning': 'Leren van agents',
  'context-import': 'Agentcontext naar Wiki verwerkt',
  'cli-status': 'Remember-archief gecontroleerd',
  'cli-days': 'Recente dagen opgehaald',
  'cli-day': 'Dagoverzicht gelezen',
  'cli-search': 'Werkgeschiedenis doorzocht',
  'cli-conversations': 'Gesprekken gelezen',
  'cli-usage': 'Appgebruik gecontroleerd',
  'cli-brief': 'Profiel en werkpatronen gelezen',
  'cli-wiki-spaces': 'Wiki-spaces opgehaald',
  'cli-wiki-list': 'Wikipagina’s opgehaald',
  'cli-wiki-search': 'Wiki doorzocht',
  'cli-wiki-read': 'Wikipagina gelezen',
  'cli-wiki-write': 'Wikipagina opgeslagen',
}

const AGENT_TRACE_PAGE_SIZE = 5

type Translate = (message: string, replacements?: Record<string, string | number>) => string

function traceTime(timestamp: number, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp)
}

function traceTimeWithSeconds(timestamp: number, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(timestamp)
}

function traceDate(timestamp: number, locale: string, t: Translate) {
  const date = new Date(timestamp)
  const today = new Date()
  if (date.toDateString() === today.toDateString()) return t('Vandaag')
  return new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' }).format(timestamp)
}

function StatusCircle({ status }: { status: AgentTraceEvent['status'] }) {
  return (
    <span
      className={`grid size-3.5 shrink-0 place-items-center rounded-full ${
        status === 'completed'
          ? 'bg-success-500 text-on-accent'
          : status === 'failed'
            ? 'bg-danger-700 text-on-danger'
            : ''
      }`}
      aria-hidden="true"
    >
      {status === 'completed' ? (
        <IconCheckmark1Small className="size-3" aria-hidden="true" />
      ) : status === 'failed' ? (
        <IconCrossSmall className="size-3" aria-hidden="true" />
      ) : (
        <Spinner size="sm" />
      )}
    </span>
  )
}

function traceStatusLabel(status: AgentTraceEvent['status'], t: Translate) {
  return status === 'completed' ? t('Voltooid') : status === 'failed' ? t('Mislukt') : t('Bezig')
}

function sentenceCase(label: string, locale: string) {
  return `${label.charAt(0).toLocaleUpperCase(locale)}${label.slice(1)}`
}

function dayLabel(dayId: string | null, days: Day[], locale: string, t: Translate) {
  const day = days.find((candidate) => candidate.id === dayId)
  if (!day) return t('dagoverzicht')
  const date = new Date(day.startedAt)
  if (date.toDateString() === new Date().toDateString()) return t('overzicht van vandaag')
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(date)
}

function traceTitle(event: AgentTraceEvent, days: Day[], locale: string, t: Translate) {
  if (event.action !== 'day-refresh') return t(cliActionLabels[event.action])
  const subject = dayLabel(event.dayId, days, locale, t)
  if (event.status === 'running') return t('{subject} bijwerken', { subject: sentenceCase(subject, locale) })
  if (event.status === 'failed') return t('Kon {subject} niet bijwerken', { subject })
  return t('{subject} bijgewerkt', { subject: sentenceCase(subject, locale) })
}

function providerLabel(event: AgentTraceEvent) {
  if (event.provider === 'codex') return 'Codex'
  if (event.provider === 'claude') return 'Claude'
  return 'Remember CLI'
}

function traceDetail(event: AgentTraceEvent, t: Translate) {
  if (event.action === 'agent-learning') return t('Nieuwe agentgesprekken')
  if (event.action !== 'day-refresh') return 'Remember CLI'
  if (event.reason === 'manual') return t('Handmatig bijgewerkt')
  if (event.reason === 'downtime') return t('Automatisch bijgewerkt')
  if (event.reason === 'active-interval') return t('Tijdens actief werk bijgewerkt')
  if (event.reason === 'end-of-day') return t('Bijgewerkt aan het einde van de dag')
  return t('Dag bijgewerkt')
}

function localizedTraceMessage(message: string, t: Translate) {
  const learning = /^(\d+) Wiki-wijzigingen opgeslagen; (\d+) bronnen wachten op verwerking\.$/.exec(message)
  if (learning)
    return t('{saved} Wiki-wijzigingen opgeslagen; {deferred} bronnen wachten op verwerking.', {
      saved: learning[1],
      deferred: learning[2],
    })
  const version = /^Remember-versie (.+)$/.exec(message)
  if (version) return t('Remember-versie {version}', { version: version[1] })
  const prepared = /^(\d+) dagdelen zijn voorbereid$/.exec(message)
  if (prepared) return t('{count} dagdelen zijn voorbereid', { count: prepared[1] })
  const analyzed = /^(\d+) van (\d+) dagdelen geanalyseerd$/.exec(message)
  if (analyzed)
    return t('{completed} van {total} dagdelen geanalyseerd', { completed: analyzed[1], total: analyzed[2] })
  const openPoints = /^(\d+) (?:open punt|open punten) gevonden$/.exec(message)
  if (openPoints) return t('{count} open punten gevonden', { count: openPoints[1] })
  const wikiPages = /^(\d+) wiki-(?:pagina|pagina’s) bijgewerkt$/.exec(message)
  if (wikiPages) return t('{count} wiki-pagina’s bijgewerkt', { count: wikiPages[1] })
  const conversations = /^(\d+) gesprekken samengevat$/.exec(message)
  if (conversations) return t('{count} gesprekken samengevat', { count: conversations[1] })
  return t(message)
}

function formatRunDuration(durationMs: number, t: Translate) {
  if (durationMs < 1_000) return `${durationMs} ms`
  if (durationMs < 60_000) return t('{count} sec', { count: Math.round(durationMs / 1_000) })
  const minutes = Math.floor(durationMs / 60_000)
  const seconds = Math.round((durationMs % 60_000) / 1_000)
  return t('{minutes} min {seconds} sec', { minutes, seconds })
}

const contextLabels: Record<AgentRunContextCategory['category'], string> = {
  'app-usage': 'appgebruiksitems',
  'screen-context': 'venstercontextitems',
  'audio-transcripts': 'audiotranscripties',
  wiki: 'wiki-items',
}

function AgentTraceRow({ event, days, onInspect }: { event: AgentTraceEvent; days: Day[]; onInspect: () => void }) {
  const { dateLocale, t } = useI18n()
  const title = traceTitle(event, days, dateLocale, t)

  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 px-4 py-3.5">
      <div className="flex h-5 items-center">
        <StatusCircle status={event.status} />
        <span className="sr-only">{traceStatusLabel(event.status, t)}</span>
      </div>
      <div className="min-w-0">
        <p className="truncate font-semibold text-slate-900 text-sm">{title}</p>
        <p className="truncate text-slate-500 text-xs">
          {providerLabel(event)} · {traceDetail(event, t)}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <time
          dateTime={new Date(event.startedAt).toISOString()}
          className="hidden pt-0.5 text-slate-500 text-xs tabular-nums sm:block"
        >
          {traceDate(event.startedAt, dateLocale, t)}, {traceTime(event.startedAt, dateLocale)}
        </time>
        <Menu>
          <MenuButton
            as={IconButton}
            aria-label={t('Meer opties voor {title}', { title })}
            size="compact"
            className="cursor-pointer data-open:bg-slate-100 data-open:text-slate-700"
          >
            <IconDotGrid1x3HorizontalTight className="size-3" aria-hidden="true" />
          </MenuButton>
          <DropdownMenuItems anchor="bottom end" className="mt-1 w-36 origin-top-right">
            <MenuItem>
              <button type="button" onClick={onInspect} className={dropdownItemStyle}>
                {t('Bekijk details')}
              </button>
            </MenuItem>
          </DropdownMenuItems>
        </Menu>
      </div>
    </li>
  )
}

function AgentTraceModal({
  event,
  run,
  days,
  onClose,
}: {
  event: AgentTraceEvent | null
  run: AgentRunTrace | null
  days: Day[]
  onClose: () => void
}) {
  const { dateLocale, t } = useI18n()
  const finishedAt = event?.completedAt ?? null
  const durationMs = event ? (run?.durationMs ?? (finishedAt ? finishedAt - event.startedAt : null)) : null
  const error = event?.error ?? run?.error ?? null

  const logLines: { timestamp: number; message: string; tone?: 'danger' | 'muted' }[] = event
    ? [
        {
          timestamp: event.startedAt,
          message: t('{provider} gestart · {detail}', {
            provider: providerLabel(event),
            detail: traceDetail(event, t),
          }),
        },
        ...(run?.contextUsed.map((context) => ({
          timestamp: event.startedAt,
          message: t('{count} {category} geladen', {
            count: context.itemCount,
            category: t(contextLabels[context.category]),
          }),
          tone: 'muted' as const,
        })) ?? []),
        ...event.logs.map((entry) => ({
          timestamp: entry.timestamp,
          message: localizedTraceMessage(entry.message, t),
        })),
        ...(run?.insights.map((insight) => ({
          timestamp: finishedAt ?? event.startedAt,
          message: localizedTraceMessage(insight, t),
        })) ?? []),
        ...(event.status === 'failed'
          ? [
              {
                timestamp: finishedAt ?? event.startedAt,
                message: `${t('Mislukt')}${error ? ` · ${error}` : ''}`,
                tone: 'danger' as const,
              },
            ]
          : event.status === 'completed'
            ? [
                {
                  timestamp: finishedAt ?? event.startedAt,
                  message: `${t('Voltooid')}${durationMs != null ? ` ${t('in {duration}', { duration: formatRunDuration(durationMs, t) })}` : ''}`,
                },
              ]
            : [{ timestamp: event.startedAt, message: t('Run is nog bezig'), tone: 'muted' as const }]),
      ].sort((left, right) => left.timestamp - right.timestamp)
    : []

  return (
    <Dialog open={event !== null} onClose={onClose} className="app-no-drag relative z-50">
      <DialogBackdrop
        transition
        className="fixed inset-0 bg-modal-backdrop backdrop-blur-[1px] transition-opacity data-[closed]:opacity-0 motion-reduce:transition-none ease-[cubic-bezier(0.215,0.61,0.355,1)] data-[leave]:ease-out duration-(--modal-enter-duration) data-[leave]:duration-(--modal-exit-duration)"
      />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel
          transition
          className="flex max-h-[calc(100dvh-2rem)] w-full max-w-lg origin-center flex-col overflow-hidden rounded-xl bg-white shadow-raised transition-[opacity,scale] data-[closed]:scale-[0.98] data-[closed]:opacity-0 motion-reduce:transition-none ease-[cubic-bezier(0.215,0.61,0.355,1)] data-[leave]:ease-out duration-(--modal-enter-duration) data-[leave]:duration-(--modal-exit-duration)"
        >
          {event ? (
            <>
              <header className="flex shrink-0 items-start justify-between gap-4 border-slate-100 border-b px-4 py-3.5">
                <div className="min-w-0">
                  <DialogTitle className="truncate font-semibold text-slate-950 text-md">
                    {traceTitle(event, days, dateLocale, t)}
                  </DialogTitle>
                  <DialogDescription className="mt-0.5 text-slate-500 text-xs">
                    {providerLabel(event)} · {traceDate(event.startedAt, dateLocale, t)},{' '}
                    {traceTime(event.startedAt, dateLocale)}
                  </DialogDescription>
                </div>
                <IconButton aria-label={t('Sluit trace log')} onClick={onClose}>
                  <IconCrossSmall className="size-4" aria-hidden="true" />
                </IconButton>
              </header>

              <div className="min-h-0 overflow-y-auto overscroll-contain p-4">
                <div className="mb-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
                  <div>
                    <p className="text-slate-400 text-xs">{t('Status')}</p>
                    <p className="mt-0.5 flex items-center gap-2 font-medium text-slate-800 text-sm">
                      <StatusCircle status={event.status} />
                      {traceStatusLabel(event.status, t)}
                    </p>
                  </div>
                  <div>
                    <p className="text-slate-400 text-xs">{t('Agent')}</p>
                    <p className="mt-0.5 font-medium text-slate-800 text-sm">{providerLabel(event)}</p>
                  </div>
                  <div>
                    <p className="text-slate-400 text-xs">{t('Looptijd')}</p>
                    <p className="mt-0.5 font-medium text-slate-800 text-sm tabular-nums">
                      {durationMs == null ? t('Bezig') : formatRunDuration(durationMs, t)}
                    </p>
                  </div>
                </div>

                <h3 className="mb-2 font-medium text-slate-800 text-sm">{t('Activiteit')}</h3>
                <ol className="overflow-hidden rounded-lg bg-slate-50 py-1 shadow-inset">
                  {logLines.map((line, index) => (
                    <li
                      key={`${line.timestamp}-${index}`}
                      className="grid grid-cols-[64px_minmax(0,1fr)] gap-3 px-3 py-2 font-mono text-xs leading-5"
                    >
                      <time className="text-slate-400 tabular-nums" dateTime={new Date(line.timestamp).toISOString()}>
                        {traceTimeWithSeconds(line.timestamp, dateLocale)}
                      </time>
                      <span
                        className={
                          line.tone === 'danger'
                            ? 'text-danger-700'
                            : line.tone === 'muted'
                              ? 'text-slate-500'
                              : 'text-slate-700'
                        }
                      >
                        {line.message}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            </>
          ) : null}
        </DialogPanel>
      </div>
    </Dialog>
  )
}

function modelLabel(model: string) {
  if (/^gpt-/i.test(model)) {
    return model.replace(/^gpt-/i, 'GPT-').replace(/-([a-z])/g, (_, letter: string) => ` ${letter.toUpperCase()}`)
  }
  return model.charAt(0).toUpperCase() + model.slice(1)
}

function effortLabel(effort: string) {
  if (effort === 'xhigh') return 'X-high'
  return effort.charAt(0).toUpperCase() + effort.slice(1)
}

function RefreshIntervalInput({
  value,
  disabled,
  onChange,
}: {
  value: number
  disabled: boolean
  onChange: (value: number) => void
}) {
  const { t } = useI18n()
  const [draft, setDraft] = useState(String(value))
  const [error, setError] = useState<string | null>(null)
  const parsedDraft = Number(draft)
  const draftIsInvalid =
    !draft.trim() ||
    !Number.isInteger(parsedDraft) ||
    parsedDraft < MIN_FREQUENT_DAY_REFRESH_INTERVAL_MINUTES ||
    parsedDraft > MAX_FREQUENT_DAY_REFRESH_INTERVAL_MINUTES

  useEffect(() => {
    setDraft(String(value))
    setError(null)
  }, [value])

  const commit = () => {
    const parsed = Number(draft)
    if (draftIsInvalid) {
      setDraft(String(value))
      setError(t('Gebruik een heel getal van 1 tot en met 1440 minuten.'))
      return
    }
    setError(null)
    setDraft(String(parsed))
    if (parsed !== value) onChange(parsed)
  }

  return (
    <div className="grid justify-items-end gap-1">
      <label className="flex h-8 items-center gap-1 rounded-md border border-slate-200 bg-white px-2 text-slate-500 text-xs has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-slate-400">
        <input
          aria-label={t('Interval voor automatisch bijwerken in minuten')}
          aria-describedby={error ? 'refresh-interval-error' : undefined}
          aria-invalid={draftIsInvalid}
          type="number"
          min={MIN_FREQUENT_DAY_REFRESH_INTERVAL_MINUTES}
          max={MAX_FREQUENT_DAY_REFRESH_INTERVAL_MINUTES}
          step={1}
          value={draft}
          disabled={disabled}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
          className="w-10 bg-transparent text-right text-slate-800 text-ui tabular-nums outline-none disabled:text-slate-400"
        />
        <span>min</span>
      </label>
      {error ? (
        <span
          id="refresh-interval-error"
          role="alert"
          className="max-w-52 text-right text-danger-700 text-[11px] leading-4"
        >
          {error}
        </span>
      ) : null}
    </div>
  )
}

function LiveTaskUpdatesSetting() {
  const local = useLocalBridge()
  const { t } = useI18n()
  const [updating, setUpdating] = useState(false)
  const [error, setError] = useState(false)
  const settings = local.settings

  if (!settings) return null
  const title = t('Proactief helpen')

  const change = async (enabled: boolean) => {
    if (!local.bridge) return
    setUpdating(true)
    setError(false)
    try {
      await local.bridge.updateSettings({ liveTaskUpdates: enabled })
      await local.refresh()
    } catch {
      setError(true)
    } finally {
      setUpdating(false)
    }
  }

  return (
    <AgentSettingItem
      title={title}
      description={
        error ? (
          <span role="alert" className="text-danger-700">
            {t('De instelling kon niet worden opgeslagen. Probeer opnieuw.')}
          </span>
        ) : settings.offlineMode ? (
          t('Gepauzeerd zolang Offline mode aanstaat.')
        ) : (
          t('Werk je taken bij tijdens het werk en meld het als iets aandacht nodig heeft.')
        )
      }
    >
      <Switch
        aria-label={title}
        checked={settings.liveTaskUpdates}
        disabled={
          updating ||
          ((!settings.cloudAnalysisConsent || settings.offlineMode || !settings.dayAnalysisProvider) &&
            !settings.liveTaskUpdates)
        }
        onChange={(enabled) => void change(enabled)}
      />
    </AgentSettingItem>
  )
}

function AiProcessingConsentSetting() {
  const local = useLocalBridge()
  const { t } = useI18n()
  const [saving, setSaving] = useState(false)
  const [failedValue, setFailedValue] = useState<boolean | null>(null)
  const controlRef = useRef<HTMLButtonElement>(null)
  const retryRef = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)
  const settings = local.settings

  useEffect(() => {
    if (saving || !restoreFocus.current) return
    restoreFocus.current = false
    const focused = document.activeElement
    if (document.hasFocus() && (focused === document.body || focused === document.documentElement)) {
      controlRef.current?.focus({ preventScroll: true })
    }
  }, [saving])

  if (!settings) return null

  const change = async (enabled: boolean) => {
    if (!local.bridge || saving) return
    restoreFocus.current = document.activeElement === controlRef.current || document.activeElement === retryRef.current
    setSaving(true)
    setFailedValue(null)
    try {
      await local.updateSettings({
        cloudAnalysisConsent: enabled,
        ...(enabled ? { cloudConsentNoticeSeen: true } : {}),
      })
    } catch {
      setFailedValue(enabled)
    } finally {
      setSaving(false)
    }
  }

  return (
    <AgentSettingItem
      title={t('AI-verwerking toestaan')}
      description={
        <>
          <p id="agent-ai-consent-scope">
            {t(
              'Relevante schermtekst, transcripties, taken en Space-pagina’s mogen naar je gekozen AI. Audiobestanden blijven op je Mac.'
            )}
          </p>
          {failedValue !== null ? (
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
              <span id="agent-ai-consent-error" role="alert" className="text-danger-700">
                {t('De toestemming kon niet worden opgeslagen. Probeer opnieuw.')}
              </span>
              <Button
                ref={retryRef}
                size="small"
                variant="text"
                color="secondary"
                onClick={() => void change(failedValue)}
              >
                {t('Opnieuw proberen')}
              </Button>
            </div>
          ) : null}
        </>
      }
    >
      <div className="flex items-center gap-2">
        <span role="status" className="inline-flex h-5 w-20 items-center justify-end gap-1 text-slate-500 text-xs">
          {saving ? (
            <>
              <Spinner size="xs" />
              {t('Opslaan…')}
            </>
          ) : null}
        </span>
        <Switch
          ref={controlRef}
          id="agent-ai-consent"
          aria-label={t('AI-verwerking toestaan')}
          aria-describedby={
            failedValue === null ? 'agent-ai-consent-scope' : 'agent-ai-consent-scope agent-ai-consent-error'
          }
          aria-busy={saving}
          checked={settings.cloudAnalysisConsent}
          disabled={saving}
          className="pointer-coarse:min-h-11"
          onChange={(enabled) => void change(enabled)}
        />
      </div>
    </AgentSettingItem>
  )
}

function FrequentDayRefreshSetting() {
  const local = useLocalBridge()
  const { t } = useI18n()
  const [updating, setUpdating] = useState(false)

  if (!local.settings) return null
  const settings = local.settings

  const refreshInterval = settings.frequentDayRefreshIntervalMinutes
  const refreshIntervalLabel =
    refreshInterval === 1 ? t('elke minuut') : t('elke {count} minuten', { count: refreshInterval })
  const offlineMode = settings.offlineMode

  const updateSetting = async (patch: Parameters<typeof window.remember.updateSettings>[0]) => {
    setUpdating(true)
    try {
      await window.remember.updateSettings(patch)
      await local.refresh()
    } finally {
      setUpdating(false)
    }
  }

  return (
    <AgentSettingItem
      title={t('Automatisch bijwerken')}
      description={
        offlineMode
          ? t('Gepauzeerd zolang Offline mode aanstaat.')
          : t('Werk je dagoverzicht {interval} bij zolang je actief bent en er nieuwe data is.', {
              interval: refreshIntervalLabel,
            })
      }
    >
      <div className="flex items-center gap-2">
        <RefreshIntervalInput
          value={refreshInterval}
          disabled={!settings.frequentDayRefresh || updating || offlineMode}
          onChange={(frequentDayRefreshIntervalMinutes) => void updateSetting({ frequentDayRefreshIntervalMinutes })}
        />
        <Switch
          aria-label={t('Automatisch bijwerken')}
          checked={settings.frequentDayRefresh}
          disabled={updating || (offlineMode && !settings.frequentDayRefresh)}
          onChange={(frequentDayRefresh) => void updateSetting({ frequentDayRefresh })}
        />
      </div>
    </AgentSettingItem>
  )
}

function AgentConnectionSetting({ agent, provider }: { agent: AgentSetup | null; provider: AgentProvider }) {
  const local = useLocalBridge()
  const { locale, t } = useI18n()
  const [pendingAction, setPendingAction] = useState<'sign-in' | 'check' | 'disconnect' | null>(null)
  const [reconnectError, setReconnectError] = useState(false)
  const busy = pendingAction !== null
  const providerName = provider === 'codex' ? 'ChatGPT' : 'Claude'
  const status = agent?.provider === provider ? agent.status : null
  const presentation = agentSetupPresentation(provider, status, busy, locale)
  const offlineMode = local.settings?.offlineMode === true

  const act = async () => {
    if (busy || presentation.disabled || offlineMode) return
    const action = status === 'ready' ? 'disconnect' : status === 'error' ? 'check' : 'sign-in'
    setPendingAction(action)
    setReconnectError(false)
    try {
      if (action === 'disconnect') await window.remember.logoutAgent()
      else if (action === 'sign-in') await window.remember.openAgentLogin(provider)
      if (provider !== local.settings?.defaultAgentProvider) await local.refreshAgent(provider)
      await local.refresh()
    } catch {
      if (action === 'sign-in') setReconnectError(true)
      await local.refresh().catch(() => undefined)
    } finally {
      setPendingAction(null)
    }
  }

  const control =
    status === 'ready' ? (
      <Menu>
        <MenuButton
          as={IconButton}
          aria-label={t('Meer opties voor {title}', { title: providerName })}
          className="cursor-pointer bg-white text-slate-700 shadow-raised hover:bg-slate-50 hover:text-slate-900 hover:shadow-raised-hover data-open:bg-slate-100 data-open:text-slate-900 disabled:bg-slate-50"
          disabled={presentation.disabled || offlineMode}
          aria-busy={busy}
        >
          <IconDotGrid1x3HorizontalTight className="size-3.5" aria-hidden="true" />
        </MenuButton>
        <DropdownMenuItems anchor="bottom end" className="mt-1 w-36 origin-top-right">
          <MenuItem>
            <button type="button" onClick={() => void act()} className={dropdownItemStyle}>
              {t('Verbreek')}
            </button>
          </MenuItem>
        </DropdownMenuItems>
      </Menu>
    ) : (
      <Button
        size="small"
        variant="outline"
        color="secondary"
        radius="small"
        className="relative h-7 min-h-0 min-w-28 justify-center px-2.5 py-0 text-xs before:absolute before:-inset-y-1.5 before:inset-x-0 before:content-['']"
        disabled={presentation.disabled || offlineMode}
        aria-busy={!offlineMode && (busy || status === 'checking' || status == null)}
        onClick={() => void act()}
      >
        {offlineMode
          ? t('Gepauzeerd')
          : pendingAction === 'sign-in'
            ? t('Aanmelden…')
            : status === 'signed-out' && !busy
              ? t('Opnieuw verbinden')
              : presentation.actionLabel}
      </Button>
    )

  return (
    <AgentSettingItem
      title={provider === 'codex' ? 'ChatGPT-account' : 'Claude-account'}
      description={
        reconnectError && status !== 'ready' ? (
          <span className="text-danger-700" role="alert">
            {t('Opnieuw verbinden mislukt. Probeer het opnieuw.')}
          </span>
        ) : (
          agentConnectionDescription(provider, agent, offlineMode, t)
        )
      }
    >
      {control}
    </AgentSettingItem>
  )
}

function ClaudeMcpControl() {
  const { t } = useI18n()
  const [status, setStatus] = useState<ClaudeMcpSetupStatus | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    void window.remember
      .getClaudeMcpSetupStatus()
      .then((nextStatus) => {
        if (active) setStatus(nextStatus)
      })
      .catch(() => {
        if (active) setLoadError(true)
      })
    return () => {
      active = false
    }
  }, [])

  const retryStatus = async () => {
    setLoadError(false)
    setStatus(null)
    try {
      setStatus(await window.remember.getClaudeMcpSetupStatus())
    } catch {
      setLoadError(true)
    }
  }

  const connect = async () => {
    if (busy || status?.connected || status?.conflict) return
    setBusy(true)
    try {
      setStatus(await window.remember.installClaudeMcp())
    } catch {
      setLoadError(true)
    } finally {
      setBusy(false)
    }
  }

  let description = t('Lokale verbinding controleren…')
  if (loadError) {
    description = t('De lokale connectorstatus kon niet worden gecontroleerd.')
  } else if (status?.connected) {
    description = t('Remember staat als lokale connector in Claude. Herstart Claude Desktop om hem te laden.')
  } else if (status?.conflict) {
    description = t('Claude heeft al een andere MCP-verbinding met de naam Remember.')
  } else if (status?.error) {
    description = t('De lokale connector kon niet in Claude Desktop worden ingesteld.')
  } else if (status) {
    description = t('Voeg Remember als lokale, alleen-lezen connector toe aan Claude Desktop.')
  }

  return (
    <AgentSettingItem title="Claude Desktop" description={description}>
      <Button
        size="small"
        variant="outline"
        color="secondary"
        radius="small"
        className="relative h-7 min-h-0 min-w-28 justify-center gap-1.5 px-2.5 py-0 text-xs before:absolute before:-inset-y-1.5 before:inset-x-0 before:content-['']"
        disabled={busy || (!loadError && (status == null || status.connected || status.conflict))}
        aria-busy={busy || (!loadError && status == null)}
        onClick={() => {
          if (loadError) {
            void retryStatus()
          } else {
            void connect()
          }
        }}
      >
        {status?.connected ? (
          <IconCheckmark1Small className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" aria-hidden="true" />
        ) : null}
        {loadError
          ? t('Probeer opnieuw')
          : busy
            ? t('Verbinden…')
            : status?.connected
              ? t('Verbonden')
              : status?.conflict
                ? t('Al ingesteld')
                : t('Verbind')}
      </Button>
    </AgentSettingItem>
  )
}

function agentConnectionDescription(
  provider: LocalSettings['defaultAgentProvider'],
  agent: AgentSetup | null,
  offlineMode: boolean,
  t: ReturnType<typeof useI18n>['t']
) {
  if (offlineMode) return t('Gepauzeerd zolang Offline mode aanstaat.')
  const status = agent?.provider === provider ? agent.status : null
  if (status === 'signed-out') {
    return (
      <span className="inline-flex items-center gap-1.5 text-amber-700" role="status">
        <IconExclamationTriangle className="size-3.5 shrink-0" aria-hidden="true" />
        {t('Verbind {provider} opnieuw om de verwerking te hervatten.', {
          provider: provider === 'codex' ? 'ChatGPT' : 'Claude',
        })}
      </span>
    )
  }
  if (provider === 'codex') {
    if (status === 'ready')
      return t('Remember gebruikt je gekoppelde ChatGPT-account om kennis en je werkdag te verwerken.')
    if (status === 'missing') return t('De ingebouwde ChatGPT-verbinding is niet beschikbaar.')
    if (status === 'error') return t('De ChatGPT-verbinding kon niet worden gecontroleerd.')
    return t('ChatGPT-verbinding controleren…')
  }
  if (status === 'ready')
    return t('Remember gebruikt je gekoppelde Claude-account. Anthropic kan hiervoor usage credits gebruiken.')
  if (status === 'missing') return t('De ingebouwde Claude-verbinding is niet beschikbaar.')
  if (status === 'error') return t('De Claude-verbinding kon niet worden gecontroleerd.')
  return t('Claude-verbinding controleren…')
}

function AnalysisAgentSettings() {
  const local = useLocalBridge()
  const { t } = useI18n()
  const [pendingSetting, setPendingSetting] = useState<'provider' | 'model' | 'effort' | null>(null)
  const [codexModels, setCodexModels] = useState<CodexModel[]>(FALLBACK_CODEX_MODELS)

  useEffect(() => {
    if (local.settings?.defaultAgentProvider !== 'codex') return
    let active = true
    const refreshModels = () => {
      void window.remember
        .getCodexModels()
        .then((models) => {
          if (active && models.length) setCodexModels(models)
        })
        .catch(() => undefined)
    }
    refreshModels()
    if (local.settings.offlineMode || local.agent?.status === 'signed-out')
      return () => {
        active = false
      }
    window.addEventListener('focus', refreshModels)
    const interval = window.setInterval(refreshModels, 5 * 60_000)
    return () => {
      active = false
      window.removeEventListener('focus', refreshModels)
      window.clearInterval(interval)
    }
  }, [local.settings?.defaultAgentProvider, local.settings?.offlineMode, local.agent?.status])

  if (!local.settings) return null
  const settings = local.settings

  const changeSetting = async (
    setting: 'provider' | 'model' | 'effort',
    patch: Parameters<typeof window.remember.updateSettings>[0]
  ) => {
    if (pendingSetting) return
    setPendingSetting(setting)
    try {
      await window.remember.updateSettings(patch)
      await local.refresh()
    } catch {
      await local.refresh().catch(() => undefined)
    } finally {
      setPendingSetting(null)
    }
  }

  const isCodex = settings.defaultAgentProvider === 'codex'
  const providerLabel = isCodex ? 'ChatGPT' : 'Claude'
  const otherProvider =
    settings.dayAnalysisProvider !== settings.defaultAgentProvider ? settings.dayAnalysisProvider : null
  const otherAgent = otherProvider ? local.agentConnections[otherProvider] : null
  const analysisModels = isCodex
    ? [...new Set([...codexModels.map((model) => model.model), settings.codexAnalysisModel])]
    : CLAUDE_ANALYSIS_MODELS
  const selectedModel = isCodex ? settings.codexAnalysisModel : settings.claudeAnalysisModel
  const selectedEffort = isCodex ? settings.codexAnalysisEffort : settings.claudeAnalysisEffort
  const selectedCodexModel = codexModels.find((model) => model.model === selectedModel)
  const analysisEfforts = isCodex
    ? (selectedCodexModel?.supportedReasoningEfforts ?? [selectedEffort])
    : CLAUDE_ANALYSIS_EFFORTS

  return (
    <>
      <AgentSettingItem title={t('Agent')} description={t('Koppel je ChatGPT- of Claude-account rechtstreeks.')}>
        <AgentProviderPicker
          name="agent-page-provider"
          value={settings.defaultAgentProvider}
          disabled={pendingSetting !== null}
          onChange={(provider) =>
            void changeSetting('provider', {
              defaultAgentProvider: provider,
              ...(settings.dayAnalysisProvider == null ? {} : { dayAnalysisProvider: provider }),
            })
          }
        />
      </AgentSettingItem>
      <AgentConnectionSetting
        key={settings.defaultAgentProvider}
        agent={local.agent}
        provider={settings.defaultAgentProvider}
      />
      {otherProvider && otherAgent?.status === 'signed-out' ? (
        <AgentConnectionSetting key={otherProvider} agent={otherAgent} provider={otherProvider} />
      ) : null}
      {!isCodex ? <ClaudeMcpControl /> : null}
      <AgentSettingItem
        title="Model"
        description={t('Het model dat {provider} gebruikt om kennis en je werkdag te verwerken.', {
          provider: providerLabel,
        })}
      >
        <DropdownSelect
          ariaLabel={t('Kies het analysemodel voor {provider}', { provider: providerLabel })}
          value={selectedModel}
          options={analysisModels}
          formatLabel={modelLabel}
          disabled={pendingSetting !== null}
          onChange={(value) =>
            void changeSetting(
              'model',
              isCodex
                ? {
                    codexAnalysisModel: value,
                    codexAnalysisEffort: compatibleCodexEffort(
                      codexModels.find((model) => model.model === value),
                      settings.codexAnalysisEffort
                    ),
                  }
                : { claudeAnalysisModel: value as LocalSettings['claudeAnalysisModel'] }
            )
          }
        />
      </AgentSettingItem>
      <AgentSettingItem
        title={t('Effort')}
        description={t('Hoe grondig {provider} de analyse uitwerkt.', { provider: providerLabel })}
      >
        <DropdownSelect
          ariaLabel={t('Kies de analyse-effort voor {provider}', { provider: providerLabel })}
          value={selectedEffort}
          options={analysisEfforts}
          formatLabel={effortLabel}
          disabled={pendingSetting !== null}
          onChange={(value) =>
            void changeSetting(
              'effort',
              isCodex
                ? { codexAnalysisEffort: value as LocalSettings['codexAnalysisEffort'] }
                : { claudeAnalysisEffort: value as LocalSettings['claudeAnalysisEffort'] }
            )
          }
        />
      </AgentSettingItem>
      <AiProcessingConsentSetting />
      <LiveTaskUpdatesSetting />
      <FrequentDayRefreshSetting />
    </>
  )
}

export function AgentView() {
  const local = useLocalBridge()
  const { t } = useI18n()
  const [status, setStatus] = useState<CliSetupStatus | null>(null)
  const [statusError, setStatusError] = useState(false)
  const [trace, setTrace] = useState<AgentTraceEvent[] | null>(null)
  const [traceError, setTraceError] = useState(false)
  const [visibleTraceCount, setVisibleTraceCount] = useState(AGENT_TRACE_PAGE_SIZE)
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const traceActiveRef = useRef(true)
  const traceLoadRef = useRef<Promise<void> | null>(null)

  const loadTrace = useCallback(() => {
    if (traceLoadRef.current) return traceLoadRef.current
    const operation = window.remember
      .listAgentTrace()
      .then((events) => {
        if (!traceActiveRef.current) return
        setTrace(events)
        setTraceError(false)
      })
      .catch(() => {
        if (traceActiveRef.current) setTraceError(true)
      })
      .finally(() => {
        if (traceLoadRef.current === operation) traceLoadRef.current = null
      })
    traceLoadRef.current = operation
    return operation
  }, [])

  useEffect(() => {
    let active = true
    void window.remember
      .getCliSetupStatus()
      .then((nextStatus) => {
        if (active) setStatus(nextStatus)
      })
      .catch(() => {
        if (active) setStatusError(true)
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    traceActiveRef.current = true
    void loadTrace()
    const interval = window.setInterval(() => void loadTrace(), 2_000)
    return () => {
      traceActiveRef.current = false
      window.clearInterval(interval)
    }
  }, [loadTrace])

  const retryStatus = async () => {
    setStatusError(false)
    setStatus(null)
    try {
      setStatus(await window.remember.getCliSetupStatus())
    } catch {
      setStatusError(true)
    }
  }

  const retryTrace = async () => {
    setTraceError(false)
    setTrace(null)
    await traceLoadRef.current
    await loadTrace()
  }

  const install = async () => {
    setInstalling(true)
    setStatusError(false)
    try {
      setStatus(await window.remember.installCliAccess())
    } catch {
      setStatusError(true)
    } finally {
      setInstalling(false)
    }
  }
  const selectedTrace = trace?.find((event) => event.id === selectedTraceId) ?? null
  const selectedDay = selectedTrace?.dayId ? (local.days.find((day) => day.id === selectedTrace.dayId) ?? null) : null
  const selectedRun = selectedDay && selectedDay.refresh.run?.id === selectedTrace?.id ? selectedDay.refresh.run : null
  const visibleTrace = trace?.slice(0, visibleTraceCount) ?? []
  const remainingTraceCount = Math.max((trace?.length ?? 0) - visibleTraceCount, 0)
  const nextTraceLoadCount = Math.min(AGENT_TRACE_PAGE_SIZE, remainingTraceCount)

  return (
    <Container className="flex grow flex-col gap-6 py-8 md:py-12">
      <DashboardContentHeader title={t('Agent')} />

      <section aria-label={t('Agent')} className="overflow-hidden rounded-xl bg-white shadow-raised">
        <ul className="divide-y divide-slate-100">
          <AnalysisAgentSettings />
          <AgentLearningSettings />
          <AgentUsageSection />
        </ul>
      </section>

      {statusError ? (
        <div className="flex min-h-12 items-center justify-between gap-4 rounded-xl bg-danger-100 px-3 py-2.5 shadow-raised">
          <p className="text-danger-700 text-sm" role="alert">
            {t('De agenttoegang kon niet worden gecontroleerd.')}
          </p>
          <Button size="small" variant="outline" color="danger" radius="small" onClick={() => void retryStatus()}>
            {t('Probeer opnieuw')}
          </Button>
        </div>
      ) : status && !status.installed ? (
        <div className="flex min-h-12 items-center justify-between gap-4 rounded-xl bg-danger-100 px-3 py-2.5 shadow-raised">
          <p className="text-danger-700 text-sm" role="alert">
            {t('Remember-toegang voor agents kon niet worden ingesteld.')}
          </p>
          <Button
            size="small"
            variant="outline"
            color="danger"
            radius="small"
            disabled={installing}
            onClick={() => void install()}
          >
            {installing ? t('Herstellen…') : t('Probeer opnieuw')}
          </Button>
        </div>
      ) : null}

      <section aria-labelledby="agent-trace-title" className="overflow-hidden rounded-xl bg-white shadow-raised">
        <div className="flex min-h-12 items-center border-slate-100 border-b px-4">
          <h2 id="agent-trace-title" className="font-semibold text-slate-900 text-md">
            {t('Activiteit')}
          </h2>
        </div>
        {traceError ? (
          <div className="flex min-h-56 flex-col items-center justify-center px-6 text-center">
            <p className="max-w-sm text-pretty text-slate-600 text-sm" role="alert">
              {t('Agentactiviteit kon niet worden geladen.')}
            </p>
            <Button size="small" variant="outline" color="secondary" className="mt-3" onClick={() => void retryTrace()}>
              {t('Probeer opnieuw')}
            </Button>
          </div>
        ) : trace?.length ? (
          <>
            <ol id="agent-trace-events" className="divide-y divide-slate-100">
              {visibleTrace.map((event) => (
                <AgentTraceRow
                  key={event.id}
                  event={event}
                  days={local.days}
                  onInspect={() => setSelectedTraceId(event.id)}
                />
              ))}
            </ol>
            {remainingTraceCount > 0 ? (
              <footer className="border-slate-100 border-t">
                <button
                  type="button"
                  aria-controls="agent-trace-events"
                  onClick={() => setVisibleTraceCount((current) => current + AGENT_TRACE_PAGE_SIZE)}
                  className="flex h-10 w-full items-center justify-center font-medium text-slate-500 text-sm outline-none transition-[background-color,color] duration-150 ease-out hover:bg-slate-50 hover:text-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-slate-400 motion-reduce:transition-none"
                >
                  {t('{count} meer laden', { count: nextTraceLoadCount })}
                </button>
              </footer>
            ) : null}
          </>
        ) : trace === null ? (
          <div className="px-4 py-4">
            <PendingIndicator label={t('Trace laden')} />
          </div>
        ) : (
          <div className="flex min-h-56 flex-col items-center justify-center px-6 text-center">
            <p className="font-medium text-slate-800 text-md">{t('Nog geen activiteit')}</p>
            <p className="mt-1 max-w-sm text-pretty text-slate-500 text-sm">{t('Agentactiviteit verschijnt hier.')}</p>
          </div>
        )}
      </section>
      <AgentTraceModal
        key={selectedTrace?.id ?? 'closed'}
        event={selectedTrace}
        run={selectedRun}
        days={local.days}
        onClose={() => setSelectedTraceId(null)}
      />
    </Container>
  )
}
