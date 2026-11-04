'use client'

import { Button } from '@internal/ui/Button'
import { Spinner } from '@internal/ui/Spinner'
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react'
import { applyAction, canOffer, draftFor, offerTitle, type Phase, type Scenario } from './simulation'

type Context = {
  scenario: Scenario
  tasks: Scenario['expected']['tasks_created']
  phase: Phase
  eligible: boolean
  long: boolean
  state: string
  note: string
  events: string[]
  start: (note?: string) => void
  dismiss: () => void
  stop: () => void
  source: () => void
  result: () => void
  recover: () => void
}

const ScenarioContext = createContext<Context | null>(null)

export function useScenario() {
  const context = useContext(ScenarioContext)
  if (!context) throw new Error('Prototype scenario is missing')
  return context
}

export function ScenarioProvider({
  scenario,
  long,
  state,
  readError,
  onRecover,
  children,
}: {
  scenario: Scenario
  long: boolean
  state: string
  readError: boolean
  onRecover: () => void
  children: ReactNode
}) {
  const tasks = state === 'empty' ? [] : scenario.expected.tasks_created
  const eligible = state === 'ready' && canOffer(scenario)
  const [phase, setPhase] = useState<Phase>(eligible ? 'offered' : 'idle')
  const [note, setNote] = useState('')
  const [dialog, setDialog] = useState<'source' | 'result' | null>(null)
  const [retried, setRetried] = useState(false)
  const [events, setEvents] = useState([
    `${scenario.id}: ${tasks.length} brongekoppelde taken; ${eligible ? 'één aanleiding' : 'geen proactief aanbod'}.`,
  ])
  const append = (text: string) => setEvents((current) => [...current, text])

  useEffect(() => {
    if (phase !== 'running') return
    const timer = setTimeout(() => {
      setPhase((current) => applyAction(current, 'finish', eligible))
      setEvents((current) => [...current, 'Lokaal voorbeeldconcept gemaakt. Geen mail verstuurd; taken blijven open.'])
    }, 1500)
    return () => clearTimeout(timer)
  }, [phase, eligible])

  const start = (instruction = '') => {
    if (!eligible || !['offered', 'dismissed', 'stopped'].includes(phase)) return
    setNote(instruction)
    setPhase((current) => applyAction(current, 'start', eligible))
    append(`Expliciete opdracht: concept voorbereiden.${instruction ? ` Instructie: ${instruction}` : ''}`)
  }
  const dismiss = () => {
    if (phase !== 'offered') return
    setPhase((current) => applyAction(current, 'dismiss', eligible))
    append('Nu even niet: aanleiding gedempt, alle afspraken behouden. Geen uitvoering.')
  }
  const stop = () => {
    if (phase !== 'running') return
    setPhase((current) => applyAction(current, 'stop', eligible))
    append('Lokale simulatietimer gestopt; geen resultaat gemaakt.')
  }
  const source = () => {
    setDialog('source')
    append('Oorspronkelijke bron geopend.')
  }
  const result = () => {
    setDialog('result')
    append('Bestaand concept geopend; geen nieuwe uitvoering.')
  }

  return (
    <ScenarioContext.Provider
      value={{
        scenario,
        tasks,
        phase,
        eligible,
        long,
        state,
        note,
        events,
        start,
        dismiss,
        stop,
        source,
        result,
        recover: onRecover,
      }}
    >
      <div className="flex h-full min-h-0 flex-col">{children}</div>
      <InspectionDialog
        title={dialog === 'source' ? 'Bron van de afspraak' : 'Concept voor Noor'}
        open={Boolean(dialog)}
        onClose={() => setDialog(null)}
      >
        {dialog === 'source' ? (
          <div className="space-y-5">
            <p className="text-slate-500 text-sm">
              Gesprek ·{' '}
              {scenario.id === 'AO-010' ? 'drie uur geleden · actuele relevantie onbevestigd' : 'vandaag, 09:00'} ·
              synthetische bron
            </p>
            {scenario.events
              .filter((event) => event.text)
              .map((event) => (
                <div key={event.id}>
                  <p className="text-slate-500 text-xs">{event.id}</p>
                  <blockquote className="mt-1 border-slate-200 border-l-2 pl-3 text-ui leading-6">
                    {event.text}
                  </blockquote>
                </div>
              ))}
            <p className="text-slate-600 text-sm">{scenario.expected.attention.reason}</p>
          </div>
        ) : readError && !retried ? (
          <div role="alert" className="space-y-4">
            <p className="font-medium text-danger-700">Het concept kon niet worden geopend.</p>
            <p className="text-slate-600 text-sm">
              Het resultaat bestaat al. Opnieuw ophalen start de opdracht niet opnieuw.
            </p>
            <Button
              size="small"
              variant="outline"
              onClick={() => {
                setRetried(true)
                append('Hetzelfde resultaat opnieuw opgehaald. Geen nieuwe uitvoering.')
              }}
            >
              Opnieuw ophalen
            </Button>
          </div>
        ) : (
          <div className="space-y-5">
            <p className="text-slate-500 text-sm">Concept · niet verstuurd · taak blijft open</p>
            {scenario.id === 'AO-020' ? (
              <p className="text-slate-700 text-sm">
                Het overzicht ontbreekt nog. Voeg het toe voordat je dit bericht gebruikt.
              </p>
            ) : null}
            <p className="whitespace-pre-wrap text-ui leading-6">{draftFor(scenario)}</p>
            {note ? (
              <div className="border-slate-200 border-t pt-4">
                <p className="font-medium text-sm">Instructie bij de opdracht</p>
                <p className="mt-1 whitespace-pre-wrap text-slate-600 text-sm">{note}</p>
                <p className="mt-2 text-slate-500 text-xs">
                  De simulatie bewaart deze instructie; er interpreteert geen model de tekst.
                </p>
              </div>
            ) : null}
            <Button size="small" variant="text" color="secondary" onClick={source}>
              Bekijk de bron
            </Button>
          </div>
        )}
      </InspectionDialog>
    </ScenarioContext.Provider>
  )
}

