'use client'

import { Button } from '@internal/ui/Button'
import { useState } from 'react'
import { FrameHeader, InspectionDialog, LoadState, OfferDetail, TaskList, useScenario } from './shared'
import { offerTitle } from './simulation'

export function QuietVariant() {
  const { scenario, tasks, phase, eligible, dismiss, source, long } = useScenario()
  const [panel, setPanel] = useState<'offer' | 'tasks' | null>(null)
  const [selected, setSelected] = useState(0)
  const [workingText, setWorkingText] = useState(
    'De eerste proef was lichtgrijs.\n\nBespreek de tweede kleurvariant met het team. Houd de verpakking eenvoudig en de productnaam goed leesbaar.'
  )
  return (
    <>
      <FrameHeader title="Atlas · Verpakking">
        <Button size="small" variant="text" color="secondary" onClick={() => setPanel('tasks')}>
          Taken ({tasks.length})
        </Button>
      </FrameHeader>
      <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-5 py-10 sm:px-8">
          <h3 className="text-balance font-semibold text-xl">Tweede proef bespreken</h3>
          <p className="mt-2 text-slate-500 text-sm">Werkdocument · lokale voorbeeldtekst</p>
          <label htmlFor="proto-working-document" className="sr-only">
            Werkdocument
          </label>
          <textarea
            id="proto-working-document"
            value={workingText}
            onChange={(event) => setWorkingText(event.target.value)}
            rows={long ? 12 : 8}
            className="mt-7 w-full resize-none rounded-md bg-transparent text-base leading-7 outline-none focus-visible:outline-2 focus-visible:outline-slate-400"
          />
          {long ? (
            <p className="max-w-[65ch] text-slate-600 text-ui leading-7">
              Dit werkdocument blijft zichtbaar terwijl andere afspraken binnenkomen. De extra tekst is alleen een
              lengteproef voor de interface en wordt niet gebruikt als nieuw taakbewijs.
            </p>
          ) : null}
        </div>
        <div className="mt-auto px-5 pb-5 sm:px-8">
          <LoadState>
            {eligible && phase !== 'dismissed' ? (
              <aside
                aria-label="Hulp bij je werk"
                className="ml-auto max-w-sm rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
              >
                <p className="text-balance font-medium text-sm">
                  {phase === 'done'
                    ? 'Je concept voor Noor staat klaar.'
                    : phase === 'running'
                      ? 'Het concept voor Noor wordt voorbereid.'
                      : phase === 'stopped'
                        ? 'De voorbereiding is gestopt.'
                        : offerTitle(scenario)}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <Button
                    size="small"
                    variant="outline"
                    onClick={() => {
                      setSelected(0)
                      setPanel('offer')
                    }}
                  >
                    {phase === 'done' ? 'Bekijk resultaat' : 'Bekijken'}
                  </Button>
                  {phase === 'offered' ? (
                    <Button size="small" variant="text" color="secondary" onClick={dismiss}>
                      Nu even niet
                    </Button>
                  ) : null}
                </div>
              </aside>
            ) : null}
          </LoadState>
        </div>
      </div>
      <InspectionDialog
        open={Boolean(panel)}
        title={panel === 'tasks' ? 'Taken' : 'Hulp bij je afspraak'}
        onClose={() => setPanel(null)}
      >
        {panel === 'tasks' ? (
          <TaskList
            onSelect={(index) => {
              setSelected(index)
              setPanel('offer')
            }}
          />
        ) : selected > 0 ? (
          <div className="space-y-4">
            <h3 className="font-medium text-ui">{tasks[selected]?.result}</h3>
            <p className="text-slate-500 text-sm">Afspraak bewaard. Er is geen tweede aanbod.</p>
            <Button size="small" variant="text" color="secondary" onClick={source}>
              Bekijk bron
            </Button>
          </div>
        ) : (
          <OfferDetail allowDismiss={phase !== 'dismissed'} />
        )}
      </InspectionDialog>
    </>
  )
}
