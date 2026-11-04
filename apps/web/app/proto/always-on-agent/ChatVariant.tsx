'use client'

import { Button } from '@internal/ui/Button'
import { useState } from 'react'
import { FrameHeader, InspectionDialog, LoadState, OfferDetail, TaskList, useScenario } from './shared'

export function ChatVariant() {
  const { phase, tasks, eligible, start, source } = useScenario()
  const [draft, setDraft] = useState('')
  const [showTasks, setShowTasks] = useState(false)
  const [selected, setSelected] = useState<number | null>(null)
  const canStart = eligible && ['offered', 'dismissed', 'stopped'].includes(phase)
  return (
    <>
      <FrameHeader title="Agent">
        <Button
          size="small"
          variant="text"
          color="secondary"
          onClick={() => {
            setSelected(null)
            setShowTasks(true)
          }}
        >
          Taken ({tasks.length})
        </Button>
      </FrameHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-5 py-8 sm:px-8">
          <LoadState>
            <div className="space-y-8">
              {eligible && phase !== 'dismissed' ? (
                <div>
                  <p className="mb-3 text-slate-500 text-xs">Agent · voorstel</p>
                  <OfferDetail showStart={false} />
                </div>
              ) : phase === 'dismissed' ? (
                <div>
                  <p className="mb-2 text-slate-500 text-xs">Jij</p>
                  <p className="text-ui">Nu even niet.</p>
                  <p className="mt-5 text-slate-600 text-sm">Je afspraken blijven in Taken staan.</p>
                </div>
              ) : (
                <div className="min-h-40 py-6">
                  <h3 className="font-medium text-lg">Wat kan ik voor je doen?</h3>
                  <p className="mt-2 text-slate-500 text-sm">
                    Er is nu geen nieuw aanbod. Je bestaande werk blijft bereikbaar.
                  </p>
                </div>
              )}
            </div>
          </LoadState>
        </div>
      </div>
      <form
        aria-label="Opdracht voor het voorbeeldconcept"
        className="mx-auto w-full max-w-3xl shrink-0 px-5 pb-5 sm:px-8"
        onSubmit={(event) => {
          event.preventDefault()
          if (canStart) {
            start(draft)
            setDraft('')
          }
        }}
      >
        <label htmlFor="proto-chat-message" className="sr-only">
          Instructie voor het concept
        </label>
        <div className="rounded-xl border border-slate-300 bg-white p-3">
          <textarea
            id="proto-chat-message"
            value={draft}
            disabled={!canStart}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault()
                event.currentTarget.form?.requestSubmit()
              }
            }}
            placeholder={
              canStart ? 'Voeg een instructie toe voor het concept…' : 'Er staat geen nieuwe conceptopdracht klaar'
            }
            rows={2}
            className="w-full resize-none bg-transparent text-base leading-6 outline-none focus-visible:rounded focus-visible:outline-2 focus-visible:outline-slate-400 disabled:text-slate-500"
          />
          <div className="flex justify-end">
            <Button type="submit" size="small" disabled={!canStart}>
              Concept maken
            </Button>
          </div>
        </div>
        <p className="mt-2 text-slate-500 text-xs">Een concept voorbereiden verstuurt geen bericht.</p>
      </form>
      <InspectionDialog open={showTasks} title="Taken" onClose={() => setShowTasks(false)}>
        {selected === null ? (
          <TaskList onSelect={setSelected} />
        ) : (
          <div className="space-y-4">
            <Button size="small" variant="text" color="secondary" onClick={() => setSelected(null)}>
              Alle taken
            </Button>
            <h3 className="font-medium text-ui">{tasks[selected]?.result}</h3>
            {selected === 0 ? (
              <OfferDetail allowDismiss={phase !== 'dismissed'} />
            ) : (
              <>
                <p className="text-slate-500 text-sm">Afspraak bewaard. Er is geen extra aanbod.</p>
                <Button size="small" variant="text" color="secondary" onClick={source}>
                  Bekijk bron
                </Button>
              </>
            )}
          </div>
        )}
      </InspectionDialog>
    </>
  )
}
