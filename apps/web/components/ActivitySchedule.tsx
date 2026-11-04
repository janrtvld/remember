'use client'

import { Field, Label } from '@headlessui/react'
import { useI18n } from '@internal/locales'
import { Switch } from '@internal/ui/Switch'
import { TimeInput } from '@internal/ui/TimeInput'
import type { CaptureSchedule, CaptureWeekday } from '@remember/shared'
import { useEffect, useState } from 'react'

const weekdays = [
  { value: 1, short: 'Ma', long: 'maandag' },
  { value: 2, short: 'Di', long: 'dinsdag' },
  { value: 3, short: 'Wo', long: 'woensdag' },
  { value: 4, short: 'Do', long: 'donderdag' },
  { value: 5, short: 'Vr', long: 'vrijdag' },
  { value: 6, short: 'Za', long: 'zaterdag' },
  { value: 0, short: 'Zo', long: 'zondag' },
] as const satisfies ReadonlyArray<{ value: CaptureWeekday; short: string; long: string }>

export function ActivitySchedule({
  schedule,
  onChange,
}: {
  schedule: CaptureSchedule
  onChange: (schedule: CaptureSchedule) => Promise<void>
}) {
  const { locale, t } = useI18n()
  const [draft, setDraft] = useState(schedule)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => setDraft(schedule), [schedule])

  const save = async (next: CaptureSchedule) => {
    setDraft(next)
    if (next.enabled && next.startTime === next.endTime) {
      setError(t('Kies verschillende start- en eindtijden. Gelijke tijden nemen niets op.'))
      return
    }
    setIsSaving(true)
    setError(null)
    try {
      await onChange(next)
    } catch {
      setDraft(schedule)
      setError(t('Het schema kon niet worden opgeslagen. Probeer het opnieuw.'))
    } finally {
      setIsSaving(false)
    }
  }

  const toggleWeekday = (weekday: CaptureWeekday) => {
    const nextWeekdays = draft.weekdays.includes(weekday)
      ? draft.weekdays.filter((candidate) => candidate !== weekday)
      : [...draft.weekdays, weekday].sort((first, second) => first - second)
    void save({ ...draft, weekdays: nextWeekdays })
  }

  return (
    <div>
      <Field className="flex min-h-[52px] items-center justify-between gap-3 px-4 py-2.5">
        <div>
          <Label className="cursor-pointer font-medium text-slate-900 text-ui">{t('Opnameschema gebruiken')}</Label>
          <p className="mt-0.5 text-pretty text-slate-500 text-xs">
            {draft.enabled ? t('Alleen binnen de gekozen dagen en tijden.') : t('Remember neemt standaard 24/7 op.')}
          </p>
        </div>
        <Switch
          size="small"
          checked={draft.enabled}
          disabled={isSaving}
          onChange={(enabled) => void save({ ...draft, enabled })}
        />
      </Field>

      {draft.enabled ? (
        <fieldset disabled={isSaving} className="grid gap-4 border-slate-100 border-t px-4 py-4 disabled:opacity-50">
          <legend className="sr-only">{t('Werkdagen en opnametijden')}</legend>
          <div className="grid gap-2">
            <p className="font-medium text-slate-700 text-xs">{t('Dagen')}</p>
            <div className="grid grid-cols-7 gap-1">
              {weekdays.map((weekday) => (
                <label key={weekday.value} className="cursor-pointer">
                  <input
                    type="checkbox"
                    checked={draft.weekdays.includes(weekday.value)}
                    disabled={isSaving}
                    onChange={() => toggleWeekday(weekday.value)}
                    className="peer sr-only"
                  />
                  <span className="flex h-8 select-none items-center justify-center rounded-md border border-slate-200 bg-white font-medium text-slate-500 text-sm outline-none transition-[background-color,border-color,color,transform] duration-150 ease-out peer-checked:border-slate-800 peer-checked:bg-slate-800 peer-checked:text-on-accent peer-focus-visible:ring-2 peer-focus-visible:ring-slate-400 active:scale-[0.96] motion-reduce:transition-none">
                    <span aria-hidden="true">
                      {new Intl.DateTimeFormat(locale, { weekday: 'short' })
                        .format(new Date(2026, 7, 2 + weekday.value))
                        .replace('.', '')}
                    </span>
                    <span className="sr-only">
                      {new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(
                        new Date(2026, 7, 2 + weekday.value)
                      )}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="grid gap-1.5" htmlFor="capture-start-time">
              <span className="font-medium text-slate-700 text-xs">{t('Starttijd')}</span>
              <TimeInput
                id="capture-start-time"
                step="300"
                value={draft.startTime}
                disabled={isSaving}
                onCommit={(value) => void save({ ...draft, startTime: value })}
                className="h-8 w-full min-w-0 rounded-md border border-slate-200 bg-white px-2.5 text-base text-slate-800 tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-slate-400 disabled:cursor-not-allowed"
              />
            </label>
            <label className="grid gap-1.5" htmlFor="capture-end-time">
              <span className="font-medium text-slate-700 text-xs">{t('Eindtijd')}</span>
              <TimeInput
                id="capture-end-time"
                step="300"
                value={draft.endTime}
                disabled={isSaving}
                onCommit={(value) => void save({ ...draft, endTime: value })}
                className="h-8 w-full min-w-0 rounded-md border border-slate-200 bg-white px-2.5 text-base text-slate-800 tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-slate-400 disabled:cursor-not-allowed"
              />
            </label>
          </div>
        </fieldset>
      ) : null}
      {error ? (
        <p role="alert" className="border-slate-100 border-t px-4 py-2.5 text-danger-700 text-xs">
          {error}
        </p>
      ) : null}
    </div>
  )
}
