'use client'

import type { PropsWithChildren } from 'react'
import { createContext, useContext } from 'react'
import type { SiteLocale } from '../../lib/locale-shared'

const previewEnglish: Record<string, string> = {
  Werkdagen: 'Workdays',
  Taken: 'Tasks',
  'Mijn dag': 'My Day',
  Gesprekken: 'Conversations',
  Activiteit: 'Activity',
  Instellingen: 'Settings',
  Privacy: 'Privacy',
  Spaces: 'Spaces',
  Productteam: 'Product team',
  Klantonderzoek: 'Customer research',
  Projecten: 'Projects',
  Besluiten: 'Decisions',
  Onderzoek: 'Research',
  Mensen: 'People',
  Processen: 'Processes',
  Concepten: 'Concepts',
  Systeemaudio: 'System audio',
  Microfoon: 'Microphone',
  'Wekelijkse productsync': 'Weekly product sync',
  'Designreview onboarding': 'Onboarding design review',
  'Onboardingrelease, feedback uit support en de gefaseerde uitrol.':
    'Onboarding release, support feedback, and the phased rollout.',
  'Laatste prototypecheck met design en customer success.': 'Final prototype review with design and customer success.',
  'Deel de herziene onboardingflow met Elena': 'Share the revised onboarding flow with Elena',
  'Werk de rolloutnotitie bij met de gefaseerde meetpunten': 'Update the rollout note with the phased metrics',
  'Werk de rolloutnotitie bij met de meetpunten': 'Update the rollout note with the metrics',
  'Pas de succesboodschap aan in het prototype': 'Update the success message in the prototype',
  'Stuur de definitieve Figma-flow vandaag, zodat Elena morgenochtend kan reviewen.':
    'Send the final Figma flow today so Elena can review it tomorrow morning.',
  'De terugknop blijft zichtbaar en de succesboodschap verwijst naar het eerste dagoverzicht.':
    'The back button remains visible and the success message points to the first daily overview.',
  'Wekelijkse productsync · 10:30': 'Weekly product sync · 10:30',
  '“Elena kan de flow morgenochtend reviewen als de laatste variant vandaag gedeeld wordt.”':
    '“Elena can review the flow tomorrow morning if the final version is shared today.”',
  'Leg activatie en onboardingvoltooiing vast als eerste signalen voor de gefaseerde uitrol.':
    'Record activation and onboarding completion as the first signals for the phased rollout.',
  'Uitgebreidere activiteitsanalytics volgt pas na de eerste week en blokkeert de release niet.':
    'Deeper activity analytics follows after the first week and does not block the release.',
  'Besluit: lege staat nu uitrollen, diepere analytics later evalueren.':
    'Decision: ship the empty state now and evaluate deeper analytics later.',
  'Gebruik: “Je eerste dagoverzicht staat vanavond klaar.”': '“Your first daily overview will be ready tonight.”',
  'Customer success neemt dezelfde formulering over in de release-uitleg.':
    'Customer success uses the same wording in the release explanation.',
  'Designreview onboarding · 15:00': 'Onboarding design review · 15:00',
  'De huidige tekst zegt alleen “Klaar” en legt niet uit wat er daarna gebeurt.':
    'The current text only says “Done” and does not explain what happens next.',
  'De flow is klaar voor Elena’s laatste review. De terugknop blijft zichtbaar tijdens de toestemmingsstap en de succesboodschap noemt concreet waar het eerste dagoverzicht verschijnt. Customer success gebruikt dezelfde formulering in de release-uitleg.':
    "The flow is ready for Elena's final review. The back button remains visible during the permission step, and the success message says exactly where the first daily overview appears. Customer success will use the same wording in the release explanation.",
  'Het team houdt de onboardingrelease op donderdag. De nieuwe lege staat gaat mee; uitgebreidere activiteitsanalytics schuift door tot na de eerste week. Elena reviewt morgenochtend de definitieve flow en Sam werkt vandaag de rolloutnotitie en meetpunten bij.':
    'The team is keeping the onboarding release on Thursday. The new empty state ships now; deeper activity analytics moves to after the first week. Elena reviews the final flow tomorrow morning, and Sam updates the rollout note and metrics today.',
  'Support ziet vooral uitval vóór de toestemmingsstap. De lege staat zelf lijkt niet het probleem.':
    'Support mainly sees drop-off before the permission step. The empty state itself does not seem to be the problem.',
  'Dan zou ik de begeleide lege staat wel meenemen, maar de uitgebreidere analytics niet aan deze release koppelen.':
    'Then I would include the guided empty state, but not tie the deeper analytics to this release.',
  'Akkoord. Elena kan de flow morgenochtend reviewen als de laatste variant vandaag gedeeld wordt.':
    'Agreed. Elena can review the flow tomorrow morning if the final version is shared today.',
  'Ik werk ook de rolloutnotitie bij met activatie en voltooiing als eerste meetpunten.':
    'I will also update the rollout note with activation and completion as the first metrics.',
  'Met de terugknop hier voelt de toestemmingsstap minder definitief. Die zou ik laten staan.':
    'With the back button here, the permission step feels less final. I would keep it.',
  'Mee eens. Ik maak de succesboodschap specifieker: je eerste dagoverzicht staat vanavond klaar.':
    'Agreed. I will make the success message more specific: your first daily overview will be ready tonight.',
  'Dat is ook precies de zin die we in de release-uitleg kunnen gebruiken.':
    'That is exactly the sentence we can use in the release explanation too.',
  'Nieuwe toestemmingsflow, begeleide lege staat en releaseplanning.':
    'New permission flow, guided empty state, and release planning.',
  'Designlead voor de onboardingrefresh en eigenaar van de laatste review.':
    'Design lead for the onboarding refresh and owner of the final review.',
  'Eerst activatie en voltooiing meten; diepere analytics volgt later.':
    'Measure activation and completion first; deeper analytics comes later.',
  'Een rustige eerste ervaring die meteen naar het eerste dagoverzicht leidt.':
    'A calm first experience that leads directly to the first daily overview.',
  'Supportsignalen wijzen op onzekerheid vóór de macOS-toestemmingsstap.':
    'Support signals point to uncertainty before the macOS permission step.',
  'Gedeelde uitleg, screenshots en antwoorden voor de release van donderdag.':
    'Shared guidance, screenshots, and answers for Thursday’s release.',
  'Laatste review, rolloutnotitie en gedeelde formulering voor support.':
    'Final review, rollout note, and shared wording for support.',
  'Gebruikers houden een duidelijke uitweg voordat macOS om toestemming vraagt.':
    'People keep a clear way back before macOS asks for permission.',
  'De onboardingrefresh vermindert uitval vóór de toestemmingsstap. De flow houdt de terugknop zichtbaar en vertelt na afronding waar het eerste dagoverzicht verschijnt.\n\nRelease staat op donderdag. Elena doet morgenochtend de laatste review; daarna kan de gefaseerde uitrol starten.':
    'The onboarding refresh reduces drop-off before the permission step. The flow keeps the back button visible and explains where the first daily overview will appear.\n\nRelease is scheduled for Thursday. Elena performs the final review tomorrow morning; the phased rollout can start afterward.',
  'De begeleide lege staat gaat mee in de release. Uitgebreidere activiteitsanalytics is geen voorwaarde en wordt na de eerste week opnieuw beoordeeld.\n\nDe eerste meetpunten zijn activatie van vastleggen en voltooiing van de onboarding.':
    'The guided empty state ships in the release. Deeper activity analytics is not a requirement and will be reassessed after the first week.\n\nThe first metrics are capture activation and onboarding completion.',
  'De meeste afhakers stoppen voordat macOS om toestemming vraagt. De lege staat na activatie levert nauwelijks vragen op.\n\nEen zichtbare terugknop en concrete uitleg over het eerste resultaat moeten die onzekerheid verminderen.':
    'Most people drop off before macOS asks for permission. The empty state after activation generates almost no questions.\n\nA visible back button and a concrete explanation of the first result should reduce that uncertainty.',
  'De eigenaar deelt vóór het einde van de dag de definitieve Figma-flow en werkt de rolloutnotitie bij.\n\nNa Elena’s review worden product, design en customer success in Slack geïnformeerd.':
    "The owner shares the final Figma flow before the end of the day and updates the rollout note.\n\nAfter Elena's review, product, design, and customer success are informed in Slack.",
  'Elena bewaakt de samenhang tussen de toestemmingsstap, de lege staat en de eerste succesboodschap. Ze doet donderdagochtend de laatste designreview.\n\nOpen punt: bevestigen dat de terugknop op iedere stap zichtbaar blijft.':
    'Elena safeguards the flow between permissions, the empty state, and the first success message. She performs the final design review on Thursday morning.\n\nOpen point: confirm that the back button remains visible at every step.',
  'De begeleide lege staat legt in één zin uit wat Remember al heeft vastgelegd en wanneer het eerste dagoverzicht verschijnt. Er is één primaire actie en geen extra configuratie.\n\nDeze aanpak vermindert onzekerheid zonder de onboarding langer te maken.':
    'The guided empty state explains in one sentence what Remember has captured and when the first daily overview will appear. It has one primary action and no extra configuration.\n\nThis approach reduces uncertainty without making onboarding longer.',
  'Customer success gebruikt dezelfde uitleg als de onboarding: wat lokaal blijft, wanneer het eerste overzicht klaarstaat en hoe iemand opnieuw kan beginnen.\n\nDe definitieve screenshots worden na Elena’s review toegevoegd.':
    'Customer success uses the same explanation as onboarding: what stays local, when the first overview is ready, and how someone can start again.\n\nThe final screenshots are added after Elena’s review.',
  'De terugknop blijft zichtbaar totdat alle macOS-toestemmingen zijn afgerond. Teruggaan wist geen eerdere keuze en start de installatie niet opnieuw.\n\nDit besluit volgt uit supportfeedback over het definitieve gevoel van de toestemmingsstap.':
    'The back button remains visible until all macOS permissions are complete. Going back does not clear an earlier choice or restart installation.\n\nThis decision follows support feedback about the permission step feeling too final.',
  'onboarding-step.tsx · tests en review': 'onboarding-step.tsx · tests and review',
  'Staging, supporttickets en pull request': 'Staging, support tickets, and pull request',
  'Onboarding refresh · final flow': 'Onboarding refresh · final flow',
  'Implementatievragen en testanalyse': 'Implementation questions and test analysis',
  'Product, design en support': 'Product, design, and support',
  'Productsync en designreview': 'Product sync and design review',
  'Rolloutnotitie en meetplan': 'Rollout note and measurement plan',
  'Dagplanning en afspraken': 'Day planning and meetings',
  'Onboardingvarianten en prototype': 'Onboarding variants and prototype',
  'Componenten en states': 'Components and states',
  'Research en staging': 'Research and staging',
  'Asynchrone feedback': 'Async feedback',
  Onderzoeksnotities: 'Research notes',
  'Gefaseerde onboardinguitrol': 'Phased onboarding rollout',
  'Elena van Dijk': 'Elena van Dijk',
  'Begeleide lege staat': 'Guided empty state',
  'Uitval bij toestemmingen': 'Permission drop-off',
  'Release-uitleg voor support': 'Release guidance for support',
  'Release-handoff': 'Release handoff',
  'Terugknop bij toestemmingen': 'Back button during permissions',
  'Onderzoeksplan onboarding': 'Onboarding research plan',
  'Patronen in de eerste week': 'First-week patterns',
  'Wervingscriteria pilot': 'Pilot recruitment criteria',
  'Noor de Vries': 'Noor de Vries',
  Interviewanalyse: 'Interview synthesis',
  'Eerste moment van waarde': 'First moment of value',
  'Het onderzoek volgt acht nieuwe gebruikers vanaf installatie tot hun eerste bruikbare dagoverzicht. We combineren interviews met lokale activatiesignalen en supportvragen.\n\nDe eerste ronde start donderdag. Product en customer success lezen vrijdag samen de eerste patronen.':
    'The study follows eight new users from installation to their first useful daily overview. We combine interviews with local activation signals and support questions.\n\nThe first round starts Thursday. Product and customer success review the first patterns together on Friday.',
  'Nieuwe gebruikers begrijpen het lokale karakter snel, maar twijfelen vóór de macOS-toestemmingen nog over wat er precies wordt vastgelegd.\n\nEen concrete uitleg van het eerste resultaat verkleint die onzekerheid sterker dan extra technische details.':
    'New users understand the local-first model quickly, but still hesitate before macOS permissions because they are unsure what is captured.\n\nA concrete explanation of the first result reduces that uncertainty more than additional technical detail.',
  'De pilot werft zelfstandige kenniswerkers die Remember nog niet hebben gebruikt en dagelijks meerdere apps combineren. Bestaande beta-gebruikers blijven buiten deze ronde.\n\nZo meten we de eerste ervaring zonder voorkennis of eerdere configuratie.':
    'The pilot recruits independent knowledge workers who have not used Remember and combine several apps each day. Existing beta users are excluded from this round.\n\nThis lets us evaluate the first experience without prior knowledge or configuration.',
  'Noor leidt de interviews, bewaakt de onderzoeksvragen en deelt iedere vrijdag een korte synthese met product en design.\n\nOpen punt: twee extra deelnemers vinden die voornamelijk in het Nederlands werken.':
    'Noor leads the interviews, maintains the research questions, and shares a short synthesis with product and design every Friday.\n\nOpen point: find two additional participants who primarily work in Dutch.',
  'Na ieder gesprek worden observaties eerst afzonderlijk vastgelegd. Pas daarna groepeert het team terugkerende patronen, afwijkingen en onbeantwoorde vragen.\n\nBesluiten blijven gescheiden van ruwe observaties zodat nieuwe interviews eerdere conclusies kunnen corrigeren.':
    'After each conversation, observations are recorded separately first. Only then does the team group recurring patterns, exceptions, and unanswered questions.\n\nDecisions remain separate from raw observations so new interviews can correct earlier conclusions.',
  'Het eerste moment van waarde is bereikt wanneer iemand zonder hulp kan uitleggen wat Remember heeft onthouden en één bruikbaar inzicht terugvindt.\n\nSnelheid alleen is niet genoeg: de gebruiker moet ook vertrouwen hebben in waar de informatie vandaan komt.':
    'The first moment of value is reached when someone can explain without help what Remember retained and retrieve one useful insight.\n\nSpeed alone is not enough: the user must also trust where the information came from.',
  'Dag gepland en berichten verwerkt': 'Planned the day and processed messages',
  'Agenda bekeken en supportfeedback uit Slack gegroepeerd.':
    'Reviewed the calendar and grouped support feedback from Slack.',
  'Onboardingflow geïmplementeerd': 'Implemented the onboarding flow',
  'Toestemmingsstap en begeleide lege staat afgewerkt.': 'Finished the permission step and guided empty state.',
  'Releasebesluit, revieweigenaar en meetpunten afgestemd.':
    'Aligned on the release decision, review owner, and metrics.',
  'Prototype en copy aangescherpt': 'Refined the prototype and copy',
  'Terugknop behouden en succesboodschap concreter gemaakt.':
    'Kept the back button and made the success message more concrete.',
  Lunch: 'Lunch',
  'Geen computeractiviteit vastgelegd.': 'No computer activity recorded.',
  'Implementatie en tests afgerond': 'Completed implementation and tests',
  'Flow gekoppeld, tests bijgewerkt en reviewfeedback verwerkt.':
    'Connected the flow, updated tests, and addressed review feedback.',
  'Asynchrone review beantwoord': 'Responded to async review',
  'Open opmerkingen in Slack en Figma afgehandeld.': 'Resolved open comments in Slack and Figma.',
  'Definitieve flow met design en customer success doorlopen.':
    'Reviewed the final flow with design and customer success.',
  'Release-handoff geschreven': 'Wrote the release handoff',
  'Rolloutnotitie, meetpunten en gedeelde supportcopy vastgelegd.':
    'Documented the rollout note, metrics, and shared support copy.',
  'Onboarding refresh': 'Onboarding refresh',
  Releasevoorbereiding: 'Release preparation',
  'Support en planning': 'Support and planning',
}

type PreviewText = (value: string, english?: string) => string

const PreviewLocaleContext = createContext<SiteLocale>('en')

export function PreviewLocaleProvider({
  children,
  locale,
}: PropsWithChildren<{
  locale: SiteLocale
}>) {
  return <PreviewLocaleContext.Provider value={locale}>{children}</PreviewLocaleContext.Provider>
}

export function previewText(locale: SiteLocale, value: string, english?: string) {
  return locale === 'nl' ? value : (english ?? previewEnglish[value] ?? value)
}

export function usePreviewText(): { locale: SiteLocale; t: PreviewText } {
  const locale = useContext(PreviewLocaleContext)
  return { locale, t: (value, english) => previewText(locale, value, english) }
}
