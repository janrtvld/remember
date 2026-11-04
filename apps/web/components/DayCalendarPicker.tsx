'use client'

import { Popover, PopoverButton, PopoverPanel } from '@headlessui/react'
import { useI18n } from '@internal/locales'
import { IconButton } from '@internal/ui/IconButton'
import { Title } from '@internal/ui/Title'
import type { Day } from '@remember/shared'
import { ChevronLeft as IconChevronLeft, ChevronRight as IconChevronRight } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import {
  calendarMonthDays,
  calendarWeekdayLabels,
  isSameCalendarMonth,
  shiftCalendarMonth,
  startOfCalendarMonth,
} from './dayCalendar'
import { dayHref, daysForDaySwitcher, isLocalToday, localDateKey } from './dayNavigation'

function capitalized(value: string, locale: 'en-US' | 'nl-NL') {
  return value.charAt(0).toLocaleUpperCase(locale) + value.slice(1)
}

function fullDateLabel(timestamp: number, locale: 'en-US' | 'nl-NL') {
  return capitalized(
    new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(
      timestamp
    ),
    locale
  )
}

export function DayCalendarPicker({ day, days, label }: { day: Day; days: Day[]; label: string }) {
  const { dateLocale, t } = useI18n()
  const availableDays = useMemo(() => daysForDaySwitcher(days, day), [day, days])
  const selectedMonth = startOfCalendarMonth(day.startedAt)
  const [visibleMonth, setVisibleMonth] = useState(selectedMonth)
  const availableDaysByDate = useMemo(
    () => new Map(availableDays.map((candidate) => [localDateKey(candidate.startedAt), candidate])),
    [availableDays]
  )
  const monthBounds = useMemo(() => {
    const months = availableDays.map((candidate) => startOfCalendarMonth(candidate.startedAt))
    return { first: Math.min(...months), last: Math.max(...months) }
  }, [availableDays])
  const calendarDays = calendarMonthDays(visibleMonth, dateLocale)
  const weekdayLabels = calendarWeekdayLabels(dateLocale)
  const previousMonth = shiftCalendarMonth(visibleMonth, -1)
  const nextMonth = shiftCalendarMonth(visibleMonth, 1)
  const monthLabel = capitalized(
    new Intl.DateTimeFormat(dateLocale, { month: 'long', year: 'numeric' }).format(visibleMonth),
    dateLocale
  )
  const selectedDateKey = localDateKey(day.startedAt)

  useEffect(() => {
    setVisibleMonth(selectedMonth)
  }, [selectedMonth])

  return (
    <Popover className="relative w-fit max-w-full">
      {({ close }) => (
        <>
          <Title className="max-w-[34ch] text-balance leading-[1.15] tracking-[-0.015em]">
            <PopoverButton
              title={t('Kies een werkdag')}
              onClick={() => setVisibleMonth(selectedMonth)}
              className="-m-1.5 rounded-lg p-1.5 text-left outline-none transition-colors duration-150 hover:bg-slate-100 data-open:bg-slate-100 focus-visible:bg-slate-100 focus-visible:ring-2 focus-visible:ring-slate-400 motion-reduce:transition-none"
            >
              {label}
            </PopoverButton>
          </Title>
          <PopoverPanel
            anchor="bottom start"
            transition
            className="z-50 mt-1 w-64 origin-top-left rounded-xl bg-white p-2.5 shadow-raised outline-none transition-[opacity,transform] duration-100 ease-out data-closed:scale-[0.98] data-closed:opacity-0 motion-reduce:transition-none"
          >
            <div className="flex h-8 items-center justify-between px-1">
              <p className="font-semibold text-slate-900 text-sm">{monthLabel}</p>
              <div className="flex items-center gap-0.5">
                <IconButton
                  aria-label={t('Vorige maand')}
                  disabled={previousMonth < monthBounds.first}
                  onClick={() => setVisibleMonth(previousMonth)}
                  className="before:-inset-1.5 disabled:text-slate-300"
                >
                  <IconChevronLeft className="size-4" aria-hidden="true" />
                </IconButton>
                <IconButton
                  aria-label={t('Volgende maand')}
                  disabled={nextMonth > monthBounds.last}
                  onClick={() => setVisibleMonth(nextMonth)}
                  className="before:-inset-1.5 disabled:text-slate-300"
                >
                  <IconChevronRight className="size-4" aria-hidden="true" />
                </IconButton>
              </div>
            </div>
            <div className="mt-1.5 grid grid-cols-7 gap-0.5" aria-hidden="true">
              {weekdayLabels.map((label) => (
                <span key={label} className="flex h-5 items-center justify-center text-slate-400 text-xs">
                  {label}
                </span>
              ))}
            </div>
            <div className="mt-0.5 grid grid-cols-7 gap-0.5" role="group" aria-label={monthLabel}>
              {calendarDays.map((timestamp) => {
                const dateKey = localDateKey(timestamp)
                const candidate = availableDaysByDate.get(dateKey)
                const inVisibleMonth = isSameCalendarMonth(timestamp, visibleMonth)
                const selected = dateKey === selectedDateKey
                const today = isLocalToday(timestamp)

                if (!candidate || !inVisibleMonth) {
                  return (
                    <span
                      key={dateKey}
                      aria-hidden="true"
                      className={`flex size-[30px] items-center justify-center justify-self-center text-xs tabular-nums ${
                        inVisibleMonth ? 'text-slate-300' : 'text-slate-200'
                      }`}
                    >
                      {new Date(timestamp).getDate()}
                    </span>
                  )
                }

                return (
                  <Link
                    key={candidate.id}
                    href={dayHref(candidate)}
                    aria-current={selected ? 'date' : undefined}
                    aria-label={fullDateLabel(timestamp, dateLocale)}
                    onClick={() => close()}
                    className={`relative flex size-[30px] items-center justify-center justify-self-center rounded-full font-medium text-xs tabular-nums outline-none before:absolute before:-inset-2 focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-1 active:scale-[0.96] motion-reduce:transition-none ${
                      selected
                        ? 'bg-slate-900 text-white'
                        : today
                          ? 'text-slate-900 ring-1 ring-inset ring-slate-300 hover:bg-slate-100'
                          : 'text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    {new Date(timestamp).getDate()}
                  </Link>
                )
              })}
            </div>
          </PopoverPanel>
        </>
      )}
    </Popover>
  )
}