export function FrameHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-2 border-slate-200 border-b px-5 py-2">
      <h2 className="font-semibold text-ui">{title}</h2>
      {children}
    </header>
  )
}

export function LoadState({ children }: { children: ReactNode }) {
  const { state, recover } = useScenario()
  if (state === 'loading')
    return (
      <div role="status" aria-live="polite" className="flex min-h-48 items-center gap-2 text-slate-500 text-sm">
        <Spinner size="xs" />
        Afspraak laden
      </div>
    )
  if (state === 'error')
    return (
      <div role="alert" className="min-h-48 space-y-3 py-8">
        <h3 className="font-medium text-danger-700">De afspraak kon niet worden geladen.</h3>
        <p className="text-slate-600 text-sm">Er is nog geen opdracht gestart.</p>
        <Button size="small" variant="outline" onClick={recover}>
          Opnieuw laden
        </Button>
      </div>
    )
  return children
}

export function OfferDetail({
  allowDismiss = true,
  showStart = true,
}: {
  allowDismiss?: boolean
  showStart?: boolean
}) {
  const { scenario, phase, eligible, long, start, dismiss, stop, source, result } = useScenario()
  if (!eligible)
    return (
      <p className="text-slate-500 text-sm">
        {scenario.id === 'AO-010'
          ? 'Deze afspraak is oud. Controleer eerst of hij nog relevant is.'
          : 'Er staat geen aanbod klaar.'}
      </p>
    )
  return (
    <section aria-label="Voorstel bij de afspraak" className="space-y-3">
      <h3 className="text-balance font-medium text-ui">
        {phase === 'done'
          ? 'Concept klaar'
          : phase === 'running'
            ? 'Concept voorbereiden'
            : phase === 'stopped'
              ? 'Voorbereiding gestopt'
              : offerTitle(scenario)}
      </h3>
      {long ? (
        <p className="max-w-[65ch] text-slate-600 text-sm leading-6">
          Het gaat om de afspraak “{scenario.expected.tasks_created[0].result}”. Het concept gebruikt alleen wat in het
          gesprek is genoemd. Ontbrekende informatie blijft zichtbaar als open punt, zodat je die kunt controleren
          voordat je het bericht zelf verstuurt.
        </p>
      ) : (
        <p className="text-slate-600 text-sm leading-6">
          {scenario.id === 'AO-020'
            ? 'Noor wacht op het overzicht. De andere twee afspraken blijven in Taken.'
            : 'Je hebt de bevestiging voor elf uur toegezegd. Ik kan de eerste tekst klaarzetten.'}
        </p>
      )}
      <Button size="small" variant="text" color="secondary" onClick={source}>
        Gesprek · 09:00
      </Button>
      {phase === 'running' ? (
        <div className="flex min-h-10 items-center gap-4">
          <p role="status" className="flex items-center gap-2 text-slate-600 text-sm">
            <Spinner size="xs" />
            Concept wordt gemaakt
          </p>
          <Button size="small" variant="text" color="secondary" onClick={stop}>
            Stop
          </Button>
        </div>
      ) : phase === 'done' ? (
        <div className="space-y-3">
          <p role="status" className="text-slate-600 text-sm">
            {scenario.id === 'AO-020'
              ? 'Concept met open punt. Het overzicht moet nog worden toegevoegd.'
              : 'De tekst is klaar om te bekijken.'}{' '}
            Er is niets verstuurd.
          </p>
          <Button size="small" variant="outline" onClick={result}>
            Open concept
          </Button>
        </div>
      ) : (
        <div className="flex min-h-10 flex-wrap items-center gap-3">
          {showStart ? (
            <Button size="small" onClick={() => start()}>
              {phase === 'stopped' ? 'Opnieuw voorbereiden' : 'Concept maken'}
            </Button>
          ) : null}
          {phase === 'offered' && allowDismiss ? (
            <Button size="small" variant="text" color="secondary" onClick={dismiss}>
              Nu even niet
            </Button>
          ) : null}
        </div>
      )}
    </section>
  )
}

