'use client'

import { ArrowUp as IconArrowUp } from 'lucide-react'
import { Mic as IconMicrophone } from 'lucide-react'
import { usePreviewText } from './locale'

export function AssistantPreviewView() {
  const { t } = usePreviewText()

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col">
      <h1 className="sr-only">Agent</h1>
      <div className="relative my-auto w-full shrink-0">
        <div className="custom-scrollbar -my-3 overflow-y-hidden py-3" style={{ scrollbarGutter: 'stable both-edges' }}>
          <div className="mx-auto w-full max-w-[782px] px-4 pb-[52px]">
            <h2 className="mb-6 text-center text-lg font-medium tracking-tight text-slate-900">
              {t('Wat houdt je bezig?', 'What’s on your mind?')}
            </h2>
            <div className="rounded-2xl border border-slate-300 bg-white p-2 shadow-[0_4px_20px_0_rgb(0_0_0/0.04)] focus-within:border-slate-400">
              <label htmlFor="preview-assistant-message" className="sr-only">
                {t('Bericht aan de agent', 'Message to the agent')}
              </label>
              <div className="relative flex min-h-[86px] items-end gap-2">
                <textarea
                  id="preview-assistant-message"
                  readOnly
                  value=""
                  rows={1}
                  maxLength={20_000}
                  placeholder={t('Schrijf een bericht…', 'Write a message…')}
                  className="block max-h-44 min-h-7 min-w-0 flex-1 resize-none bg-transparent px-1.5 py-1 text-base leading-6 text-slate-900 outline-none placeholder:text-slate-400 [field-sizing:content] self-start pb-10"
                />
                <button
                  type="button"
                  disabled
                  aria-label={t('Dicteren', 'Dictate')}
                  title={t('Dicteren is beschikbaar in de Mac-app.', 'Dictation is available in the Mac app.')}
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg text-slate-400"
                >
                  <IconMicrophone className="size-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  disabled
                  aria-label={t('Versturen', 'Send')}
                  className="flex size-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-700 shadow-raised outline-none hover:bg-slate-200 hover:text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 disabled:cursor-not-allowed disabled:text-slate-500 disabled:shadow-none"
                >
                  <IconArrowUp className="size-4" aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
