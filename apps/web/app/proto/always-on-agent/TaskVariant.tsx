'use client'

import { Button } from '@internal/ui/Button'
import { useState } from 'react'
import { FrameHeader, LoadState, OfferDetail, TaskList, useScenario } from './shared'

export function TaskVariant() {
  const { tasks, phase, source } = useScenario()
  const [selected, setSelected] = useState<number | null>(null)
  const task = selected === null ? null : tasks[selected]
  return (
    <>
      <FrameHeader title="Taken">
        {task ? (
          <Button size="small" variant="text" color="secondary" onClick={() => setSelected(null)}>
            Alle taken
          </Button>
        ) : (
          <span className="text-slate-500 text-sm tabular-nums">{tasks.length} open</span>
        )}
      </FrameHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-5 py-8 sm:px-8">
          <LoadState>
            {task ? (
              <div className="space-y-7">
                <div>
                  <p className="mb-2 text-slate-500 text-xs">Open afspraak</p>
                  <h3 className="text-balance font-medium text-lg">{task.result}</h3>
                  <Button size="small" variant="text" color="secondary" className="mt-3" onClick={source}>
                    Bekijk bron
                  </Button>
                </div>
                <div className="border-slate-200 border-t pt-6">
                  {selected === 0 ? (
                    <OfferDetail allowDismiss={phase !== 'dismissed'} />
                  ) : (
                    <p className="text-slate-500 text-sm">Afspraak bewaard. Er is geen extra aanbod nodig.</p>
                  )}
                </div>
              </div>
            ) : (
              <>
                <h3 className="mb-3 font-medium text-sm">Voor jou</h3>
                <TaskList onSelect={setSelected} />
                <PriorityHint onOpen={() => setSelected(0)} />
              </>
            )}
          </LoadState>
        </div>
      </div>
    </>
  )
}

function PriorityHint({ onOpen }: { onOpen: () => void }) {
  const { eligible, phase, dismiss } = useScenario()
  if (!eligible || phase === 'dismissed') return null
  return (
    <section aria-label="Volgende stap" className="mt-6 border-slate-200 border-t pt-5">
      <p className="text-slate-600 text-sm">
        {phase === 'done'
          ? 'Het concept staat bij de afspraak voor Noor.'
          : phase === 'running'
            ? 'De voorbereiding voor Noor loopt.'
            : 'Een eerste tekst voor Noor kan deze afspraak vooruithelpen.'}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button size="small" variant="outline" onClick={onOpen}>
          {phase === 'done' ? 'Bekijk concept' : 'Bekijk voorstel'}
        </Button>
        {phase === 'offered' ? (
          <Button size="small" variant="text" color="secondary" onClick={dismiss}>
            Nu even niet
          </Button>
        ) : null}
      </div>
    </section>
  )
}
