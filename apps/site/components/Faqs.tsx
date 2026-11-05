'use client'

import { ChevronDown as IconChevronBottom } from 'lucide-react'
import { useId, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { twMerge } from 'tailwind-merge'
import type { SiteLocale } from '../lib/locale-shared'
import { siteText } from '../lib/locale-shared'
import { Container, SectionLabel, SectionTitle } from './ui'

const dutchFaqs = [
  {
    title: 'Blijven mijn gegevens lokaal?',
    content:
      'Remember bewaart je opnames, transcripties en werkgeschiedenis standaard op je Mac. Voor AI-analyse stuurt de app tekst uit je transcripties en vastgelegde schermactiviteit naar je eigen ChatGPT- of Claude-account; ruwe audio gaat niet naar deze agents. Kies je verwerking met Revinote, dan uploadt Remember de afgeronde opname naar je Revinote-account. Je Spaces blijven lokaal; een Remember-account is niet nodig. Bekijk het [privacybeleid](/privacy).',
  },
  {
    title: 'Verlaat er iets mijn Mac?',
    content:
      'Standaard blijft je inhoud op je Mac. Deze optionele functies maken wel verbinding:\n\n- **AI-analyse.** Remember stuurt tekst uit je transcripties en vastgelegde schermactiviteit naar je eigen ChatGPT- of Claude-account. Die provider maakt de overzichten, gesprekken, actiepunten en kennis die je in Remember ziet. Ruwe audio gaat niet naar deze agents.\n- **Revinote.** Als je handmatige of automatische verwerking met Revinote gebruikt, uploadt Remember de afgeronde opname naar je Revinote-account en synchroniseert het verwerkte gesprek terug.\n- **Updates en installatie.** Remember vraagt GitHub regelmatig of er een nieuwe versie is. Het lokale transcriptiemodel wordt één keer van GitHub gedownload wanneer jij de installatie start.\n- **Technische foutmeldingen.** Bij een crash of mislukte analyse ontvangt Sentry opgeschoonde technische informatie, zoals app- en OS-versies, een foutcode en technische tellers. Nooit je opnames, transcripties, inhoud, prompts of antwoorden. Je kunt dit apart uitschakelen via Instellingen → Technische foutmeldingen. De voorkeur staat standaard aan en wordt lokaal bewaard. Offline mode pauzeert foutmeldingen ook, zonder je voorkeur te veranderen.\n\nRemember gebruikt geen productanalytics, advertentietracking of session replay. We ontvangen dus geen overzicht van welke apps, websites of lokale inhoud je gebruikt. Bekijk alle details in het [privacybeleid](/privacy).',
  },
  {
    title: 'Werkt Remember offline?',
    content:
      'Ja, zodra het transcriptiemodel is geïnstalleerd. In Offline mode blijven opnemen, opslaan, zoeken en transcriberen werken. AI-verzoeken, Revinote-sync, foutmeldingen, modeldownloads en updatecontroles pauzeren. Opnames die je in Offline mode afrondt, worden later niet automatisch naar Revinote gestuurd.',
  },
  {
    title: 'Welke Macs worden ondersteund?',
    content: 'macOS 14.4 of nieuwer, op een Mac met Apple Silicon (M1 of nieuwer).',
  },
] as const

const englishFaqs = [
  {
    title: 'Does my data stay local?',
    content:
      'Remember stores your recordings, transcripts, and work history on your Mac by default. For AI analysis, the app sends text from your transcripts and captured screen activity to your own ChatGPT or Claude account; raw audio is not sent to these agents. If you choose Revinote processing, Remember uploads the completed recording to your Revinote account. Your Spaces stay local; no Remember account is needed. See the [privacy policy](/privacy).',
  },
  {
    title: 'Does anything leave my Mac?',
    content:
      'Your content stays on your Mac by default. These optional features do connect:\n\n- **AI analysis.** Remember sends text from your transcripts and captured screen activity to your own ChatGPT or Claude account. That provider creates the overviews, conversations, action points, and knowledge you see in Remember. Raw audio is not sent to these agents.\n- **Revinote.** If you use manual or automatic Revinote processing, Remember uploads the completed recording to your Revinote account and syncs the processed conversation back.\n- **Updates and setup.** Remember periodically asks GitHub whether a new version is available. The local transcription model is downloaded once from GitHub when you start the installation.\n- **Technical error reports.** If the app crashes or an analysis fails, Sentry receives sanitized technical information such as app and OS versions, an error code, and technical counters. Never your recordings, transcripts, content, prompts, or responses. You can turn this off independently in Settings → Technical error reports. The preference is on by default and stored locally. Offline mode also pauses error reports without changing your preference.\n\nRemember has no product analytics, advertising tracking, or session replay. We do not receive an overview of which apps, websites, or local content you use. See every detail in the [privacy policy](/privacy).',
  },
  {
    title: 'Does Remember work offline?',
    content:
      'Yes, once the transcription model is installed. In Offline mode, recording, storage, search, and transcription keep working. AI requests, Revinote sync, error reports, model downloads, and update checks are paused. Recordings completed in Offline mode are not automatically sent to Revinote later.',
  },
  {
    title: 'Which Macs are supported?',
    content: 'macOS 14.4 or later, on an Apple Silicon Mac (M1 or newer).',
  },
] as const

function FaqItem({ title, content }: { title: string; content: string }) {
  const [isOpen, setIsOpen] = useState(false)
  const buttonId = useId()
  const panelId = useId()

  return (
    <div className="border-b border-slate-300 py-6">
      <button
        type="button"
        id={buttonId}
        aria-expanded={isOpen}
        aria-controls={panelId}
        onClick={() => setIsOpen((open) => !open)}
        className="flex min-h-11 w-full cursor-pointer items-center justify-between gap-4 text-left font-semibold text-slate-900 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500"
      >
        <span className="text-lg">{title}</span>
        <span className="flex size-8 shrink-0 items-center justify-center">
          <IconChevronBottom
            className={twMerge(
              'size-4 text-slate-500 transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
              isOpen && 'rotate-180'
            )}
          />
        </span>
      </button>
      <div
        id={panelId}
        role="region"
        aria-labelledby={buttonId}
        inert={!isOpen}
        className={twMerge(
          'grid transition-[grid-template-rows,opacity] duration-300 ease-out motion-reduce:transition-none',
          isOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="mt-2 max-w-3xl pr-12 text-base leading-7 font-medium text-slate-600 [&>*+*]:mt-3">
            <ReactMarkdown
              components={{
                a: ({ children, href }) => (
                  <a
                    href={href}
                    className="rounded-sm text-blue-700 underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500"
                  >
                    {children}
                  </a>
                ),
                ul: ({ children }) => <ul className="ml-5 list-disc space-y-1.5">{children}</ul>,
              }}
            >
              {content}
            </ReactMarkdown>
          </div>
        </div>
      </div>
    </div>
  )
}

export function Faqs({ locale }: { locale: SiteLocale }) {
  const faqs = [
    {
      title: siteText(locale, 'Is Remember gratis?', 'Is Remember free?'),
      content: siteText(
        locale,
        'Ja. Remember is gratis en open source onder de MIT-licentie. ChatGPT en Claude gebruiken je eigen abonnement of credits.',
        'Yes. Remember is free and open source under the MIT license. ChatGPT and Claude use your own subscription or credits.'
      ),
    },
    ...(locale === 'nl' ? dutchFaqs : englishFaqs),
  ]
  return (
    <section id="faqs" className="border-b border-slate-300">
      <Container className="landing-frame-x py-12 sm:py-16">
        <div className="grid gap-4">
          <SectionLabel>{siteText(locale, 'Vraag maar raak', 'Ask away')}</SectionLabel>
          <div className="flex flex-col gap-2 text-center">
            <SectionTitle>{siteText(locale, 'Veelgestelde vragen', 'Frequently asked questions')}</SectionTitle>
            <p className="text-base sm:text-lg font-medium text-slate-600">
              {siteText(
                locale,
                'Staat je vraag er niet tussen? Stuur een mailtje naar',
                'Can’t find your question? Email'
              )}{' '}
              <a
                href="mailto:support@remember.computer"
                className="rounded-sm font-semibold text-blue-700 underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500"
              >
                {siteText(locale, 'onze support', 'our support team')}
              </a>
            </p>
          </div>
        </div>
      </Container>

      <Container className="landing-frame-x">
        <div className="mx-auto max-w-3xl pb-16">
          {faqs.map((faq) => (
            <FaqItem key={faq.title} title={faq.title} content={faq.content} />
          ))}
        </div>
      </Container>
    </section>
  )
}
