'use client'

import { Button } from '@internal/ui/Button'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChatVariant } from './ChatVariant'
import { QuietVariant } from './QuietVariant'
import { ScenarioProvider, useScenario } from './shared'
import type { Scenario } from './simulation'
import { TaskVariant } from './TaskVariant'
import './picker.css'

const names = ['Chat', 'Collega', 'Taken']
const descriptions = [
  'Huidige chatvorm · lokale compositie, gesimuleerd gedrag. Het echte AssistantView blijft ongewijzigd.',
  'Stille collega · je werk blijft centraal; één aanbod opent ernaast.',
  'Taakbewaker · het aanbod staat bij de afspraak die het vooruithelpt.',
]

export function Prototype({ scenarios, initialVariant }: { scenarios: Scenario[]; initialVariant: number }) {
  const [variant, setVariant] = useState(initialVariant)
  const [scenarioId, setScenarioId] = useState('AO-001')
  const [reset, setReset] = useState(0)
  const [narrow, setNarrow] = useState(false)
  const [long, setLong] = useState(false)
  const [state, setState] = useState('ready')
  const [readError, setReadError] = useState(false)
  const picker = useRef<HTMLElement>(null)
  const highlight = useRef<HTMLSpanElement>(null)
  const scenario = scenarios.find((entry) => entry.id === scenarioId) ?? scenarios[0]
  const select = useCallback((index: number) => {
    setVariant(index)
    setReset((value) => value + 1)
    const url = new URL(location.href)
    url.searchParams.set('v', String(index + 1))
    history.replaceState(null, '', url)
  }, [])

  useLayoutEffect(() => {
    const move = () => {
      const item = picker.current?.querySelectorAll<HTMLElement>('.proto-picker-item')[variant]
      if (!item || !highlight.current) return
      highlight.current.style.width = `${item.offsetWidth}px`
      highlight.current.style.transform = `translateX(${item.offsetLeft}px)`
    }
    move()
    window.addEventListener('resize', move)
    return () => window.removeEventListener('resize', move)
  }, [variant])

  useEffect(() => {
    let secondFrame = 0
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => picker.current?.setAttribute('data-ready', ''))
    })
    return () => {
      cancelAnimationFrame(firstFrame)
      cancelAnimationFrame(secondFrame)
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (
        /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) ||
        target.isContentEditable ||
        target.closest('dialog[open]')
      )
        return
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      const number = Number(event.key)
      if (number >= 1 && number <= names.length) {
        event.preventDefault()
        select(number - 1)
      } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault()
        select((variant + (event.key === 'ArrowRight' ? 1 : names.length - 1)) % names.length)
      } else if (event.key.toLowerCase() === 'r') setReset((value) => value + 1)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [select, variant])

  if (process.env.NODE_ENV !== 'development') return null

  return (
    <main className="min-h-dvh bg-slate-50 px-3 pt-5 pb-28 text-slate-900 antialiased sm:px-6" lang="nl">
      <div className="mx-auto max-w-6xl">
        <h1 className="font-semibold text-ui">Eén bruikbaar aanbod</h1>
        <p className="mt-1 max-w-[75ch] text-slate-600 text-sm">
          Simulatie · alleen lokale voorbeelddata. Geen model, opname, systeemmelding, netwerkactie of echte uitvoering.
        </p>
        <form className="mt-4 flex flex-wrap items-end gap-4" onSubmit={(event) => event.preventDefault()}>
          <label className="flex w-full min-w-0 flex-col gap-1 text-slate-600 text-sm sm:w-auto">
            Situatie
            <select
              value={scenarioId}
              onChange={(event) => {
                setScenarioId(event.target.value)
                setState('ready')
              }}
              className="h-10 max-w-full rounded-md border border-slate-300 bg-white px-2 text-base text-slate-900 outline-slate-500"
            >
              {scenarios.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.id} · {entry.title}
                </option>
              ))}
            </select>
          </label>
          <Button size="small" variant="outline" onClick={() => setReset((value) => value + 1)}>
            Opnieuw beginnen
          </Button>
        </form>
        <details className="mt-3 text-sm">
          <summary className="w-fit cursor-pointer rounded py-2 text-slate-600 focus-visible:outline-2 focus-visible:outline-slate-500">
            Testcondities
          </summary>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 py-2">
            <label className="flex min-h-11 cursor-pointer items-center gap-2">
              <input type="checkbox" checked={long} onChange={(event) => setLong(event.target.checked)} /> Lange inhoud
            </label>
            <label className="flex min-h-11 cursor-pointer items-center gap-2">
              <input type="checkbox" checked={narrow} onChange={(event) => setNarrow(event.target.checked)} /> Smal
              werkvlak (390 px)
            </label>
            <label className="flex min-h-11 cursor-pointer items-center gap-2">
              <input type="checkbox" checked={readError} onChange={(event) => setReadError(event.target.checked)} />{' '}
              Eerste resultaatopvraag mislukt
            </label>
            <label className="flex items-center gap-2">
              Toestand
              <select
                value={state}
                onChange={(event) => setState(event.target.value)}
                className="h-10 rounded-md border border-slate-300 bg-white px-2 text-base"
              >
                <option value="ready">Normaal</option>
                <option value="loading">Laden</option>
                <option value="empty">Leeg</option>
                <option value="error">Laadfout</option>
              </select>
            </label>
            {state === 'loading' ? (
              <Button size="small" variant="outline" onClick={() => setState('ready')}>
                Laden afronden
              </Button>
            ) : null}
          </div>
        </details>
        <details className="mt-2 text-sm">
          <summary className="w-fit cursor-pointer rounded py-2 text-slate-600 focus-visible:outline-2 focus-visible:outline-slate-500">
            Scenario en verwachte uitkomst
          </summary>
          <div className="max-w-[75ch] space-y-3 py-2 text-slate-600">
            {scenario.events
              .filter((event) => event.text)
              .map((event) => (
                <blockquote key={event.id} className="border-slate-200 border-l-2 pl-3">
                  {event.text}
                </blockquote>
              ))}
            <p>
              {scenario.expected.attention.reason} {scenario.expected.tasks_created.length} verwachte taken; dit is
              vooraf gekozen simulatie-inhoud.
            </p>
          </div>
        </details>
        <p className="mt-3 min-h-10 max-w-[75ch] text-slate-500 text-sm">{descriptions[variant]}</p>
        <section
          aria-label={`${names[variant]} prototype`}
          className={`mx-auto mt-2 h-[680px] max-h-[900px] min-h-[520px] overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm ${narrow ? 'max-w-[390px]' : 'w-full'}`}
        >
          <ScenarioProvider
            key={`${variant}-${scenarioId}-${reset}-${state}-${readError}`}
            scenario={scenario}
            long={long}
            state={state}
            readError={readError}
            onRecover={() => setState('ready')}
          >
            {variant === 0 ? <ChatVariant /> : variant === 1 ? <QuietVariant /> : <TaskVariant />}
            <SimulationRecord />
          </ScenarioProvider>
        </section>
        <p className="mt-3 text-slate-500 text-xs">
          1–3 of pijltjes: wisselen · R: opnieuw. Elke variant start met dezelfde uitkomst uit het corpus. Dit is geen
          benchmarkscore.
        </p>
      </div>
      <nav ref={picker} className="proto-picker" aria-label="Prototype variants">
        <span ref={highlight} className="proto-picker-highlight" aria-hidden="true" />
        {names.map((name, index) => (
          <button
            key={name}
            type="button"
            className="proto-picker-item"
            data-active={index === variant ? '' : undefined}
            aria-current={index === variant ? 'true' : undefined}
            onClick={() => select(index)}
          >
            {name}
          </button>
        ))}
      </nav>
    </main>
  )
}

function SimulationRecord() {
  const { phase, tasks, events } = useScenario()
  return (
    <details className="shrink-0 border-slate-200 border-t bg-slate-50 px-4 py-2 text-xs">
      <summary className="cursor-pointer text-slate-600">
        Simulatielog · {tasks.length} open taken · {phase}
      </summary>
      <ol className="mt-2 max-h-28 list-inside list-decimal overflow-auto text-slate-600">
        {events.map((event, index) => (
          <li key={`${index}-${event}`}>{event}</li>
        ))}
      </ol>
    </details>
  )
}
