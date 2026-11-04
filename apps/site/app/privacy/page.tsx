import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { LandingPageShell } from '../../components/LandingPageShell'
import { getSiteLocale } from '../../lib/locale'
import type { SiteLocale } from '../../lib/locale-shared'
import { siteText } from '../../lib/locale-shared'
import { pageMetadata } from '../../lib/siteMetadata'

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getSiteLocale()
  return pageMetadata({
    locale,
    title: siteText(locale, 'Privacybeleid', 'Privacy policy'),
    description: siteText(
      locale,
      'Hoe Remember lokale gegevens en optionele externe verbindingen verwerkt.',
      'How Remember handles local data and optional external connections.'
    ),
    path: '/privacy',
  })
}

function PrivacySection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-slate-200 border-t pt-7">
      <h2 className="font-marketing font-semibold text-2xl text-slate-900 tracking-tight">{title}</h2>
      <div className="mt-3 space-y-3 text-base text-slate-600 leading-7">{children}</div>
    </section>
  )
}

function PrivacyContent({ locale }: { locale: SiteLocale }) {
  if (locale === 'nl') {
    return (
      <>
        <PrivacySection title="Wie verantwoordelijk is">
          <p>
            Remember wordt aangeboden door Pionyr. Voor vragen of verzoeken over privacy kun je mailen naar{' '}
            <a
              className="font-medium text-blue-700 underline underline-offset-4"
              href="mailto:support@remember.computer"
            >
              support@remember.computer
            </a>
            .
          </p>
        </PrivacySection>

        <PrivacySection title="Gegevens op je Mac">
          <p>
            Remember is standaard lokaal. Opnames, transcripties, activiteit, Day-overzichten, instellingen en je Spaces
            worden opgeslagen in de lokale gegevensmap van Remember op je Mac. Remember heeft geen account of centrale
            clouddatabase waarin deze inhoud wordt opgeslagen.
          </p>
          <p>
            Remember transcribeert opnames lokaal. ChatGPT en Claude ontvangen geen ruwe audio. Wanneer je AI-analyse
            inschakelt, stuurt Remember relevante transcriptietekst en andere Day-activiteit naar je gekoppelde account
            om gesprekken en Day-overzichten te maken. Day-activiteit bevat vastgelegde schermtekst, die privéberichten,
            documenten en andere zichtbare informatie kan bevatten.
          </p>
          <p>
            Remember bevat geen productanalytics, advertentietracking of session replay. We ontvangen geen overzicht van
            welke functies, apps, websites of lokale inhoud je gebruikt.
          </p>
        </PrivacySection>

        <PrivacySection title="Optionele Revinote-koppeling">
          <p>
            Revinote is optioneel. Als je een gesprek handmatig of automatisch met Revinote laat verwerken, uploadt
            Remember het afgeronde audiobestand naar je Revinote-account. Revinote verwerkt de opname en Remember
            synchroniseert het gesprek terug naar je lokale Day. Opnames die je niet met Revinote laat verwerken,
            blijven lokaal.
          </p>
          <p>
            Offline mode blokkeert deze upload. Opnames die je afrondt terwijl Offline mode aanstaat, blijven lokaal en
            worden niet in een wachtrij gezet om later automatisch naar Revinote te worden gestuurd. Nadat je Offline
            mode uitzet, kun je nog wel zelf voor Revinote-verwerking kiezen.
          </p>
        </PrivacySection>

        <PrivacySection title="Technische foutmeldingen">
          <p>
            De desktopapp verstuurt technische foutmeldingen naar Sentry om crashes en mislukte Day-analyses te kunnen
            onderzoeken, tenzij Offline mode aanstaat. Zo’n melding bevat alleen een opgeschoonde stacktrace, de app-,
            Electron- en OS-versie en bij een Day-analyse een foutcode, agent, fase en technische tellers zoals de
            omvang van in- en uitvoer.
          </p>
          <p>
            Remember verstuurt hiervoor geen opnames, transcripties, scherm- of appactiviteit, Day- of Wiki-inhoud,
            prompts, agentantwoorden, logregels, lokale bestandspaden, e-mailadressen of gebruikers-ID’s. Session
            replay, performance tracing, screenshots en profielen staan uit. IP-adressen en daarvan afgeleide
            locatiegegevens worden voor dit Sentry-project niet opgeslagen.
          </p>
        </PrivacySection>

        <PrivacySection title="Externe verbindingen en Offline mode">
          <p>
            Buiten de functies hierboven controleert de geïnstalleerde app standaard via GitHub op updates. Het lokale
            transcriptiemodel wordt eenmalig van GitHub gedownload wanneer jij de installatie start. GitHub, Sentry,
            Revinote, OpenAI en Anthropic ontvangen bij een verbinding hun gebruikelijke technische verzoekmetadata en
            verwerken gegevens volgens hun eigen voorwaarden.
          </p>
          <p>
            Offline mode blokkeert alle uitgaande verbindingen van Remember. Opnemen, opslaan, zoeken en transcriberen
            met een al geïnstalleerd model blijven lokaal werken. AI-analyse, Revinote-synchronisatie, technische
            foutmeldingen, modeldownloads en updatecontroles pauzeren tot je Offline mode uitzet. De instelling wordt
            lokaal bewaard en staat standaard uit. Opnames die je in Offline mode afrondt, blijven lokaal en worden
            later niet automatisch naar Revinote gestuurd.
          </p>
        </PrivacySection>

        <PrivacySection title="Bewaren, verwijderen en verbreken">
          <p>
            Lokale gegevens, inclusief je Spaces, blijven op je Mac totdat je ze in Remember verwijdert of de lokale
            gegevens wist. Er is geen Remember-cloudkopie. Gebruik je eigen back-upvoorziening als je deze gegevens wilt
            kunnen herstellen.
          </p>
          <p>
            Je kunt optionele AI- en Revinote-verbindingen verbreken in de app. Gegevens die al naar een externe
            provider zijn gestuurd, vallen onder het bewaarbeleid van die provider. Voor privacyvragen kun je contact
            opnemen via het e-mailadres hierboven.
          </p>
        </PrivacySection>

        <PrivacySection title="Beveiliging en wijzigingen">
          <p>
            Remember bewaart je werkgeheugen lokaal en gebruikt versleutelde verbindingen voor externe providers.
            Beveilig je Mac en de accounts die je zelf koppelt. De broncode is beschikbaar onder de MIT-licentie.
          </p>
          <p>
            We kunnen dit beleid aanpassen wanneer Remember verandert of wetgeving dat vereist. De actuele versie staat
            altijd op deze pagina met de datum van de laatste wijziging.
          </p>
        </PrivacySection>
      </>
    )
  }

  return (
    <>
      <PrivacySection title="Who is responsible">
        <p>
          Remember is provided by Pionyr. For privacy questions or requests, email{' '}
          <a className="font-medium text-blue-700 underline underline-offset-4" href="mailto:support@remember.computer">
            support@remember.computer
          </a>
          .
        </p>
      </PrivacySection>

      <PrivacySection title="Data on your Mac">
        <p>
          Remember is local by default. Recordings, transcripts, activity, Day overviews, settings, and all your Spaces
          are stored in Remember’s local data folder on your Mac. Remember does not have an account or central cloud
          database that stores this content.
        </p>
        <p>
          Remember transcribes recordings locally. ChatGPT and Claude do not receive raw audio. When you enable AI
          analysis, Remember sends relevant transcript text and other Day activity to your connected account to create
          conversations and Day overviews. Day activity includes captured screen text, which can contain private
          messages, documents, and other visible information.
        </p>
        <p>
          Remember contains no product analytics, advertising tracking, or session replay. We do not receive an overview
          of which features, apps, websites, or local content you use.
        </p>
      </PrivacySection>

      <PrivacySection title="Optional Revinote connection">
        <p>
          Revinote is optional. If you choose manual or automatic Revinote processing for a conversation, Remember
          uploads the completed audio file to your Revinote account. Revinote processes the recording, and Remember
          syncs the conversation back to your local Day. Recordings you do not process with Revinote stay local.
        </p>
        <p>
          Offline mode blocks this upload. Recordings completed while Offline mode is on stay local and are not queued
          for automatic delivery to Revinote later. After turning Offline mode off, you can still explicitly choose
          Revinote processing.
        </p>
      </PrivacySection>

      <PrivacySection title="Technical error reports">
        <p>
          The desktop app sends technical error reports to Sentry so that crashes and failed Day analyses can be
          investigated, unless Offline mode is enabled. A report contains only a sanitized stack trace, the app,
          Electron, and OS versions, and for a Day analysis an error code, agent, phase, and technical counters such as
          input and output sizes.
        </p>
        <p>
          Remember does not send recordings, transcripts, screen or app activity, Day or Wiki content, prompts, agent
          answers, log lines, local file paths, email addresses, or user IDs for this purpose. Session replay,
          performance tracing, screenshots, and profiling are disabled. IP addresses and location data derived from them
          are not stored for this Sentry project.
        </p>
      </PrivacySection>

      <PrivacySection title="External connections and Offline mode">
        <p>
          Beyond the features above, the installed app checks GitHub for updates by default. The local transcription
          model is downloaded once from GitHub when you start setup. When a connection is made, GitHub, Sentry,
          Revinote, OpenAI, and Anthropic receive their usual technical request metadata and process data under their
          own terms.
        </p>
        <p>
          Offline mode blocks every outgoing connection made by Remember. Recording, storage, search, and transcription
          with an already installed model keep working locally. AI analysis, Revinote sync, technical error reports,
          model downloads, and update checks pause until you turn Offline mode off. The setting is stored locally and is
          off by default. Recordings completed in Offline mode stay local and are not automatically sent to Revinote
          later.
        </p>
      </PrivacySection>

      <PrivacySection title="Retention, deletion, and disconnecting">
        <p>
          Local data, including your Spaces, remains on your Mac until you delete it in Remember or clear the app’s
          local data. There is no Remember cloud copy. Use your own backup system if you want to restore this data.
        </p>
        <p>
          You can disconnect optional AI and Revinote connections in the app. Data already sent to an external provider
          remains subject to that provider’s retention policy. For privacy questions, contact us at the email address
          above.
        </p>
      </PrivacySection>

      <PrivacySection title="Security and changes">
        <p>
          Remember stores your work memory locally and uses encrypted connections for external providers. Secure your
          Mac and any accounts you choose to connect. The source code is available under the MIT license.
        </p>
        <p>
          We may update this policy when Remember changes or applicable rules require it. The current version and its
          last updated date will always appear on this page.
        </p>
      </PrivacySection>
    </>
  )
}

export default async function PrivacyPage() {
  const locale = await getSiteLocale()
  return (
    <LandingPageShell locale={locale}>
      <article className="w-full max-w-3xl">
        <header className="pb-10 text-center">
          <h1 className="font-marketing text-balance font-semibold text-[40px] text-slate-900 leading-[1.1] tracking-tight sm:text-5xl">
            {siteText(locale, 'Privacybeleid', 'Privacy policy')}
          </h1>
          <p className="mt-4 text-slate-500 text-sm">
            {siteText(locale, 'Laatst bijgewerkt: 4 november 2026', 'Last updated: November 4, 2026')}
          </p>
        </header>
        <div className="space-y-9">
          <PrivacyContent locale={locale} />
        </div>
      </article>
    </LandingPageShell>
  )
}