export function TaskList({ onSelect }: { onSelect: (index: number) => void }) {
  const { tasks, long } = useScenario()
  if (!tasks.length)
    return (
      <div className="min-h-40 py-8">
        <h3 className="font-medium text-ui">Geen nieuwe taken</h3>
        <p className="mt-2 max-w-[60ch] text-slate-500 text-sm">Je hoeft nu niets op te pakken.</p>
      </div>
    )
  return (
    <ul className="divide-y divide-slate-100">
      {tasks.map((task, index) => (
        <li key={task.key}>
          <button
            type="button"
            onClick={() => onSelect(index)}
            className="flex min-h-14 w-full items-start gap-3 rounded-md px-2 py-4 text-left outline-slate-500 hover:bg-slate-50 focus-visible:outline-2"
          >
            <span aria-hidden="true" className="mt-1 size-3.5 shrink-0 rounded-full border border-slate-300" />
            <span className="min-w-0">
              <span className="block break-words text-ui">
                {task.result}
                {long ? ' — de afgesproken inhoud controleren en het juiste bericht voor deze afspraak gebruiken' : ''}
              </span>
              <span className="mt-1 block text-slate-500 text-xs">
                {task.requires_current_relevance_check
                  ? 'Drie uur geleden · relevantie onbevestigd'
                  : index === 0
                    ? 'Eerstvolgende afspraak'
                    : 'Afspraak bewaard'}{' '}
                · Open
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

export function InspectionDialog({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (open && !ref.current?.open) ref.current?.showModal()
    if (!open && ref.current?.open) ref.current.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      onCancel={onClose}
      onClose={onClose}
      aria-label={title}
      className="m-auto max-h-[85dvh] w-[min(92vw,600px)] overflow-auto rounded-xl border border-slate-200 bg-white p-0 text-slate-900 shadow-lg backdrop:bg-slate-900/30"
    >
      <div className="flex items-center justify-between gap-4 border-slate-200 border-b px-5 py-3">
        <h2 className="font-medium text-ui">{title}</h2>
        <Button size="small" variant="text" color="secondary" onClick={onClose}>
          Sluiten
        </Button>
      </div>
      <div className="break-words p-5">{children}</div>
    </dialog>
  )
}
