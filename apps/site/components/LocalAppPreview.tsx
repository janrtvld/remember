'use client'

import {
  CLAUDE_ANALYSIS_MODELS,
  CODEX_ANALYSIS_MODELS,
  DEFAULT_FREQUENT_DAY_REFRESH_INTERVAL_MINUTES,
} from '@remember/shared'
import {
  Bot as IconAiBotHead,
  ArrowRight as IconArrowRight,
  RotateCw as IconArrowRotateClockwise,
  MessagesSquare as IconBubbles,
  CalendarDays as IconCalendarDays,
  Check as IconCheckmark1Small,
  ChevronDown as IconChevronDownSmall,
  ChevronLeft as IconChevronLeft,
  ChevronRight as IconChevronRight,
  Ellipsis as IconDotGrid1x3HorizontalTight,
  EyeOff as IconEyeSlash,
  FileText as IconFileText,
  Inbox as IconInbox,
  KeyRound as IconKey1,
  LoaderCircle as IconLoadingCircle,
  Search as IconMagnifyingGlass2,
  Pause as IconPause,
  Play as IconPlay,
  Plus as IconPlusSmall,
  Settings as IconSettingsGear2,
  SlidersHorizontal as IconSettingsSliderHor,
  Trash2 as IconTrashCanSimple,
  AppWindow as IconWindowApp,
} from 'lucide-react'
import dynamic from 'next/dynamic'
import Image from 'next/image'
import type { ComponentType, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { FilledSpaceIcon } from '../../web/ui/FilledSpaceIcon'
import { TerminalIcon } from '../../web/ui/LucideAnimated'
import type { SiteLocale } from '../lib/locale-shared'
import { AssistantPreviewView } from './local-app-preview/AssistantPreviewView'
import { PreviewLocaleProvider, usePreviewText } from './local-app-preview/locale'
import { PreviewDropdownSelect } from './local-app-preview/PreviewDropdownSelect'

const InboxPreviewView = dynamic(() =>
  import('./local-app-preview/InboxPreviewView').then((module) => module.InboxPreviewView)
)

type View = 'inbox' | 'today' | 'conversations' | 'wiki' | 'assistant' | 'agent' | 'exclusions' | 'settings'
type DayTab = 'overview' | 'conversations' | 'timeline'
type PreviewWikiSpace = 'personal' | 'product' | 'research'
type RecordingState = 'idle' | 'recording' | 'processing'

const previewWikiSpaceAppearances: Record<
  PreviewWikiSpace,
  {
    icon: 'lock' | 'book'
    foreground: string
    surface: string
  }
> = {
  personal: {
    icon: 'lock',
    foreground: 'text-[oklch(var(--categorical-grey))]',
    surface: 'bg-[oklch(var(--categorical-grey)/0.16)]',
  },
  product: {
    icon: 'book',
    foreground: 'text-[oklch(var(--categorical-green))]',
    surface: 'bg-[oklch(var(--categorical-green)/0.16)]',
  },
  research: {
    icon: 'book',
    foreground: 'text-[oklch(var(--categorical-purple))]',
    surface: 'bg-[oklch(var(--categorical-purple)/0.16)]',
  },
}

const primaryNavigation: Array<{
  id: View
  label: string
  icon: ComponentType<{ className?: string; mode?: 'masked' | 'raw' }>
}> = [
  { id: 'inbox', label: 'Taken', icon: IconInbox },
  { id: 'today', label: 'Mijn dag', icon: IconCalendarDays },
  { id: 'conversations', label: 'Gesprekken', icon: IconBubbles },
  { id: 'assistant', label: 'Agent', icon: IconAiBotHead },
]

const settingsNavigation: typeof primaryNavigation = [
  { id: 'agent', label: 'Agent', icon: TerminalIcon },
  { id: 'exclusions', label: 'Privacy', icon: IconEyeSlash },
  { id: 'settings', label: 'Instellingen', icon: IconSettingsGear2 },
]

function previewDate(dayOffset = 0) {
  const date = new Date()
  date.setHours(12, 0, 0, 0)
  date.setDate(date.getDate() - dayOffset)
  return date
}

function samePreviewDate(first: Date, second: Date) {
  return (
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  )
}

function formatPreviewDate(locale: SiteLocale, date: Date, style: 'long' | 'short') {
  const currentYear = previewDate().getFullYear()
  const formatted = new Intl.DateTimeFormat(locale === 'nl' ? 'nl-NL' : 'en-US', {
    weekday: style === 'long' ? 'long' : 'short',
    day: 'numeric',
    month: style === 'long' ? 'long' : 'short',
    ...(date.getFullYear() === currentYear ? {} : { year: 'numeric' as const }),
  }).format(date)
  return `${formatted.charAt(0).toLocaleUpperCase(locale)}${formatted.slice(1)}`
}

const conversations = [
  {
    title: 'Wekelijkse productsync',
    time: '10:30–11:03',
    description: 'Onboardingrelease, feedback uit support en de gefaseerde uitrol.',
    summary:
      'Het team houdt de onboardingrelease op donderdag. De nieuwe lege staat gaat mee; uitgebreidere activiteitsanalytics schuift door tot na de eerste week. Elena reviewt morgenochtend de definitieve flow en Sam werkt vandaag de rolloutnotitie en meetpunten bij.',
    actions: ['Deel de herziene onboardingflow met Elena', 'Werk de rolloutnotitie bij met de gefaseerde meetpunten'],
    transcript: [
      [
        'Systeemaudio',
        'Support ziet vooral uitval vóór de toestemmingsstap. De lege staat zelf lijkt niet het probleem.',
      ],
      [
        'Microfoon',
        'Dan zou ik de begeleide lege staat wel meenemen, maar de uitgebreidere analytics niet aan deze release koppelen.',
      ],
      [
        'Systeemaudio',
        'Akkoord. Elena kan de flow morgenochtend reviewen als de laatste variant vandaag gedeeld wordt.',
      ],
      ['Microfoon', 'Ik werk ook de rolloutnotitie bij met activatie en voltooiing als eerste meetpunten.'],
    ],
  },
  {
    title: 'Designreview onboarding',
    time: '15:00–15:32',
    description: 'Laatste prototypecheck met design en customer success.',
    summary:
      'De flow is klaar voor Elena’s laatste review. De terugknop blijft zichtbaar tijdens de toestemmingsstap en de succesboodschap noemt concreet waar het eerste dagoverzicht verschijnt. Customer success gebruikt dezelfde formulering in de release-uitleg.',
    actions: ['Pas de succesboodschap aan in het prototype'],
    transcript: [
      ['Systeemaudio', 'Met de terugknop hier voelt de toestemmingsstap minder definitief. Die zou ik laten staan.'],
      ['Microfoon', 'Mee eens. Ik maak de succesboodschap specifieker: je eerste dagoverzicht staat vanavond klaar.'],
      ['Systeemaudio', 'Dat is ook precies de zin die we in de release-uitleg kunnen gebruiken.'],
    ],
  },
]

const wikiCategories = [
  { slug: 'projects', label: 'Projecten' },
  { slug: 'decisions', label: 'Besluiten' },
  { slug: 'research', label: 'Onderzoek' },
  { slug: 'people', label: 'Mensen' },
  { slug: 'processes', label: 'Processen' },
  { slug: 'concepts', label: 'Concepten' },
] as const

type PreviewWikiPage = {
  slug: string
  title: string
  excerpt: string
  updated: string
  content: string
  sourceCount: number
}

const wikiPages: PreviewWikiPage[] = [
  {
    slug: 'projects/onboarding-refresh',
    title: 'Onboarding refresh',
    excerpt: 'Nieuwe toestemmingsflow, begeleide lege staat en releaseplanning.',
    updated: '6 aug',
    content:
      'De onboardingrefresh vermindert uitval vóór de toestemmingsstap. De flow houdt de terugknop zichtbaar en vertelt na afronding waar het eerste dagoverzicht verschijnt.\n\nRelease staat op donderdag. Elena doet morgenochtend de laatste review; daarna kan de gefaseerde uitrol starten.',
    sourceCount: 8,
  },
  {
    slug: 'people/elena-van-dijk',
    title: 'Elena van Dijk',
    excerpt: 'Designlead voor de onboardingrefresh en eigenaar van de laatste review.',
    updated: '6 aug',
    content:
      'Elena bewaakt de samenhang tussen de toestemmingsstap, de lege staat en de eerste succesboodschap. Ze doet donderdagochtend de laatste designreview.\n\nOpen punt: bevestigen dat de terugknop op iedere stap zichtbaar blijft.',
    sourceCount: 5,
  },
  {
    slug: 'decisions/onboarding-rollout',
    title: 'Gefaseerde onboardinguitrol',
    excerpt: 'Eerst activatie en voltooiing meten; diepere analytics volgt later.',
    updated: '6 aug',
    content:
      'De begeleide lege staat gaat mee in de release. Uitgebreidere activiteitsanalytics is geen voorwaarde en wordt na de eerste week opnieuw beoordeeld.\n\nDe eerste meetpunten zijn activatie van vastleggen en voltooiing van de onboarding.',
    sourceCount: 3,
  },
  {
    slug: 'concepts/guided-empty-state',
    title: 'Begeleide lege staat',
    excerpt: 'Een rustige eerste ervaring die meteen naar het eerste dagoverzicht leidt.',
    updated: '6 aug',
    content:
      'De begeleide lege staat legt in één zin uit wat Remember al heeft vastgelegd en wanneer het eerste dagoverzicht verschijnt. Er is één primaire actie en geen extra configuratie.\n\nDeze aanpak vermindert onzekerheid zonder de onboarding langer te maken.',
    sourceCount: 7,
  },
  {
    slug: 'research/permission-dropoff',
    title: 'Uitval bij toestemmingen',
    excerpt: 'Supportsignalen wijzen op onzekerheid vóór de macOS-toestemmingsstap.',
    updated: '5 aug',
    content:
      'De meeste afhakers stoppen voordat macOS om toestemming vraagt. De lege staat na activatie levert nauwelijks vragen op.\n\nEen zichtbare terugknop en concrete uitleg over het eerste resultaat moeten die onzekerheid verminderen.',
    sourceCount: 6,
  },
  {
    slug: 'projects/support-release-guidance',
    title: 'Release-uitleg voor support',
    excerpt: 'Gedeelde uitleg, screenshots en antwoorden voor de release van donderdag.',
    updated: '6 aug',
    content:
      'Customer success gebruikt dezelfde uitleg als de onboarding: wat lokaal blijft, wanneer het eerste overzicht klaarstaat en hoe iemand opnieuw kan beginnen.\n\nDe definitieve screenshots worden na Elena’s review toegevoegd.',
    sourceCount: 4,
  },
  {
    slug: 'processes/release-handoff',
    title: 'Release-handoff',
    excerpt: 'Laatste review, rolloutnotitie en gedeelde formulering voor support.',
    updated: '6 aug',
    content:
      'De eigenaar deelt vóór het einde van de dag de definitieve Figma-flow en werkt de rolloutnotitie bij.\n\nNa Elena’s review worden product, design en customer success in Slack geïnformeerd.',
    sourceCount: 4,
  },
  {
    slug: 'decisions/permission-back-button',
    title: 'Terugknop bij toestemmingen',
    excerpt: 'Gebruikers houden een duidelijke uitweg voordat macOS om toestemming vraagt.',
    updated: '5 aug',
    content:
      'De terugknop blijft zichtbaar totdat alle macOS-toestemmingen zijn afgerond. Teruggaan wist geen eerdere keuze en start de installatie niet opnieuw.\n\nDit besluit volgt uit supportfeedback over het definitieve gevoel van de toestemmingsstap.',
    sourceCount: 3,
  },
]

const customerResearchWikiPages: PreviewWikiPage[] = [
  {
    slug: 'projects/onboarding-research-plan',
    title: 'Onderzoeksplan onboarding',
    excerpt: 'Acht nieuwe gebruikers volgen van installatie tot eerste inzicht.',
    updated: '6 aug',
    content:
      'Het onderzoek volgt acht nieuwe gebruikers vanaf installatie tot hun eerste bruikbare dagoverzicht. We combineren interviews met lokale activatiesignalen en supportvragen.\n\nDe eerste ronde start donderdag. Product en customer success lezen vrijdag samen de eerste patronen.',
    sourceCount: 9,
  },
  {
    slug: 'research/first-week-patterns',
    title: 'Patronen in de eerste week',
    excerpt: 'Vertrouwen groeit zodra het eerste resultaat concreet wordt uitgelegd.',
    updated: '6 aug',
    content:
      'Nieuwe gebruikers begrijpen het lokale karakter snel, maar twijfelen vóór de macOS-toestemmingen nog over wat er precies wordt vastgelegd.\n\nEen concrete uitleg van het eerste resultaat verkleint die onzekerheid sterker dan extra technische details.',
    sourceCount: 12,
  },
  {
    slug: 'decisions/pilot-recruitment',
    title: 'Wervingscriteria pilot',
    excerpt: 'Nieuwe gebruikers zonder eerdere ervaring met Remember.',
    updated: '5 aug',
    content:
      'De pilot werft zelfstandige kenniswerkers die Remember nog niet hebben gebruikt en dagelijks meerdere apps combineren. Bestaande beta-gebruikers blijven buiten deze ronde.\n\nZo meten we de eerste ervaring zonder voorkennis of eerdere configuratie.',
    sourceCount: 4,
  },
  {
    slug: 'people/noor-de-vries',
    title: 'Noor de Vries',
    excerpt: 'Onderzoekslead voor interviews en wekelijkse synthese.',
    updated: '5 aug',
    content:
      'Noor leidt de interviews, bewaakt de onderzoeksvragen en deelt iedere vrijdag een korte synthese met product en design.\n\nOpen punt: twee extra deelnemers vinden die voornamelijk in het Nederlands werken.',
    sourceCount: 7,
  },
  {
    slug: 'processes/interview-synthesis',
    title: 'Interviewanalyse',
    excerpt: 'Observaties eerst vastleggen, conclusies daarna groeperen.',
    updated: '4 aug',
    content:
      'Na ieder gesprek worden observaties eerst afzonderlijk vastgelegd. Pas daarna groepeert het team terugkerende patronen, afwijkingen en onbeantwoorde vragen.\n\nBesluiten blijven gescheiden van ruwe observaties zodat nieuwe interviews eerdere conclusies kunnen corrigeren.',
    sourceCount: 5,
  },
  {
    slug: 'concepts/first-moment-of-value',
    title: 'Eerste moment van waarde',
    excerpt: 'Een bruikbaar inzicht terugvinden én begrijpen waar het vandaan komt.',
    updated: '4 aug',
    content:
      'Het eerste moment van waarde is bereikt wanneer iemand zonder hulp kan uitleggen wat Remember heeft onthouden en één bruikbaar inzicht terugvindt.\n\nSnelheid alleen is niet genoeg: de gebruiker moet ook vertrouwen hebben in waar de informatie vandaan komt.',
    sourceCount: 6,
  },
]

const timeline = [
  [
    '08:42–09:02',
    'Dag gepland en berichten verwerkt',
    'Agenda bekeken en supportfeedback uit Slack gegroepeerd.',
    ['Slack', 'Calendar'],
  ],
  [
    '09:02–10:21',
    'Onboardingflow geïmplementeerd',
    'Toestemmingsstap en begeleide lege staat afgewerkt.',
    ['Cursor', 'Claude', 'Chrome'],
  ],
  [
    '10:30–11:03',
    'Wekelijkse productsync',
    'Releasebesluit, revieweigenaar en meetpunten afgestemd.',
    ['Teams', 'Notion'],
  ],
  [
    '11:09–12:16',
    'Prototype en copy aangescherpt',
    'Terugknop behouden en succesboodschap concreter gemaakt.',
    ['Figma', 'Chrome', 'Slack'],
  ],
  ['12:16–13:03', 'Lunch', 'Geen computeractiviteit vastgelegd.', []],
  [
    '13:03–14:27',
    'Implementatie en tests afgerond',
    'Flow gekoppeld, tests bijgewerkt en reviewfeedback verwerkt.',
    ['Cursor', 'Claude', 'Chrome'],
  ],
  [
    '14:31–14:48',
    'Asynchrone review beantwoord',
    'Open opmerkingen in Slack en Figma afgehandeld.',
    ['Slack', 'Figma'],
  ],
  [
    '15:00–15:32',
    'Designreview onboarding',
    'Definitieve flow met design en customer success doorlopen.',
    ['Teams', 'Figma'],
  ],
  [
    '15:40–16:32',
    'Release-handoff geschreven',
    'Rolloutnotitie, meetpunten en gedeelde supportcopy vastgelegd.',
    ['Notion', 'Slack', 'Figma'],
  ],
] as const

export function LocalAppPreview({ locale }: { locale: SiteLocale }) {
  return (
    <PreviewLocaleProvider locale={locale}>
      <LocalAppPreviewContent />
    </PreviewLocaleProvider>
  )
}

function LocalAppPreviewContent() {
  const { t } = usePreviewText()
  const [view, setView] = useState<View>('today')
  const [dayTab, setDayTab] = useState<DayTab>('overview')
  const [conversation, setConversation] = useState<number | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [activeWikiSpace, setActiveWikiSpace] = useState<PreviewWikiSpace>('personal')
  const [researchSpaceCreated, setResearchSpaceCreated] = useState(true)
  const [recordingState, setRecordingState] = useState<RecordingState>('idle')
  const [recordingPaused, setRecordingPaused] = useState(false)
  const [recordingSeconds, setRecordingSeconds] = useState(0)
  const processingTimer = useRef<number | null>(null)

  useEffect(() => {
    if (recordingState !== 'recording' || recordingPaused) return
    const timer = window.setInterval(() => setRecordingSeconds((seconds) => seconds + 1), 1000)
    return () => window.clearInterval(timer)
  }, [recordingPaused, recordingState])

  useEffect(
    () => () => {
      if (processingTimer.current) window.clearTimeout(processingTimer.current)
    },
    []
  )

  function navigate(nextView: View) {
    setView(nextView)
    setConversation(null)
    setSearchOpen(false)
  }

  function startRecording() {
    if (processingTimer.current) window.clearTimeout(processingTimer.current)
    setRecordingSeconds(0)
    setRecordingPaused(false)
    setRecordingState('recording')
  }

  function stopRecording() {
    const returnToDay = view === 'today'
    setRecordingPaused(false)
    setRecordingState('processing')
    setConversation(null)
    if (returnToDay) setDayTab('conversations')
    else navigate('conversations')
    processingTimer.current = window.setTimeout(() => {
      setRecordingState('idle')
      if (!returnToDay) setConversation(0)
    }, 1200)
  }

  function discardRecording() {
    setRecordingState('idle')
    setRecordingPaused(false)
    setRecordingSeconds(0)
  }

  return (
    <section
      aria-label={t('Interactieve productdemo', 'Interactive product demo')}
      className="remember-dashboard-preview relative flex h-[650px] w-full overflow-hidden bg-slate-50 font-normal text-slate-900"
    >
      <PreviewSidebar
        view={view}
        activeWikiSpace={activeWikiSpace}
        researchSpaceCreated={researchSpaceCreated}
        onNavigate={navigate}
        onWikiSpace={(space) => {
          setActiveWikiSpace(space)
          navigate('wiki')
        }}
        onNewSpace={() => {
          setResearchSpaceCreated(true)
          setActiveWikiSpace('research')
          navigate('wiki')
        }}
        onSearch={() => setSearchOpen(true)}
      />
      <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-slate-50 p-2 pl-0">
        <div className="flex h-full w-full flex-col overflow-hidden rounded-xl bg-white shadow-shell outline outline-1 -outline-offset-1 outline-black/[0.06]">
          <div className="custom-scrollbar custom-scrollbar-auto flex min-h-0 flex-1 flex-col overflow-y-auto">
            {view === 'inbox' ? (
              <InboxPreviewView
                onOpenSource={(kind) => {
                  if (kind === 'meeting') {
                    setConversation(0)
                    setView('conversations')
                  } else {
                    setDayTab('timeline')
                    setView('today')
                  }
                }}
              />
            ) : null}
            {view === 'today' ? (
              <TodayView
                tab={dayTab}
                processingConversation={recordingState === 'processing'}
                onTab={setDayTab}
                onConversation={(index) => {
                  setConversation(index)
                  setView('conversations')
                }}
              />
            ) : null}
            {view === 'conversations' ? (
              <ConversationsView
                selected={conversation}
                processing={recordingState === 'processing'}
                recording={recordingState === 'recording'}
                onSelect={setConversation}
                onStartRecording={startRecording}
              />
            ) : null}
            {view === 'wiki' ? <WikiView key={activeWikiSpace} space={activeWikiSpace} /> : null}
            {view === 'assistant' ? <AssistantPreviewView /> : null}
            {view === 'agent' ? <AgentView /> : null}
            {view === 'exclusions' ? <ExclusionsView /> : null}
            {view === 'settings' ? <SettingsView /> : null}
          </div>
        </div>
      </div>
      {searchOpen ? <PreviewSearch onClose={() => setSearchOpen(false)} onNavigate={navigate} /> : null}
      {recordingState === 'recording' ? (
        <RecordingOverlay
          paused={recordingPaused}
          seconds={recordingSeconds}
          onDiscard={discardRecording}
          onPause={() => setRecordingPaused((paused) => !paused)}
          onStop={stopRecording}
        />
      ) : null}
    </section>
  )
}

function PreviewSidebar({
  view,
  activeWikiSpace,
  researchSpaceCreated,
  onNavigate,
  onWikiSpace,
  onNewSpace,
  onSearch,
}: {
  view: View
  activeWikiSpace: PreviewWikiSpace
  researchSpaceCreated: boolean
  onNavigate: (view: View) => void
  onWikiSpace: (space: PreviewWikiSpace) => void
  onNewSpace: () => void
  onSearch: () => void
}) {
  const { t } = usePreviewText()
  return (
    <aside className="preview-sidebar relative flex h-full w-[220px] shrink-0 flex-col px-2 pb-3 pt-[38px]">
      <div className="absolute left-4 top-0 flex h-9 items-center gap-2.5">
        <div className="flex items-center gap-2" aria-hidden="true">
          <span className="size-3 rounded-full bg-[#ff5f57]" />
          <span className="size-3 rounded-full bg-[#febc2e]" />
          <span className="size-3 rounded-full bg-[#28c840]" />
        </div>
        <fieldset className="flex h-9 items-center gap-0.5">
          <legend className="sr-only">{t('Paginanavigatie', 'Page navigation')}</legend>
          <CompactButton label={t('Ga terug', 'Go back')} onClick={() => undefined} disabled size="compact">
            <IconChevronLeft className="size-3.5 text-slate-500" />
          </CompactButton>
          <CompactButton label={t('Ga vooruit', 'Go forward')} onClick={() => undefined} disabled size="compact">
            <IconChevronRight className="size-3.5 text-slate-500" />
          </CompactButton>
        </fieldset>
      </div>
      <div className="flex h-9 w-full items-center justify-between gap-2 pl-2.5">
        <Image src="/wordmark.svg" width={5108} height={710} alt="Remember" loading="eager" className="h-3 w-auto" />
        <CompactButton label={t('Zoek', 'Search')} onClick={onSearch}>
          <IconMagnifyingGlass2 className="size-4" />
        </CompactButton>
      </div>
      <nav aria-label={t('Navigatie', 'Navigation')} className="mt-1 flex w-full flex-1 flex-col gap-[1.5px]">
        {primaryNavigation.map((item) => (
          <PreviewNav key={item.id} {...item} active={view === item.id} onClick={() => onNavigate(item.id)} />
        ))}
        <PreviewSidebarGroup
          label={t('Spaces')}
          actionLabel={t('Nieuwe wiki maken', 'Create new wiki')}
          onAction={onNewSpace}
        >
          <PreviewSpaceNav
            space="personal"
            label={t('Persoonlijk', 'Personal')}
            description={t('Standaard privéspace', 'Default private space')}
            active={view === 'wiki' && activeWikiSpace === 'personal'}
            onClick={() => onWikiSpace('personal')}
          />
          <PreviewSpaceNav
            space="product"
            label={t('Productontwikkeling', 'Product development')}
            description={t('Projectgeheugen', 'Project memory')}
            active={view === 'wiki' && activeWikiSpace === 'product'}
            onClick={() => onWikiSpace('product')}
          />
          {researchSpaceCreated ? (
            <PreviewSpaceNav
              space="research"
              label={t('Klantonderzoek', 'Customer research')}
              description={t('Lokale space', 'Local space')}
              active={view === 'wiki' && activeWikiSpace === 'research'}
              onClick={() => onWikiSpace('research')}
            />
          ) : null}
        </PreviewSidebarGroup>
        <PreviewSidebarGroup label={t('Instellingen')}>
          {settingsNavigation.map((item) => (
            <PreviewNav key={item.id} {...item} active={view === item.id} onClick={() => onNavigate(item.id)} />
          ))}
        </PreviewSidebarGroup>
      </nav>
    </aside>
  )
}

function PreviewSidebarGroup({
  label,
  actionLabel,
  onAction,
  children,
}: {
  label: string
  actionLabel?: string
  onAction?: () => void
  children: ReactNode
}) {
  const [open, setOpen] = useState(true)
  return (
    <div className="mt-3 flex w-full flex-col gap-1">
      <div className="group flex h-7 w-full items-center rounded-lg transition-colors duration-150 hover:bg-slate-100 motion-reduce:transition-none">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className="group flex h-full min-w-0 flex-1 items-center gap-1 rounded-lg px-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-500"
        >
          <span className="min-w-0 truncate text-[11px] font-medium text-slate-500">{label}</span>
          <IconChevronDownSmall
            className={`size-3.5 shrink-0 text-slate-500 transition-transform duration-150 ${open ? '' : '-rotate-90'}`}
          />
        </button>
        {onAction && actionLabel ? (
          <button
            type="button"
            onClick={onAction}
            aria-label={actionLabel}
            title={actionLabel}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-slate-500 outline-none transition-colors duration-150 hover:bg-slate-200/60 hover:text-slate-800 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-500"
          >
            <IconPlusSmall className="size-4" />
          </button>
        ) : null}
      </div>
      {open ? <div className="flex w-full flex-col gap-[1.5px]">{children}</div> : null}
    </div>
  )
}

function PreviewSpaceNav({
  space,
  label,
  description,
  active,
  onClick,
}: {
  space: PreviewWikiSpace
  label: string
  description: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      aria-label={`${label} · ${description}`}
      title={`${label} · ${description}`}
      className={`flex h-8 w-full shrink-0 select-none items-center gap-1.5 rounded-lg pr-3 pl-[9px] text-left outline-none transition-[background-color,color,transform] duration-150 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-500 active:scale-[0.98] ${active ? 'bg-slate-200/60 text-slate-900' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        <PreviewWikiSpaceGlyph space={space} className="size-4" />
      </span>
      <span className="min-w-0 truncate font-medium text-ui">{label}</span>
    </button>
  )
}

function PreviewWikiSpaceGlyph({ space, className }: { space: PreviewWikiSpace; className?: string }) {
  const appearance = previewWikiSpaceAppearances[space]
  return <FilledSpaceIcon icon={appearance.icon} className={`shrink-0 ${appearance.foreground} ${className ?? ''}`} />
}

function PreviewWikiSpaceBadge({ space, className }: { space: PreviewWikiSpace; className?: string }) {
  const appearance = previewWikiSpaceAppearances[space]
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-lg ${appearance.surface} ${className ?? ''}`}
      aria-hidden="true"
    >
      <PreviewWikiSpaceGlyph space={space} className="size-5" />
    </span>
  )
}

function PreviewNav({
  icon: Icon,
  label,
  active,
  onClick,
  iconOnly = false,
  compact = false,
}: {
  id: View
  icon: ComponentType<{ className?: string; mode?: 'masked' | 'raw' }>
  label: string
  active: boolean
  onClick: () => void
  iconOnly?: boolean
  compact?: boolean
}) {
  const { t } = usePreviewText()
  const translatedLabel = t(label)
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      aria-label={translatedLabel}
      title={translatedLabel}
      className={`${compact ? 'h-9 shrink-0 px-2' : iconOnly ? 'size-8 justify-center' : 'h-8 w-full px-[9px]'} flex items-center gap-1.5 rounded-lg font-medium text-ui outline-none transition-[background-color,color,transform] duration-150 hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-500 active:scale-[0.97] motion-reduce:transition-none ${active ? 'bg-slate-200/60 text-slate-900' : 'text-slate-500'}`}
    >
      <Icon className="size-4 shrink-0" />
      {iconOnly ? null : <span className="truncate">{translatedLabel}</span>}
    </button>
  )
}

function CompactButton({
  label,
  onClick,
  children,
  disabled = false,
  size = 'default',
}: {
  label: string
  onClick: () => void
  children: ReactNode
  disabled?: boolean
  size?: 'compact' | 'default'
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={`${size === 'compact' ? 'size-6 rounded-md' : 'size-8 rounded-lg'} flex shrink-0 items-center justify-center text-slate-500 outline-none transition-[background-color,color,transform] duration-150 hover:bg-slate-100 hover:text-slate-800 focus-visible:ring-2 focus-visible:ring-slate-400 active:scale-[0.94] disabled:pointer-events-none disabled:text-slate-300 motion-reduce:transition-none`}
    >
      {children}
    </button>
  )
}

function PageHeader({ children }: { children: ReactNode }) {
  return (
    <header className="flex min-h-[43px] shrink-0 items-center justify-between gap-3 border-b border-slate-200 px-3 text-sm font-medium text-slate-800">
      {children}
    </header>
  )
}

function PreviewBreadcrumbSeparator() {
  return (
    <li aria-hidden="true" className="flex shrink-0 items-center text-current">
      <IconChevronRight className="size-2.5" />
    </li>
  )
}

function PreviewDayCalendarPicker({ dayOffset, onDay }: { dayOffset: number; onDay: (offset: number) => void }) {
  const { locale, t } = usePreviewText()
  const [open, setOpen] = useState(false)
  const today = previewDate()
  const yesterday = previewDate(1)
  const selectedDate = previewDate(dayOffset)
  const monthStart = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1, 12)
  const firstGridDate = new Date(monthStart)
  firstGridDate.setDate(monthStart.getDate() - ((monthStart.getDay() + 6) % 7))
  const calendarDays = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(firstGridDate)
    date.setDate(firstGridDate.getDate() + index)
    return date
  })
  const monthLabel = new Intl.DateTimeFormat(locale === 'nl' ? 'nl-NL' : 'en-US', {
    month: 'long',
    year: 'numeric',
  }).format(selectedDate)
  const capitalizedMonthLabel = `${monthLabel.charAt(0).toLocaleUpperCase(locale)}${monthLabel.slice(1)}`
  const weekdayLabels =
    locale === 'nl' ? ['Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za', 'Zo'] : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

  return (
    <div className="relative min-w-0">
      <h1>
        <button
          type="button"
          title={t('Kies een werkdag', 'Choose a workday')}
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className="-m-1.5 max-w-[34ch] rounded-lg p-1.5 text-left font-semibold text-xl text-slate-900 leading-[1.15] tracking-[-0.015em] outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-slate-400 sm:text-2xl"
        >
          {formatPreviewDate(locale, selectedDate, 'long')}
        </button>
      </h1>
      {open ? (
        <div className="absolute top-full left-0 z-50 mt-1 w-64 rounded-xl bg-white p-2.5 shadow-raised">
          <div className="flex h-8 items-center justify-between px-1">
            <p className="font-semibold text-slate-900 text-sm">{capitalizedMonthLabel}</p>
            <div className="flex items-center gap-0.5">
              <CompactButton label={t('Vorige maand', 'Previous month')} onClick={() => undefined} disabled>
                <IconChevronLeft className="size-4" />
              </CompactButton>
              <CompactButton label={t('Volgende maand', 'Next month')} onClick={() => undefined} disabled>
                <IconChevronRight className="size-4" />
              </CompactButton>
            </div>
          </div>
          <div className="mt-1.5 grid grid-cols-7 gap-0.5" aria-hidden="true">
            {weekdayLabels.map((label) => (
              <span key={label} className="flex h-5 items-center justify-center text-slate-400 text-xs">
                {label}
              </span>
            ))}
          </div>
          <div className="mt-0.5 grid grid-cols-7 gap-0.5" role="group" aria-label={capitalizedMonthLabel}>
            {calendarDays.map((date) => {
              const inMonth = date.getMonth() === selectedDate.getMonth()
              const dateNumber = date.getDate()
              const available = samePreviewDate(date, today) || samePreviewDate(date, yesterday)
              const selected = samePreviewDate(date, selectedDate)
              return available ? (
                <button
                  type="button"
                  key={date.toISOString()}
                  aria-current={selected ? 'date' : undefined}
                  onClick={() => {
                    onDay(samePreviewDate(date, today) ? 0 : 1)
                    setOpen(false)
                  }}
                  className={`relative flex size-[30px] items-center justify-center justify-self-center rounded-full font-medium text-xs tabular-nums outline-none before:absolute before:-inset-2 focus-visible:ring-2 focus-visible:ring-slate-400 ${
                    selected ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  {dateNumber}
                </button>
              ) : (
                <span
                  key={date.toISOString()}
                  aria-hidden="true"
                  className={`flex size-[30px] items-center justify-center justify-self-center text-xs tabular-nums ${
                    inMonth ? 'text-slate-300' : 'text-slate-200'
                  }`}
                >
                  {dateNumber}
                </span>
              )
            })}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function PreviewTabs<T extends string>({
  label,
  tabs,
  active,
  onChange,
}: {
  label: string
  tabs: { id: T; label: string }[]
  active: T
  onChange: (id: T) => void
}) {
  return (
    <nav className="-mx-0.5 -mt-2 overflow-x-auto overflow-y-hidden border-b border-slate-200" aria-label={label}>
      <div className="flex w-max min-w-full gap-5" role="tablist" aria-label={label}>
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active === tab.id}
            tabIndex={active === tab.id ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => {
              const next =
                event.key === 'ArrowRight'
                  ? (index + 1) % tabs.length
                  : event.key === 'ArrowLeft'
                    ? (index + tabs.length - 1) % tabs.length
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? tabs.length - 1
                        : null
              if (next === null) return
              event.preventDefault()
              onChange(tabs[next].id)
              const buttons = event.currentTarget.parentElement?.querySelectorAll('button')
              buttons?.[next]?.focus()
            }}
            className={`relative min-h-8 shrink-0 px-0.5 font-medium text-ui outline-none after:absolute after:inset-x-0.5 after:-bottom-px after:h-[2.5px] after:rounded-full hover:text-slate-800 focus-visible:ring-2 focus-visible:ring-slate-400 ${active === tab.id ? 'text-slate-900 after:bg-blue-700' : 'text-slate-500'}`}
          >
            {tab.label}
          </button>
        ))}
      </div>
    </nav>
  )
}

function TodayView({
  tab,
  processingConversation,
  onTab,
  onConversation,
}: {
  tab: DayTab
  processingConversation: boolean
  onTab: (tab: DayTab) => void
  onConversation: (index: number) => void
}) {
  const [dayOffset, setDayOffset] = useState(0)

  return (
    <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto">
      <div className="preview-day-content mx-auto grid w-full max-w-[800px] gap-8 px-8 py-12">
        <DayContent
          tab={tab}
          dayOffset={dayOffset}
          onDay={setDayOffset}
          processingConversation={processingConversation}
          onTab={onTab}
          onConversation={onConversation}
        />
      </div>
    </div>
  )
}

function DayContent({
  tab,
  dayOffset,
  onDay,
  processingConversation,
  onTab,
  onConversation,
}: {
  tab: DayTab
  dayOffset: number
  onDay: (offset: number) => void
  processingConversation: boolean
  onTab: (tab: DayTab) => void
  onConversation: (index: number) => void
}) {
  const { t } = usePreviewText()
  const [refreshing, setRefreshing] = useState(false)
  const tabs: Array<[DayTab, string]> = [
    ['overview', t('Overzicht', 'Overview')],
    ['conversations', t('Gesprekken')],
    ['timeline', t('Tijdlijn', 'Timeline')],
  ]
  return (
    <>
      <header>
        <PreviewDayCalendarPicker dayOffset={dayOffset} onDay={onDay} />
        <div className="mt-1 flex items-center gap-1 text-xs text-slate-500 tabular-nums">
          <span>
            {refreshing ? t('Wordt bijgewerkt…', 'Updating…') : t('Bijgewerkt tot 16:32', 'Updated through 04:32 PM')}
          </span>
          {dayOffset === 0 ? (
            <CompactButton
              label={refreshing ? t('Dag wordt bijgewerkt', 'Day is updating') : t('Dag bijwerken', 'Update day')}
              size="compact"
              disabled={refreshing}
              onClick={() => {
                setRefreshing(true)
                window.setTimeout(() => setRefreshing(false), 900)
              }}
            >
              {refreshing ? (
                <IconLoadingCircle
                  aria-hidden="true"
                  className="size-3 shrink-0 animate-spin text-slate-500 motion-reduce:animate-none [&_path]:[stroke-width:2.5]"
                />
              ) : (
                <IconArrowRotateClockwise className="size-3" />
              )}
            </CompactButton>
          ) : null}
        </div>
      </header>
      <PreviewTabs
        label={t('Onderdelen van de dag', 'Day sections')}
        tabs={tabs.map(([id, label]) => ({ id, label }))}
        active={tab}
        onChange={onTab}
      />
      {tab === 'overview' ? <Overview /> : null}
      {tab === 'conversations' ? (
        <DayConversations processing={processingConversation} onSelect={onConversation} />
      ) : null}
      {tab === 'timeline' ? <Timeline /> : null}
    </>
  )
}

function Overview() {
  const { locale, t } = usePreviewText()
  const projects = [
    ['Onboarding refresh', '2u 18m', '57.5%', 'bg-[oklch(var(--categorical-purple))]'],
    ['Releasevoorbereiding', '1u 30m', '37.5%', 'bg-[oklch(var(--categorical-teal))]'],
    ['Support en planning', '6m', '4%', 'bg-[oklch(var(--categorical-green))]'],
    ['Klantonderzoek', '6m', '4%', 'bg-[oklch(var(--categorical-yellow))]'],
  ]
  return (
    <div className="grid gap-6 pb-4">
      <section>
        <h3 className="text-lg font-semibold text-slate-950">{t('Overzicht', 'Overview')}</h3>
        <p className="mt-4 text-ui leading-6 text-slate-800">
          {t(
            'De onboardingrefresh is inhoudelijk afgerond en blijft op koers voor donderdag. In de productsync is besloten de begeleide lege staat nu uit te rollen en uitgebreidere analytics pas na de eerste week te beoordelen. De terugknop blijft zichtbaar tijdens de toestemmingsstap en de succesboodschap verwijst naar het eerste dagoverzicht. Elena doet morgenochtend de laatste review. Sam werkt de rolloutnotitie bij met activatie en voltooiing als eerste meetpunten. De definitieve flow en de gedeelde uitleg voor support moeten nog worden gedeeld.',
            'The onboarding refresh reached a useful milestone: the team reviewed the final flow and kept the release on track for Thursday. In the product sync, you agreed to ship the guided empty state now and evaluate deeper analytics after the first week. The back button stays visible during the permission step, and the success message points to the first daily overview. Elena will review the final flow tomorrow morning. Sam is updating the rollout note with activation and completion as the first metrics. The final flow and shared support copy still need to be sent.'
          )}
        </p>
      </section>
      <section className="border-t border-black/[0.08] pt-6">
        <h3 className="text-lg font-semibold text-slate-950">{t('Aandacht', 'Attention')}</h3>
        <div className="mt-6 grid gap-5">
          {projects.map(([name, duration, width, color]) => (
            <div key={name}>
              <div className="mb-2 flex justify-between gap-4 text-ui">
                <span className="font-medium text-slate-800">{t(name)}</span>
                <span className="text-xs text-slate-600 tabular-nums">
                  {locale === 'nl' ? duration : duration.replace('u ', 'h ')}
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-slate-100">
                <div className={`h-full rounded-full ${color}`} style={{ width }} />
              </div>
            </div>
          ))}
        </div>
        <section className="mt-8 border-t border-black/[0.08] pt-6" aria-labelledby="preview-results-heading">
          <h3 id="preview-results-heading" className="text-lg font-semibold text-slate-950">
            {t('Resultaten', 'Outcomes')}
          </h3>
          <ul className="mt-5 grid gap-2.5">
            {[
              t('Onboardingflow klaar voor laatste review', 'Onboarding flow ready for final review'),
              t('Gefaseerde uitrol en meetpunten afgestemd', 'Phased rollout and metrics aligned'),
              t('Gedeelde supportcopy vastgelegd', 'Shared support copy documented'),
            ].map((result) => (
              <li key={result} className="grid grid-cols-[8px_minmax(0,1fr)] gap-3 text-ui leading-5 text-slate-700">
                <span className="mt-2 size-1.5 rounded-full bg-slate-300" aria-hidden="true" />
                <span>{result}</span>
              </li>
            ))}
          </ul>
        </section>
      </section>
    </div>
  )
}

function DayConversations({ processing, onSelect }: { processing: boolean; onSelect: (index: number) => void }) {
  if (processing) return <ConversationProcessingState />
  return (
    <section className="grid gap-4" aria-labelledby="preview-day-conversations">
      <PreviewConversationList onSelect={onSelect} />
    </section>
  )
}

function PreviewConversationList({ onSelect }: { onSelect: (index: number) => void }) {
  const { locale, t } = usePreviewText()
  return (
    <section aria-labelledby="preview-conversations-date" className="grid gap-2">
      <h3 id="preview-conversations-date" className="px-1 text-sm font-semibold text-slate-500">
        {formatPreviewDate(locale, previewDate(), 'short')}
      </h3>
      <ol className="divide-y divide-slate-100 overflow-hidden rounded-xl bg-white shadow-raised">
        {conversations.map((item, index) => (
          <li key={item.title}>
            <button
              type="button"
              onClick={() => onSelect(index)}
              className="group grid w-full min-w-0 grid-cols-[96px_minmax(0,1fr)_auto] items-center gap-3 p-3 text-left outline-none transition-colors duration-150 ease-out hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-400 active:bg-slate-100"
            >
              <span className="self-start whitespace-nowrap pt-0.5 text-xs font-medium text-slate-500 tabular-nums">
                {item.time.replace('–', ' → ')}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate font-medium text-ui leading-5 text-slate-900">{t(item.title)}</span>
                <span className="line-clamp-2 text-pretty text-xs leading-[18px] text-slate-500">
                  {t(item.description)}
                </span>
              </span>
              <IconChevronRight className="size-3.5 shrink-0 text-slate-300 transition-colors duration-150 group-hover:text-slate-500 group-focus-visible:text-slate-500" />
            </button>
          </li>
        ))}
      </ol>
    </section>
  )
}

function ConversationProcessingState() {
  const { t } = usePreviewText()
  return (
    <article aria-live="polite" className="grid gap-5 pb-5">
      <header>
        <div className="h-7 w-52 animate-pulse rounded-md bg-slate-100 motion-reduce:animate-none" />
        <p className="mt-2 flex items-center gap-2 text-sm font-medium text-slate-500">
          <IconLoadingCircle
            aria-hidden="true"
            className="size-3.5 animate-spin motion-reduce:animate-none [&_path]:[stroke-width:2.5]"
          />
          {t('Gesprek wordt verwerkt…', 'Processing conversation…')}
        </p>
      </header>
      <section className="border-t border-black/[0.08] pt-4">
        <h3 className="text-ui font-medium text-slate-400">{t('Samenvatting', 'Summary')}</h3>
        <div className="mt-3 grid gap-2" aria-hidden="true">
          <span className="h-3 w-full animate-pulse rounded bg-slate-100 motion-reduce:animate-none" />
          <span className="h-3 w-4/5 animate-pulse rounded bg-slate-100 motion-reduce:animate-none" />
        </div>
      </section>
      <section className="border-t border-black/[0.08] pt-4">
        <h3 className="text-ui font-medium text-slate-400">{t('Actiepunten', 'Action items')}</h3>
        <div className="mt-3 h-8 w-2/3 animate-pulse rounded-md bg-slate-100 motion-reduce:animate-none" />
      </section>
    </article>
  )
}

function RecordingOverlay({
  paused,
  seconds,
  onDiscard,
  onPause,
  onStop,
}: {
  paused: boolean
  seconds: number
  onDiscard: () => void
  onPause: () => void
  onStop: () => void
}) {
  const { t } = usePreviewText()
  const minutes = Math.floor(seconds / 60)
  const time = `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  return (
    <div
      role="region"
      aria-label={t('Opnamebediening', 'Recording controls')}
      className="absolute bottom-5 left-1/2 z-30 flex h-12 -translate-x-1/2 items-center rounded-full bg-slate-950 px-2 text-white shadow-[0_16px_40px_-16px_rgba(15,23,42,0.75)]"
    >
      <span className="flex h-8 items-center gap-0.5 px-2" aria-hidden="true">
        {[10, 18, 13, 22, 15].map((height) => (
          <span key={height} className="w-0.5 rounded-full bg-rose-500" style={{ height }} />
        ))}
      </span>
      <time className="w-12 text-center text-xs text-slate-200 tabular-nums">{time}</time>
      <button
        type="button"
        onClick={onPause}
        aria-label={paused ? t('Hervat opname', 'Resume recording') : t('Pauzeer opname', 'Pause recording')}
        className="flex size-8 items-center justify-center rounded-full text-slate-200 outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/70"
      >
        {paused ? <IconPlay className="size-3.5" /> : <IconPause className="size-3.5" />}
      </button>
      <button
        type="button"
        onClick={onStop}
        aria-label={t('Stop opname', 'Stop recording')}
        className="flex size-8 items-center justify-center rounded-full outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/70"
      >
        <span className="size-3 rounded-[2px] border-2 border-slate-200" aria-hidden="true" />
      </button>
      <span className="mx-1 h-7 w-px bg-white/10" aria-hidden="true" />
      <button
        type="button"
        onClick={onDiscard}
        aria-label={t('Verwijder opname', 'Discard recording')}
        className="flex size-8 items-center justify-center rounded-full text-lg leading-none text-slate-300 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/70"
      >
        ×
      </button>
    </div>
  )
}

function ConversationsView({
  selected,
  processing,
  recording,
  onSelect,
  onStartRecording,
}: {
  selected: number | null
  processing: boolean
  recording: boolean
  onSelect: (index: number | null) => void
  onStartRecording: () => void
}) {
  const { t } = usePreviewText()
  const [tab, setTab] = useState('all')
  const [recognized, setRecognized] = useState(true)
  const [recovered, setRecovered] = useState<(typeof conversations)[number] | null>(null)
  const [recoveredOpen, setRecoveredOpen] = useState(false)
  const [selectedFragments, setSelectedFragments] = useState<number[]>([])
  const fragments = conversations.flatMap((conversation) => conversation.transcript.slice(0, 2))
  const conversation = recoveredOpen ? recovered : selected === null ? null : conversations[selected]

  if (processing) {
    return (
      <>
        <PageHeader>
          <span>{t('Gesprekken')}</span>
        </PageHeader>
        <div className="mx-auto w-full max-w-[800px] grow px-4 py-8 sm:px-6 md:py-12 lg:px-8">
          <ConversationProcessingState />
        </div>
      </>
    )
  }

  if (conversation) {
    return (
      <>
        <header className="flex min-h-[43px] shrink-0 items-center border-b border-slate-200 px-3">
          <nav aria-label={t('Kruimelpad', 'Breadcrumb')} className="min-w-0 flex-1 overflow-hidden">
            <ol className="flex min-w-0 items-center text-slate-800 text-sm">
              <li className="shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    setRecoveredOpen(false)
                    onSelect(null)
                  }}
                  className="flex h-7 items-center rounded-md px-2 font-medium outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-slate-400"
                >
                  {t('Gesprekken')}
                </button>
              </li>
              <PreviewBreadcrumbSeparator />
              <li className="min-w-0 truncate px-2 font-medium">{t(conversation.title)}</li>
            </ol>
          </nav>
        </header>
        <div className="mx-auto w-full max-w-[800px] grow px-4 py-8 sm:px-6 md:py-12 lg:px-8">
          <ConversationDetail conversation={conversation} />
        </div>
      </>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-[800px] grow flex-col gap-6 px-4 py-8 sm:px-6 md:py-12 lg:px-8">
      <header className="flex min-h-10 items-start justify-between gap-4">
        <h1 className="text-balance text-xl sm:text-2xl font-semibold leading-[1.15] tracking-[-0.015em] text-slate-950">
          {t('Gesprekken')}
        </h1>
        <span className="flex items-center gap-2">
          <ConversationPreferencesPreview />
        </span>
      </header>
      <PreviewTabs
        label={t('Gespreksweergaven', 'Conversation views')}
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'all', label: t('Alle', 'All') },
          { id: 'recognized', label: t('Herkend', 'Recognized') },
          { id: 'audio', label: t('Audioactiviteit', 'Audio activity') },
        ]}
      />
      {tab === 'all' ? (
        <>
          {recovered ? (
            <button
              type="button"
              onClick={() => setRecoveredOpen(true)}
              className="rounded-xl bg-white p-3 text-left shadow-raised outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-slate-400"
            >
              <span className="block font-medium text-slate-900 text-ui">{recovered.title}</span>
              <span className="mt-0.5 line-clamp-2 block text-slate-500 text-xs">{recovered.description}</span>
            </button>
          ) : null}
          <PreviewConversationList onSelect={onSelect} />
        </>
      ) : null}
      {tab === 'recognized' ? (
        recognized ? (
          <div className="grid grid-cols-[96px_minmax(0,1fr)_auto] items-center gap-3 rounded-xl bg-white p-3 shadow-raised">
            <time className="text-slate-500 text-xs tabular-nums">15:00 → 15:32</time>
            <div className="min-w-0">
              <p className="font-medium text-slate-900 text-ui">{t('Designreview onboarding')}</p>
              <p className="mt-0.5 text-slate-500 text-xs">
                {t('Definitieve flow met design en customer success doorlopen.')}
              </p>
            </div>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => setRecognized(false)}
                className="h-8 rounded-lg px-2.5 font-medium text-slate-600 text-sm hover:bg-slate-100"
              >
                {t('Niet bewaren', 'Discard')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setRecognized(false)
                  setTab('all')
                  onSelect(1)
                }}
                className="h-8 rounded-lg bg-blue-700 px-2.5 font-medium text-white text-sm"
              >
                {t('Bewaren', 'Save')}
              </button>
            </div>
          </div>
        ) : (
          <p className="text-slate-500 text-ui">{t('Geen herkende gesprekken.', 'No recognized conversations.')}</p>
        )
      ) : null}
      {tab === 'audio' ? (
        <section className="overflow-hidden rounded-xl bg-white shadow-raised">
          <h2 className="flex min-h-12 items-center border-b border-slate-100 px-4 font-semibold text-slate-900 text-md">
            {t('Fragmenten', 'Fragments')}
          </h2>
          <ol className="divide-y divide-slate-100">
            {fragments.map(([source, text], index) => (
              <li key={text}>
                <div className="flex min-h-16 items-start gap-3 px-4 py-3">
                  <span className="min-w-0">
                    <span className="block font-medium text-slate-500 text-xs">{t(source)}</span>
                    <span className="mt-1 block text-slate-700 text-sm leading-5">{t(text)}</span>
                  </span>
                </div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  )
}

function ConversationDetail({ conversation }: { conversation: (typeof conversations)[number] }) {
  const { locale, t } = usePreviewText()
  const [transcriptOpen, setTranscriptOpen] = useState(false)
  return (
    <article className="pb-5">
      <header className="pb-6">
        <h2 className="text-balance text-2xl font-semibold leading-tight text-slate-950">{t(conversation.title)}</h2>
        <p className="mt-2 font-medium text-sm text-slate-500">
          {formatPreviewDate(locale, previewDate(), 'short')}, {conversation.time.replace('–', ' → ')}
        </p>
      </header>
      <section className="border-t border-black/[0.08] py-4">
        <h3 className="text-ui font-medium text-slate-500">{t('Samenvatting', 'Summary')}</h3>
        <p className="mt-2  text-ui leading-6 text-slate-700">{t(conversation.summary)}</p>
      </section>
      <section className="border-t border-black/[0.08] py-4">
        <h3 className="text-ui font-medium text-slate-500">{t('Actiepunten', 'Action items')}</h3>
        <ul className="mt-3 grid gap-2.5">
          {conversation.actions.map((action) => (
            <li key={action} className="grid grid-cols-[8px_minmax(0,1fr)] gap-3 text-ui leading-5 text-slate-700">
              <span className="mt-2 size-1.5 rounded-full bg-slate-300" aria-hidden="true" />
              <span>{t(action)}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="border-y border-black/[0.08]">
        <button
          type="button"
          aria-expanded={transcriptOpen}
          onClick={() => setTranscriptOpen((open) => !open)}
          className="flex min-h-14 w-full items-center justify-between text-ui font-medium text-slate-500 outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
        >
          Transcript
          <IconChevronDownSmall
            className={`size-4 transition-transform duration-150 ${transcriptOpen ? 'rotate-180' : ''}`}
          />
        </button>
        {transcriptOpen ? (
          <ol className="grid gap-5 pb-6">
            {conversation.transcript.map(([source, text]) => (
              <li key={text}>
                <p className="text-sm font-medium text-slate-500">{t(source)}</p>
                <p className="mt-1 text-ui leading-6 text-slate-700">{t(text)}</p>
              </li>
            ))}
          </ol>
        ) : null}
      </section>
    </article>
  )
}

function Timeline() {
  const { t } = usePreviewText()
  const [openMenu, setOpenMenu] = useState<number | null>(null)
  const [hidden, setHidden] = useState<number[]>([])
  return (
    <div>
      <ol>
        {timeline.map(([time, title, description, apps], index) =>
          hidden.includes(index) ? null : apps.length === 0 ? (
            <li key={title} className="grid min-h-10 grid-cols-[max-content_18px_minmax(0,1fr)] gap-x-3">
              <time className="self-center text-slate-400 text-xs tabular-nums">{time}</time>
              <span className="mx-auto border-l border-dashed border-black/10" />
              <span className="flex items-center pl-3 text-slate-400 text-xs">{t('Pauze', 'Break')} · 47m</span>
            </li>
          ) : (
            <li key={title} className="grid grid-cols-[max-content_18px_minmax(0,1fr)] gap-x-3 pb-5">
              <time className="whitespace-nowrap pt-[5px] text-xs font-medium text-slate-500 tabular-nums">{time}</time>
              <span className="relative flex justify-center" aria-hidden="true">
                <span className="absolute top-2 bottom-[-16px] w-px bg-black/[0.09]" />
                <span className="absolute top-1.5 size-2 rounded-full bg-blue-700 ring-4 ring-white" />
              </span>
              <article className="group rounded-lg bg-slate-50 px-3.5 py-3">
                <div className="flex justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-1">
                    <h3 className="min-w-0 font-medium text-ui text-slate-900">{t(title)}</h3>
                    <div className="relative shrink-0">
                      <CompactButton
                        size="compact"
                        label={t(`Meer opties voor ${title}`, `More options for ${t(title)}`)}
                        onClick={() => setOpenMenu((current) => (current === index ? null : index))}
                      >
                        <IconDotGrid1x3HorizontalTight className="size-3" />
                      </CompactButton>
                      {openMenu === index ? (
                        <div className="absolute top-7 left-0 z-30 w-48 rounded-xl bg-white p-1 shadow-raised">
                          <button
                            type="button"
                            onClick={() => {
                              setHidden((current) => [...current, index])
                              setOpenMenu(null)
                            }}
                            className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left font-medium text-danger-700 text-sm outline-none hover:bg-danger-100"
                          >
                            <IconEyeSlash className="size-3.5" />
                            {t('Verberg uit tijdlijn', 'Hide from timeline')}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                  <span className="flex shrink-0 items-center pl-1.5">
                    {apps.map((app, appIndex) => (
                      <AppIcon
                        key={app}
                        name={app}
                        size="small"
                        overlap={appIndex > 0}
                        stackIndex={apps.length - appIndex}
                      />
                    ))}
                  </span>
                </div>
                <p className="mt-1 text-ui leading-5 text-slate-500">{t(description)}</p>
                <details className="mt-2 text-slate-500 text-xs">
                  <summary className="w-fit cursor-pointer rounded-md px-1 py-1 hover:bg-slate-100">
                    {t('Details', 'Details')}
                  </summary>
                  <p className="mt-1 border-l border-black/[0.07] pl-3 leading-5">
                    <time className="mr-3 tabular-nums">{time.split('–')[0]}</time>
                    {t(description)}
                  </p>
                </details>
              </article>
            </li>
          )
        )}
      </ol>
      {hidden.length ? (
        <button
          type="button"
          onClick={() => setHidden([])}
          className="mt-1 rounded-md px-3 py-1 text-slate-400 text-xs hover:bg-slate-50 hover:text-slate-700"
        >
          {t(`Toon ${hidden.length} verborgen activiteiten`, `Show ${hidden.length} hidden activities`)}
        </button>
      ) : null}
    </div>
  )
}

const appIconPresentations: Record<string, { path: string; surface: string; logo: string; framed?: boolean }> = {
  Cursor: {
    path: '/app-icons/cursor.png',
    surface: 'bg-transparent',
    logo: 'size-full scale-[1.24]',
  },
  Calendar: { path: '/app-icons/google-calendar.svg', surface: 'bg-white', logo: 'size-[78%]' },
  Chrome: { path: '/app-icons/chrome.svg', surface: 'bg-white', logo: 'size-[68%]' },
  Claude: {
    path: '/app-icons/claude.svg',
    surface: 'bg-gradient-to-br from-[#e58b6d] to-[#cf684a]',
    logo: 'size-[70%] brightness-0 invert',
    framed: false,
  },
  Figma: { path: '/app-icons/figma.svg', surface: 'bg-[#181818]', logo: 'size-[62%]' },
  Notion: { path: '/app-icons/notion.svg', surface: 'bg-[#fafafa]', logo: 'size-[68%]' },
  Slack: { path: '/app-icons/slack.svg', surface: 'bg-white', logo: 'size-[62%]' },
  Teams: { path: '/app-icons/teams.svg', surface: 'bg-[#eef0ff]', logo: 'size-[76%]' },
}

function AppIcon({
  name,
  size = 'regular',
  overlap = false,
  stackIndex,
}: {
  name: string
  size?: 'small' | 'regular'
  overlap?: boolean
  stackIndex?: number
}) {
  const presentation = appIconPresentations[name]
  const framed = presentation?.framed !== false
  return (
    <span
      title={name}
      aria-label={name}
      style={stackIndex ? { zIndex: stackIndex } : undefined}
      className={`relative flex shrink-0 items-center justify-center overflow-hidden ${framed ? 'ring-1 ring-inset ring-black/[0.09]' : ''} ${size === 'small' ? 'size-5 rounded-[6px] shadow-[0_1px_2px_rgba(15,23,42,0.12)]' : 'size-8 justify-self-center rounded-[9px] shadow-[0_1px_2px_rgba(15,23,42,0.14),0_4px_10px_-6px_rgba(15,23,42,0.45)]'} ${overlap ? '-ml-2' : ''} ${presentation?.surface ?? 'bg-slate-100 text-slate-500'}`}
    >
      {presentation ? (
        <Image
          src={presentation.path}
          width={32}
          height={32}
          alt=""
          className={`${presentation.logo} object-contain`}
        />
      ) : (
        <IconWindowApp className={size === 'small' ? 'size-3 text-slate-500' : 'size-4 text-slate-500'} />
      )}
    </span>
  )
}

function WikiView({ space }: { space: PreviewWikiSpace }) {
  const { t } = usePreviewText()
  const spaceLabel =
    space === 'personal'
      ? t('Persoonlijk', 'Personal')
      : space === 'product'
        ? t('Productontwikkeling', 'Product development')
        : t('Klantonderzoek', 'Customer research')
  const [pages, setPages] = useState(() => (space === 'research' ? customerResearchWikiPages : wikiPages))
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null)
  const [selectedCategorySlug, setSelectedCategorySlug] = useState<string | null>(null)
  const page = pages.find((item) => item.slug === selectedSlug) ?? null
  const category = wikiCategories.find((item) => item.slug === selectedCategorySlug) ?? null

  function openHome() {
    setSuggestionsOpen(false)
    setSelectedSlug(null)
    setSelectedCategorySlug(null)
  }

  function openCategory(slug: string) {
    setSelectedSlug(null)
    setSelectedCategorySlug(slug)
  }

  function openPage(slug: string) {
    setSelectedSlug(slug)
    setSelectedCategorySlug(slug.split('/')[0] ?? null)
  }

  function createPage() {
    if (!category) return
    const slug = `${category.slug}/naamloze-pagina-${pages.length + 1}`
    setPages((current) => [
      ...current,
      { slug, title: '', excerpt: '', updated: t('6 aug', 'Aug 6'), content: '', sourceCount: 0 },
    ])
    setSelectedSlug(slug)
  }

  function updatePage(nextPage: PreviewWikiPage) {
    setPages((current) => current.map((item) => (item.slug === nextPage.slug ? nextPage : item)))
  }

  function deletePage() {
    if (
      !page ||
      !window.confirm(
        t(
          `“${page.title || 'Naamloze pagina'}” verwijderen? Dit kan niet ongedaan worden gemaakt.`,
          `Delete “${page.title || 'Untitled page'}”? This cannot be undone.`
        )
      )
    ) {
      return
    }
    setPages((current) => current.filter((item) => item.slug !== page.slug))
    openHome()
  }

  return (
    <>
      <WikiBreadcrumb
        space={space}
        spaceLabel={spaceLabel}
        category={category ?? (page ? wikiCategoryForSlug(page.slug) : null)}
        page={page}
        onHome={openHome}
        onCategory={openCategory}
        onCreatePage={category && !page ? createPage : undefined}
        onDelete={deletePage}
      />
      <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto">
        {suggestionsOpen ? (
          <div className="mx-auto w-full max-w-[800px] px-10 py-12">
            <h1 className="text-2xl font-semibold text-slate-950">{t('Suggesties', 'Suggestions')}</h1>
            <p className="mt-6 text-slate-500 text-ui">
              {t('Geen suggesties voor deze space.', 'No suggestions for this space.')}
            </p>
          </div>
        ) : page ? (
          <WikiEditor page={page} onChange={updatePage} />
        ) : category ? (
          <WikiCategoryPage
            category={category}
            pages={pages.filter((item) => item.slug.startsWith(`${category.slug}/`))}
            onOpen={openPage}
          />
        ) : (
          <WikiHome
            onSuggestions={() => setSuggestionsOpen(true)}
            space={space}
            spaceLabel={spaceLabel}
            pages={pages}
            onCategory={openCategory}
            onOpen={openPage}
          />
        )}
      </div>
    </>
  )
}

function wikiCategoryForSlug(slug: string) {
  return wikiCategories.find((category) => category.slug === slug.split('/')[0]) ?? null
}

function WikiBreadcrumb({
  space,
  spaceLabel,
  category,
  page,
  onHome,
  onCategory,
  onCreatePage,
  onDelete,
}: {
  space: PreviewWikiSpace
  spaceLabel: string
  category: (typeof wikiCategories)[number] | null
  page: PreviewWikiPage | null
  onHome: () => void
  onCategory: (slug: string) => void
  onCreatePage?: () => void
  onDelete: () => void
}) {
  const { t } = usePreviewText()
  const [actionsOpen, setActionsOpen] = useState(false)

  function runAction(action: () => void) {
    setActionsOpen(false)
    action()
  }

  return (
    <PageHeader>
      <div className="flex w-full min-w-0 items-center justify-between gap-3">
        <nav aria-label={t('Wiki-kruimelpad', 'Wiki breadcrumb')} className="min-w-0">
          <ol className="flex min-w-0 items-center gap-0.5 text-slate-800 text-sm">
            <li className="shrink-0">
              {category || page ? (
                <button
                  type="button"
                  onClick={onHome}
                  className="flex h-7 max-w-52 items-center gap-1.5 rounded-md px-1.5 font-medium text-slate-800 outline-none transition-[background-color,transform] duration-150 hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-slate-400 active:scale-[0.97]"
                >
                  <PreviewWikiSpaceGlyph space={space} className="size-3.5" />
                  <span className="truncate">{spaceLabel}</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onHome}
                  aria-current="page"
                  className="flex h-7 max-w-52 items-center gap-1.5 rounded-md px-1.5 font-medium text-slate-800 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-slate-400"
                >
                  <PreviewWikiSpaceGlyph space={space} className="size-3.5" />
                  <span className="truncate">{spaceLabel}</span>
                </button>
              )}
            </li>
            {category ? (
              <>
                <PreviewBreadcrumbSeparator />
                <li className="min-w-0">
                  {page ? (
                    <button
                      type="button"
                      onClick={() => onCategory(category.slug)}
                      className="flex h-7 max-w-40 items-center truncate rounded-md px-1.5 font-medium text-slate-800 outline-none transition-[background-color,color,transform] duration-150 hover:bg-slate-100 hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-slate-400 active:scale-[0.97]"
                    >
                      {t(category.label)}
                    </button>
                  ) : (
                    <span className="flex h-7 items-center truncate px-1.5 font-medium text-slate-800">
                      {t(category.label)}
                    </span>
                  )}
                </li>
              </>
            ) : null}
            {page ? (
              <>
                <PreviewBreadcrumbSeparator />
                <li className="min-w-0">
                  <span className="flex h-7 max-w-[32rem] items-center truncate px-1.5 font-medium text-slate-800">
                    {page.title || t('Naamloze pagina', 'Untitled page')}
                  </span>
                </li>
              </>
            ) : null}
          </ol>
        </nav>
        {page || onCreatePage ? (
          <div className="relative">
            <CompactButton
              label={t(
                `Meer opties voor ${page?.title || category?.label || spaceLabel}`,
                `More options for ${page?.title || (category ? t(category.label) : spaceLabel)}`
              )}
              onClick={() => setActionsOpen((open) => !open)}
            >
              <IconDotGrid1x3HorizontalTight className="size-3.5" />
            </CompactButton>
            {actionsOpen ? (
              <div className="absolute top-full right-0 z-50 mt-1 w-44 rounded-xl bg-white p-1 shadow-raised">
                {onCreatePage ? (
                  <button
                    type="button"
                    onClick={() => runAction(onCreatePage)}
                    className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left font-medium text-sm text-slate-700 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-slate-400"
                  >
                    <IconPlusSmall className="size-3.5" />
                    {t('Nieuwe pagina', 'New page')}
                  </button>
                ) : null}
                {page ? (
                  <button
                    type="button"
                    onClick={() => runAction(onDelete)}
                    className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left font-medium text-danger-700 text-sm outline-none hover:bg-danger-100 focus-visible:ring-2 focus-visible:ring-danger-200"
                  >
                    <IconTrashCanSimple className="size-3.5" />
                    {t('Pagina verwijderen', 'Delete page')}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </PageHeader>
  )
}

function WikiHome({
  space,
  spaceLabel,
  pages,
  onCategory,
  onOpen,
  onSuggestions,
}: {
  onSuggestions: () => void
  space: PreviewWikiSpace
  spaceLabel: string
  pages: PreviewWikiPage[]
  onCategory: (slug: string) => void
  onOpen: (slug: string) => void
}) {
  const { t } = usePreviewText()
  return (
    <main className="mx-auto w-full max-w-[800px] px-10 py-12">
      <div className="grid gap-6">
        <header className="flex min-w-0 items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <PreviewWikiSpaceBadge space={space} className="size-9" />
            <h2 className="min-w-0 truncate text-2xl font-semibold tracking-[-0.025em] text-slate-950">{spaceLabel}</h2>
          </div>
          <button
            type="button"
            onClick={onSuggestions}
            className="relative flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 font-medium text-slate-600 text-sm outline-none transition-[background-color,color,transform] duration-150 ease-out before:absolute before:-inset-y-1 before:inset-x-0 before:content-[''] hover:bg-slate-100 hover:text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 active:scale-[0.97] motion-reduce:transition-none"
          >
            <span className="relative">{t('Suggesties', 'Suggestions')}</span>
            <IconArrowRight className="size-3.5" aria-hidden="true" />
          </button>
        </header>
        <section className="grid gap-3">
          <h3 className="text-md font-semibold text-slate-900">{t('Categorieën', 'Categories')}</h3>
          <div className="grid grid-cols-2 gap-2">
            {wikiCategories.map((category) => (
              <button
                type="button"
                key={category.slug}
                onClick={() => onCategory(category.slug)}
                className="group min-w-0 rounded-lg border border-black/[0.07] bg-white p-3 text-left outline-none hover:border-black/[0.1] hover:bg-slate-50/70 focus-visible:ring-2 focus-visible:ring-slate-400"
              >
                <span className="flex items-center justify-between gap-3">
                  <span className="font-medium text-ui text-slate-900">{t(category.label)}</span>
                  <span className="text-xs text-slate-400 tabular-nums">
                    {pages.filter((page) => page.slug.startsWith(`${category.slug}/`)).length}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </section>
        <WikiPageList
          title={t('Recent', 'Recent')}
          pages={pages.slice(0, 6)}
          onOpen={onOpen}
          empty={t(
            'Nieuwe wiki-pagina’s verschijnen hier zodra er kennis is vastgelegd.',
            'New wiki pages appear here as soon as knowledge is captured.'
          )}
        />
      </div>
    </main>
  )
}

function WikiCategoryPage({
  category,
  pages,
  onOpen,
}: {
  category: (typeof wikiCategories)[number]
  pages: PreviewWikiPage[]
  onOpen: (slug: string) => void
}) {
  const { t } = usePreviewText()
  return (
    <div className="mx-auto grid w-full max-w-[800px] gap-6 px-10 py-12">
      <h2 className="min-w-0 text-2xl font-semibold leading-[1.15] tracking-[-0.025em] text-slate-950">
        {t(category.label)}
      </h2>
      <WikiPageList
        title={t(category.label)}
        titleHidden
        pages={pages}
        onOpen={onOpen}
        empty={t(
          `Er staan nog geen pagina’s in ${category.label.toLowerCase()}.`,
          `There are no pages in ${t(category.label).toLowerCase()} yet.`
        )}
      />
    </div>
  )
}

function WikiPageList({
  title,
  titleHidden = false,
  pages,
  onOpen,
  empty,
}: {
  title: string
  titleHidden?: boolean
  pages: PreviewWikiPage[]
  onOpen: (slug: string) => void
  empty: string
}) {
  const { t } = usePreviewText()
  return (
    <section className="grid gap-3">
      <h3 className={titleHidden ? 'sr-only' : 'font-semibold text-slate-900'}>{title}</h3>
      {pages.length ? (
        <ul className="grid gap-0.5">
          {pages.map((page) => (
            <li key={page.slug}>
              <button
                type="button"
                onClick={() => onOpen(page.slug)}
                className="-mx-3 flex min-h-10 w-[calc(100%+1.5rem)] min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-left font-medium text-ui text-slate-900 outline-none hover:bg-slate-100/80 focus-visible:ring-2 focus-visible:ring-slate-400"
              >
                <IconFileText className="size-4 shrink-0 text-slate-400" aria-hidden="true" />
                <span className="truncate">{t(page.title) || t('Naamloze pagina', 'Untitled page')}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-slate-500">{empty}</p>
      )}
    </section>
  )
}

function WikiEditor({ page, onChange }: { page: PreviewWikiPage; onChange: (page: PreviewWikiPage) => void }) {
  const { t } = usePreviewText()
  return (
    <article className="mx-auto flex min-h-full w-full max-w-[800px] flex-col px-10 py-12">
      <header className="flex items-start gap-4">
        <label htmlFor="preview-wiki-title" className="sr-only">
          {t('Paginatitel', 'Page title')}
        </label>
        <textarea
          id="preview-wiki-title"
          rows={1}
          maxLength={120}
          value={t(page.title)}
          onChange={(event) => onChange({ ...page, title: event.target.value.replace(/[\r\n]/g, '') })}
          className="min-w-0 flex-1 resize-none overflow-hidden bg-transparent text-2xl font-semibold leading-[1.15] tracking-[-0.025em] text-slate-950 outline-none placeholder:text-slate-300 [field-sizing:content]"
          placeholder={t('Naamloze pagina', 'Untitled page')}
        />
      </header>
      <label htmlFor="preview-wiki-content" className="sr-only">
        {t('Pagina-inhoud', 'Page content')}
      </label>
      <textarea
        id="preview-wiki-content"
        value={t(page.content)}
        onChange={(event) => onChange({ ...page, content: event.target.value })}
        className="mt-4 min-h-[28rem] w-full flex-1 resize-none overflow-hidden bg-transparent text-ui leading-7 text-slate-700 outline-none placeholder:text-slate-300 [field-sizing:content]"
        placeholder={t('Begin met schrijven…', 'Start writing…')}
      />
    </article>
  )
}

function AgentView() {
  const { t } = usePreviewText()
  const [provider, setProvider] = useState<'ChatGPT' | 'Claude'>('ChatGPT')
  const [codexModel, setCodexModel] = useState('gpt-5.6-terra')
  const [claudeModel, setClaudeModel] = useState('sonnet')
  const [effort, setEffort] = useState('high')
  const [automaticRefresh, setAutomaticRefresh] = useState(true)
  const [selectedTrace, setSelectedTrace] = useState<number | null>(null)
  const [visibleTraceCount, setVisibleTraceCount] = useState(5)
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const [connected, setConnected] = useState(true)
  const traces = [
    [
      t('Overzicht van vandaag bijgewerkt', "Updated today's overview"),
      '16:32',
      t('31 contextitems', '31 context items'),
    ],
    [t('Wiki doorzocht', 'Searched the wiki'), '15:44', t('3 relevante pagina’s', '3 relevant pages')],
    [t('Recente dagen opgehaald', 'Retrieved recent days'), '08:41', t('7 dagen', '7 days')],
    [t('Gesprekken gelezen', 'Read conversations'), '08:38', t('2 gesprekken', '2 conversations')],
    [t('Appgebruik gecontroleerd', 'Checked app usage'), '08:37', t('8 apps', '8 apps')],
    [t('Wikipagina’s opgehaald', 'Retrieved wiki pages'), '08:35', t('14 pagina’s', '14 pages')],
    [t('Remember-archief gecontroleerd', 'Checked the Remember archive'), '08:33', t('Voltooid', 'Completed')],
    [t('Dagoverzicht gelezen', 'Read day overview'), '08:31', t('Vandaag', 'Today')],
  ]
  return (
    <div className="mx-auto flex w-full max-w-[800px] grow flex-col gap-6 px-4 py-8 sm:px-6 md:py-12 lg:px-8">
      <header className="flex min-h-10 items-start justify-between gap-4">
        <h1 className="text-balance text-xl sm:text-2xl font-semibold leading-[1.15] tracking-[-0.015em] text-slate-950">
          Agent
        </h1>
      </header>

      <section aria-labelledby="preview-analysis-agent" className="overflow-hidden rounded-xl bg-white shadow-raised">
        <div className="flex min-h-12 items-center border-b border-slate-200 px-3">
          <h2 id="preview-analysis-agent" className="text-md font-semibold text-slate-900">
            {t('Daganalyse', 'Day analysis')}
          </h2>
        </div>
        <ul className="divide-y divide-slate-100">
          <li className="grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3 py-2.5">
            <div>
              <h3 className="font-medium text-ui text-slate-900">Agent</h3>
              <p className="mt-0.5 text-pretty text-xs leading-[1.5] text-slate-500">
                {t(
                  'Koppel je ChatGPT- of Claude-account rechtstreeks.',
                  'Connect your ChatGPT or Claude account directly.'
                )}
              </p>
            </div>
            <div className="inline-flex rounded-md bg-slate-100 p-0.5">
              {(['ChatGPT', 'Claude'] as const).map((item) => (
                <button
                  type="button"
                  key={item}
                  onClick={() => setProvider(item)}
                  aria-pressed={provider === item}
                  className={`h-7 rounded-[5px] px-2.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-slate-400 ${provider === item ? 'bg-white text-slate-900 shadow-raised' : 'text-slate-500 hover:text-slate-800'}`}
                >
                  {item}
                </button>
              ))}
            </div>
          </li>
          <AgentSettingRow
            title={
              provider === 'ChatGPT' ? t('ChatGPT-account', 'ChatGPT account') : t('Claude-account', 'Claude account')
            }
            description={
              !connected
                ? t('Niet verbonden.', 'Not connected.')
                : provider === 'ChatGPT'
                  ? t('Verbonden met je ChatGPT-account.', 'Connected to your ChatGPT account.')
                  : t('Verbonden met je Claude-account.', 'Connected to your Claude account.')
            }
          >
            {connected ? (
              <div className="relative">
                <CompactButton
                  label={t(`Meer opties voor ${provider}`, `More options for ${provider}`)}
                  onClick={() => setAccountMenuOpen((current) => !current)}
                >
                  <IconDotGrid1x3HorizontalTight className="size-3.5" />
                </CompactButton>
                {accountMenuOpen ? (
                  <div className="absolute top-10 right-0 z-30 w-36 rounded-xl bg-white p-1 shadow-raised">
                    <button
                      type="button"
                      onClick={() => {
                        setConnected(false)
                        setAccountMenuOpen(false)
                      }}
                      className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left font-medium text-sm text-slate-600 outline-none hover:bg-slate-50 hover:text-slate-900"
                    >
                      {t('Verbreek', 'Disconnect')}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConnected(true)}
                className="flex h-8 items-center rounded-lg border border-slate-200 bg-white px-2.5 font-medium text-sm text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-slate-400"
              >
                {t('Verbind', 'Connect')}
              </button>
            )}
          </AgentSettingRow>
          <AgentSettingRow
            title={t('Model')}
            description={t('Het model voor daganalyses.', 'The model used for daily analyses.')}
          >
            <PreviewDropdownSelect
              ariaLabel={t('Kies het analysemodel', 'Choose the analysis model')}
              value={provider === 'ChatGPT' ? codexModel : claudeModel}
              options={(provider === 'ChatGPT' ? CODEX_ANALYSIS_MODELS : CLAUDE_ANALYSIS_MODELS).map((value) => ({
                value,
                label:
                  provider === 'ChatGPT'
                    ? value.replace('gpt-', 'GPT-').replace('-terra', ' Terra').replace('-luna', ' Luna')
                    : value.charAt(0).toUpperCase() + value.slice(1),
              }))}
              onChange={provider === 'ChatGPT' ? setCodexModel : setClaudeModel}
            />
          </AgentSettingRow>
          <AgentSettingRow
            title={t('Effort')}
            description={t('Hoe grondig de analyse wordt uitgewerkt.', 'How thoroughly the analysis is developed.')}
          >
            <PreviewDropdownSelect
              ariaLabel={t('Kies de analyse-effort', 'Choose the analysis effort')}
              value={effort}
              options={[
                { value: 'high', label: t('Hoog', 'High') },
                { value: 'medium', label: t('Gemiddeld', 'Medium') },
              ]}
              onChange={setEffort}
            />
          </AgentSettingRow>
          <li className="grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-3 py-2.5">
            <div>
              <h3 className="font-medium text-ui text-slate-900">
                {t('Automatisch bijwerken', 'Refresh automatically')}
              </h3>
              <p className="mt-0.5 text-pretty text-xs leading-[1.5] text-slate-500">
                {t(
                  `Werk je dagoverzicht elke ${DEFAULT_FREQUENT_DAY_REFRESH_INTERVAL_MINUTES} minuten bij zolang je actief bent en er nieuwe data is.`,
                  `Refresh your daily overview every ${DEFAULT_FREQUENT_DAY_REFRESH_INTERVAL_MINUTES} minutes while you are active and new data is available.`
                )}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="flex h-8 items-center gap-1 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-500">
                <span className="text-ui text-slate-800 tabular-nums">
                  {DEFAULT_FREQUENT_DAY_REFRESH_INTERVAL_MINUTES}
                </span>{' '}
                min
              </span>
              <PreviewSwitch
                label={t('Automatisch bijwerken', 'Refresh automatically')}
                value={automaticRefresh}
                onChange={setAutomaticRefresh}
              />
            </div>
          </li>
        </ul>
      </section>

      <section aria-labelledby="preview-agent-trace" className="overflow-hidden rounded-xl bg-white shadow-raised">
        <div className="flex min-h-12 items-center border-b border-slate-100 px-4">
          <h2 id="preview-agent-trace" className="text-md font-semibold text-slate-900">
            {t('Activiteit', 'Activity')}
          </h2>
        </div>
        <ol className="divide-y divide-slate-100">
          {traces.slice(0, visibleTraceCount).map(([title, time, detail], index) => (
            <li key={title} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 px-4 py-3.5">
              <span className="mt-0.5 grid size-3.5 place-items-center rounded-full bg-emerald-500 text-white">
                <IconCheckmark1Small className="size-3" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-900">{title}</p>
                <p className="truncate text-xs text-slate-500">
                  {provider} · {detail}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <time className="pt-0.5 text-xs text-slate-500 tabular-nums">
                  {t('Vandaag', 'Today')}, {time}
                </time>
                <button
                  type="button"
                  onClick={() => setSelectedTrace(index)}
                  aria-label={t('Bekijk details', 'View details')}
                  className="flex size-6 items-center justify-center rounded-md text-slate-400 outline-none hover:bg-slate-100 hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-slate-400"
                >
                  <IconDotGrid1x3HorizontalTight className="size-3" />
                </button>
              </div>
            </li>
          ))}
        </ol>
        {visibleTraceCount < traces.length ? (
          <footer className="border-t border-slate-100">
            <button
              type="button"
              onClick={() => setVisibleTraceCount((current) => current + 5)}
              className="flex h-10 w-full items-center justify-center font-medium text-sm text-slate-500 outline-none hover:bg-slate-50 hover:text-slate-800 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-400"
            >
              {t(
                `${Math.min(5, traces.length - visibleTraceCount)} meer laden`,
                `Load ${Math.min(5, traces.length - visibleTraceCount)} more`
              )}
            </button>
          </footer>
        ) : null}
      </section>

      {selectedTrace !== null ? (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-slate-950/20 p-4 backdrop-blur-[1px]"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSelectedTrace(null)
          }}
        >
          <dialog open className="m-0 w-full max-w-lg overflow-hidden rounded-xl bg-white p-0 shadow-raised">
            <header className="flex items-start justify-between gap-4 border-b border-slate-100 px-4 py-3.5">
              <div>
                <h2 className="text-md font-semibold text-slate-950">{traces[selectedTrace]?.[0]}</h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  {provider} · {t('Vandaag', 'Today')}, {traces[selectedTrace]?.[1]}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedTrace(null)}
                aria-label={t('Sluiten', 'Close')}
                className="flex size-8 items-center justify-center rounded-lg text-slate-400 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-slate-400"
              >
                ×
              </button>
            </header>
            <div className="p-4">
              <h3 className="mb-2 text-sm font-medium text-slate-800">{t('Activiteit', 'Activity')}</h3>
              <ol className="overflow-hidden rounded-lg bg-slate-50 py-1 shadow-inset">
                {[
                  t('31 contextitems geladen', 'Loaded 31 context items'),
                  t('Dagcontext geanalyseerd', 'Analyzed day context'),
                  t('Overzicht en actiepunten opgeslagen', 'Saved overview and action items'),
                ].map((line, index) => (
                  <li
                    key={line}
                    className="grid grid-cols-[64px_minmax(0,1fr)] gap-3 px-3 py-2 font-mono text-xs leading-5"
                  >
                    <span className="text-slate-400 tabular-nums">16:32:0{index + 1}</span>
                    <span className="text-slate-700">{line}</span>
                  </li>
                ))}
              </ol>
            </div>
          </dialog>
        </div>
      ) : null}
    </div>
  )
}

function AgentSettingRow({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <li className="grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3 py-2.5">
      <div className="min-w-0">
        <h3 className="font-medium text-ui text-slate-900">{title}</h3>
        <p className="mt-0.5 text-pretty text-xs leading-[1.5] text-slate-500">{description}</p>
      </div>
      <div className="flex shrink-0 justify-end">{children}</div>
    </li>
  )
}

function ExclusionsView() {
  const { t } = usePreviewText()
  const [tab, setTab] = useState<'apps' | 'websites'>('apps')
  const [excludedApps, setExcludedApps] = useState(['1Password'])
  const [excludePasswordManagers, setExcludePasswordManagers] = useState(true)
  const [website, setWebsite] = useState('')
  const [websites, setWebsites] = useState<string[]>([])
  const apps = ['1Password', 'Safari', 'Slack', 'Cursor', 'Figma']

  return (
    <div className="mx-auto flex w-full max-w-[800px] grow flex-col gap-7 px-4 py-8 sm:px-6 md:py-12 lg:px-8">
      <header className="flex min-h-10 items-start">
        <h1 className="text-balance text-xl sm:text-2xl font-semibold leading-[1.15] tracking-[-0.015em] text-slate-950">
          {t('Privacy', 'Controls')}
        </h1>
      </header>

      <section className="grid gap-4" aria-label={t('Instellingen voor uitsluitingen', 'Exclusion settings')}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex rounded-md bg-slate-100 p-0.5" role="tablist">
            {(
              [
                ['apps', t('Apps')],
                ['websites', t('Websites')],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={`h-7 rounded-[5px] px-2.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-slate-400 ${tab === id ? 'bg-white text-slate-900 shadow-raised' : 'text-slate-500 hover:text-slate-800'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {tab === 'apps' ? (
          <div className="overflow-hidden rounded-xl bg-white shadow-raised">
            <div className="px-3 pt-3 pb-1 text-xs font-semibold text-slate-500">{t('Categorieën', 'Categories')}</div>
            <button
              type="button"
              aria-pressed={excludePasswordManagers}
              onClick={() => setExcludePasswordManagers((current) => !current)}
              className="grid min-h-16 w-full grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-3 px-3 text-left outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-400"
            >
              <span className="flex size-9 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                <IconKey1 className="size-5" />
              </span>
              <span>
                <span className="block font-medium text-ui text-slate-900">
                  {t('Wachtwoordmanagers', 'Password managers')}
                </span>
                <span className="block text-xs text-slate-500">
                  {t('Sluit bekende wachtwoordapps automatisch uit.', 'Automatically exclude known password apps.')}
                </span>
              </span>
              <span
                className={`grid size-[18px] place-items-center rounded-full border ${excludePasswordManagers ? 'border-blue-700 bg-blue-700 text-white' : 'border-slate-300 text-transparent'}`}
              >
                <IconCheckmark1Small className="size-4" />
              </span>
            </button>
            <div className="border-t border-slate-100 px-3 pt-3 pb-1 text-xs font-semibold text-slate-500">
              {t('Geïnstalleerde en gebruikte apps', 'Installed and used apps')}
            </div>
            <div className="divide-y divide-slate-100 px-3">
              {apps.map((app) => {
                const checked = (app === '1Password' && excludePasswordManagers) || excludedApps.includes(app)
                return (
                  <button
                    key={app}
                    type="button"
                    aria-pressed={checked}
                    disabled={app === '1Password' && excludePasswordManagers}
                    onClick={() =>
                      setExcludedApps((current) =>
                        checked ? current.filter((item) => item !== app) : [...current, app]
                      )
                    }
                    className="grid min-h-14 w-full grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 text-left outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-400"
                  >
                    {app === '1Password' ? (
                      <span className="flex size-8 items-center justify-center rounded-lg bg-blue-100 text-blue-700">
                        <IconKey1 className="size-4" />
                      </span>
                    ) : (
                      <AppIcon name={app === 'Safari' ? 'Chrome' : app} size="small" />
                    )}
                    <span className="truncate font-medium text-ui text-slate-800">{app}</span>
                    <span
                      className={`grid size-[18px] place-items-center rounded-full border ${checked ? 'border-blue-700 bg-blue-700 text-white' : 'border-slate-300 text-transparent'}`}
                    >
                      <IconCheckmark1Small className="size-4" />
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl bg-white shadow-raised">
            <form
              className="grid gap-2 border-b border-slate-100 p-3"
              onSubmit={(event) => {
                event.preventDefault()
                const domain = website
                  .trim()
                  .toLowerCase()
                  .replace(/^https?:\/\//, '')
                  .replace(/\/$/, '')
                if (!domain || websites.includes(domain)) return
                setWebsites((current) => [...current, domain])
                setWebsite('')
              }}
            >
              <label htmlFor="preview-excluded-website" className="font-medium text-ui text-slate-900">
                {t('Website toevoegen', 'Add website')}
              </label>
              <div className="flex gap-2">
                <input
                  id="preview-excluded-website"
                  value={website}
                  onChange={(event) => setWebsite(event.target.value)}
                  placeholder="example.com"
                  className="h-10 min-w-0 grow rounded-lg border border-slate-200 px-3 text-ui outline-none focus-visible:ring-2 focus-visible:ring-slate-200"
                />
                <button
                  type="submit"
                  disabled={!website.trim()}
                  className="h-10 rounded-lg bg-slate-900 px-3 text-ui font-medium text-white disabled:bg-slate-300"
                >
                  {t('Voeg toe', 'Add')}
                </button>
              </div>
              <p className="text-xs text-slate-500">
                {t('Pagina’s op dit domein worden niet vastgelegd.', 'Pages on this domain are not captured.')}
              </p>
            </form>
            {websites.length ? (
              <div className="divide-y divide-slate-100 px-3">
                {websites.map((domain) => (
                  <div key={domain} className="flex min-h-14 items-center justify-between gap-3">
                    <span className="truncate font-medium text-ui text-slate-800">{domain}</span>
                    <button
                      type="button"
                      onClick={() => setWebsites((current) => current.filter((item) => item !== domain))}
                      aria-label={t(`Verwijder ${domain}`, `Remove ${domain}`)}
                      className="flex size-8 items-center justify-center rounded-lg text-slate-400 outline-none hover:bg-slate-100 hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-slate-400"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="px-4 py-8 text-center text-sm text-slate-500">
                {t('Je hebt nog geen websites uitgesloten.', 'You have not excluded any websites yet.')}
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  )
}

function ConversationPreferencesPreview() {
  const { t } = usePreviewText()
  const [open, setOpen] = useState(false)
  const [recordingMode, setRecordingMode] = useState<'manual' | 'always-on'>('manual')
  const [revinoteConnected, setRevinoteConnected] = useState(false)
  const [automaticRevinote, setAutomaticRevinote] = useState(false)
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (open) dialogRef.current?.showModal()
    else dialogRef.current?.close()
  }, [open])
  return (
    <>
      <CompactButton label={t('Gespreksvoorkeuren', 'Conversation preferences')} onClick={() => setOpen(true)}>
        <IconSettingsSliderHor className="size-4" />
      </CompactButton>
      <dialog
        ref={dialogRef}
        onClose={() => setOpen(false)}
        aria-label={t('Gespreksvoorkeuren', 'Conversation preferences')}
        className="m-auto w-[min(600px,calc(100%-2rem))] max-h-[80vh] rounded-xl bg-white p-0 text-slate-900 shadow-raised backdrop:bg-black/20"
      >
        <div className="absolute right-3 top-2">
          <CompactButton label={t('Sluiten', 'Close')} onClick={() => setOpen(false)}>
            ×
          </CompactButton>
        </div>
        <section
          aria-labelledby="preview-recording-settings"
          className="overflow-hidden rounded-xl bg-white shadow-raised"
        >
          <div className="flex min-h-12 items-center border-b border-slate-200 px-3">
            <h2 id="preview-recording-settings" className="text-md font-semibold text-slate-900">
              {t('Gespreksvoorkeuren', 'Conversation preferences')}
            </h2>
          </div>
          <ul className="divide-y divide-slate-100">
            <SettingsSelectRow
              title={t('Opnamemodus', 'Recording mode')}
              description={t(
                'Start handmatig of laat Remember altijd klaarstaan.',
                'Start manually or keep Remember always on.'
              )}
            >
              <PreviewDropdownSelect
                ariaLabel={t('Opnamemodus', 'Recording mode')}
                value={recordingMode}
                options={[
                  { value: 'manual', label: t('Handmatig', 'Manual') },
                  { value: 'always-on', label: t('Altijd aan', 'Always on') },
                ]}
                onChange={setRecordingMode}
              />
            </SettingsSelectRow>
            <SettingsSelectRow
              title="Revinote"
              description={t(
                'Synchroniseer mobiele meetingopnames automatisch met Remember.',
                'Automatically sync mobile meeting recordings with Remember.'
              )}
            >
              <button
                type="button"
                onClick={() => setRevinoteConnected((connected) => !connected)}
                className="h-8 rounded-lg border border-slate-200 bg-white px-2.5 text-sm font-medium text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-slate-400"
              >
                {revinoteConnected ? t('Ontkoppelen', 'Disconnect') : t('Koppel Revinote', 'Connect Revinote')}
              </button>
            </SettingsSelectRow>
            <SettingToggle
              title={t('Automatisch verwerken', 'Process automatically')}
              description={t(
                'Stuur afgeronde opnames automatisch naar Revinote.',
                'Send completed recordings to Revinote automatically.'
              )}
              disabled={!revinoteConnected}
              value={automaticRevinote}
              onChange={setAutomaticRevinote}
            />
          </ul>
        </section>
      </dialog>
    </>
  )
}

function SettingsView() {
  const { t } = usePreviewText()
  const [launch, setLaunch] = useState(true)
  const [language, setLanguage] = useState('system')
  const [theme, setTheme] = useState('system')
  const [offlineMode, setOfflineMode] = useState(false)
  const [errorReportingEnabled, setErrorReportingEnabled] = useState(true)
  const [automaticUpdates, setAutomaticUpdates] = useState(true)
  const [updateChecked, setUpdateChecked] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  return (
    <div className="mx-auto flex w-full max-w-[800px] grow flex-col gap-6 px-4 py-8 sm:px-6 md:py-12 lg:px-8">
      <header className="flex min-h-10 items-start justify-between gap-4">
        <h1 className="text-balance text-xl sm:text-2xl font-semibold leading-[1.15] tracking-[-0.015em] text-slate-950">
          {t('Instellingen')}
        </h1>
      </header>
      <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl bg-white shadow-raised">
        <SettingsSelectRow
          title={t('Taal', 'Language')}
          description={t('De interfacetaal van Remember', 'Remember interface language')}
        >
          <PreviewDropdownSelect
            ariaLabel={t('Taal', 'Language')}
            value={language}
            options={[
              { value: 'system', label: t('Systeemstandaard', 'System default') },
              { value: 'en', label: 'English' },
              { value: 'nl', label: 'Nederlands' },
            ]}
            onChange={setLanguage}
          />
        </SettingsSelectRow>
        <SettingsSelectRow
          title={t('Weergave', 'Appearance')}
          description={t(
            'Volg je systeeminstelling of kies licht of donker.',
            'Follow your system setting or choose light or dark.'
          )}
        >
          <PreviewDropdownSelect
            ariaLabel={t('Weergave', 'Appearance')}
            value={theme}
            options={[
              { value: 'system', label: t('Systeemstandaard', 'System default') },
              { value: 'light', label: t('Licht', 'Light') },
              { value: 'dark', label: t('Donker', 'Dark') },
            ]}
            onChange={setTheme}
          />
        </SettingsSelectRow>
        <SettingToggle
          title={t('Start bij inloggen', 'Launch at login')}
          description={t(
            'Begin automatisch na het inloggen op je Mac.',
            'Start automatically when you log in to your Mac.'
          )}
          value={launch}
          onChange={setLaunch}
        />
        <SettingToggle
          title={t('Offline mode', 'Offline mode')}
          description={t(
            'Alles op je Mac, waaronder opnemen en transcriberen, blijft werken; AI-verzoeken, Revinote-sync, foutmeldingen en updates stoppen.',
            'Everything on your Mac, including recording and transcription, keeps working; AI requests, Revinote sync, error reporting, and updates stop.'
          )}
          value={offlineMode}
          onChange={setOfflineMode}
        />
        <SettingToggle
          title={t('Technische foutmeldingen', 'Technical error reports')}
          description={
            offlineMode
              ? t('Gepauzeerd zolang Offline mode aanstaat.', 'Paused while Offline mode is on.')
              : t(
                  'Stuur technische foutinformatie naar Sentry, zonder opnames, transcripties of prompts.',
                  'Send technical error information to Sentry, without recordings, transcripts, or prompts.'
                )
          }
          value={errorReportingEnabled}
          disabled={offlineMode}
          onChange={setErrorReportingEnabled}
        />
        <SettingToggle
          title={t('Automatische updates', 'Automatic updates')}
          description={
            offlineMode
              ? t('Gepauzeerd zolang Offline mode aanstaat.', 'Paused while Offline mode is on.')
              : t(
                  'Controleer en download nieuwe versies automatisch.',
                  'Check for and download new versions automatically.'
                )
          }
          value={automaticUpdates}
          disabled={offlineMode}
          onChange={setAutomaticUpdates}
        />
        <SettingsSelectRow
          title={t('Updates')}
          description={
            offlineMode
              ? t('Gepauzeerd zolang Offline mode aanstaat.', 'Paused while Offline mode is on.')
              : updateChecked
                ? t('Zojuist gecontroleerd. Versie 1.0.0 is actueel.', 'Just checked. Version 1.0.0 is up to date.')
                : t('Versie 1.0.0 is actueel.', 'Version 1.0.0 is up to date.')
          }
        >
          <button
            type="button"
            onClick={() => setUpdateChecked(true)}
            disabled={offlineMode}
            className="h-8 rounded-lg border border-slate-200 bg-white px-2.5 text-sm font-medium text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-slate-400 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400"
          >
            {t('Controleer nu', 'Check now')}
          </button>
        </SettingsSelectRow>
        <SettingsSelectRow
          title={t('Lokale gegevens', 'Local data')}
          description={t(
            'Verwijder opnames, rapporten, Wiki en instellingen.',
            'Delete recordings, reports, Wiki, and settings.'
          )}
        >
          <button
            type="button"
            onClick={() => setResetOpen(true)}
            className="h-8 rounded-lg bg-danger-700 px-2.5 text-sm font-medium text-on-danger outline-none hover:brightness-90 focus-visible:ring-2 focus-visible:ring-danger-200"
          >
            {t('Wis alle gegevens', 'Erase all data')}
          </button>
        </SettingsSelectRow>
      </ul>
      {resetOpen ? (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-slate-950/20 p-4 backdrop-blur-[1px]"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setResetOpen(false)
          }}
        >
          <dialog open className="m-0 w-full max-w-sm rounded-xl bg-white p-5 shadow-raised">
            <h2 className="text-md font-semibold text-slate-950">
              {t('Wis alle lokale gegevens?', 'Erase all local data?')}
            </h2>
            <p className="mt-1.5 text-sm leading-5 text-slate-500">
              {t(
                'Dit is een veilige productdemo; er wordt niets op je Mac verwijderd.',
                'This is a safe product demo; nothing on your Mac will be deleted.'
              )}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setResetOpen(false)}
                className="h-8 rounded-lg px-2.5 text-sm font-medium text-slate-600 hover:bg-slate-100"
              >
                {t('Annuleer', 'Cancel')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setLaunch(false)
                  setLanguage('system')
                  setTheme('system')
                  setOfflineMode(false)
                  setErrorReportingEnabled(true)
                  setAutomaticUpdates(true)
                  setResetOpen(false)
                }}
                className="h-8 rounded-lg bg-danger-700 px-2.5 text-sm font-medium text-on-danger hover:brightness-90"
              >
                {t('Wis previewdata', 'Erase preview data')}
              </button>
            </div>
          </dialog>
        </div>
      ) : null}
    </div>
  )
}

function SettingsSelectRow({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <li className="grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-balance font-medium text-ui text-slate-900">{title}</p>
        <p className="mt-0.5 max-w-prose text-pretty text-xs leading-[1.5] text-slate-500">{description}</p>
      </div>
      <div className="flex shrink-0 items-center justify-end">{children}</div>
    </li>
  )
}

function SettingToggle({
  title,
  description,
  value,
  disabled = false,
  onChange,
}: {
  title: string
  description: string
  value: boolean
  disabled?: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <li className="grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-3 py-2.5">
      <label htmlFor={`preview-${title}`} className="cursor-pointer">
        <span className="block text-ui font-medium text-slate-900">{title}</span>
        <span className="mt-0.5 block text-xs text-slate-500">{description}</span>
      </label>
      <PreviewSwitch id={`preview-${title}`} label={title} value={value} disabled={disabled} onChange={onChange} />
    </li>
  )
}

function PreviewSwitch({
  id,
  label,
  value,
  disabled = false,
  onChange,
}: {
  id?: string
  label: string
  value: boolean
  disabled?: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={value}
      disabled={disabled}
      onClick={() => onChange(!value)}
      className="flex h-10 w-12 items-center justify-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span
        className={`relative h-6 w-10 rounded-full transition-colors duration-150 ${value ? 'bg-blue-700' : 'bg-slate-200'}`}
      >
        <span
          className={`absolute left-1 top-1 size-4 rounded-full bg-white shadow-softer transition-transform duration-150 ${value ? 'translate-x-4' : ''}`}
        />
      </span>
    </button>
  )
}

function PreviewSearch({ onClose, onNavigate }: { onClose: () => void; onNavigate: (view: View) => void }) {
  const { t } = usePreviewText()
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => inputRef.current?.focus(), [])
  const items: Array<[View, string, string]> = [
    ['inbox', t('Taken', 'Tasks'), t('Actiepunten met hun concrete bron', 'Action items with their concrete source')],
    ['today', t('Mijn dag', 'My Day'), t('Dagoverzicht en tijdlijn', 'Daily overview and timeline')],
    ['conversations', t('Gesprekken'), t('Opnames en herkende gesprekken', 'Recordings and recognized conversations')],
    ['wiki', t('Productontwikkeling', 'Product development'), t('Projecten, besluiten en onderzoek', 'Projects, decisions, and research')],
    ['assistant', 'Agent', t('Vragen over je werk', 'Questions about your work')],
    ['exclusions', t('Privacy'), t('Apps en websites uitsluiten', 'Exclude apps and websites')],
    ['settings', t('Instellingen'), t('Opstarten, bijwerken en opslag', 'Startup, updates, and storage')],
  ]
  const filtered = items.filter((item) => `${item[1]} ${item[2]}`.toLowerCase().includes(query.toLowerCase()))
  return (
    <div
      className="absolute inset-0 z-40 flex items-start justify-center bg-slate-950/20 p-4 pt-20 backdrop-blur-[1px]"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <dialog
        open
        aria-label={t('Zoek in Remember', 'Search Remember')}
        className="relative m-0 w-full max-w-md overflow-hidden rounded-xl bg-white p-0 shadow-raised"
      >
        <label className="flex h-12 items-center gap-3 border-b border-slate-100 px-4">
          <IconMagnifyingGlass2 className="size-4 text-slate-400" />
          <span className="sr-only">{t('Zoek in Remember', 'Search Remember')}</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onClose()
            }}
            placeholder={t('Zoek in Remember…', 'Search Remember…')}
            className="min-w-0 flex-1 text-sm text-slate-900 outline-none placeholder:text-slate-400"
          />
          <button
            type="button"
            onClick={onClose}
            className="rounded px-1.5 py-1 text-xs text-slate-400 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-slate-400"
          >
            Esc
          </button>
        </label>
        {filtered.length === 0 ? (
          <p role="status" className="px-4 py-6 text-center text-sm text-slate-500">
            {t('Geen resultaten.', 'No results.')}
          </p>
        ) : null}
        <ul className="p-1.5">
          {filtered.map(([id, title, description]) => (
            <li key={id}>
              <button
                type="button"
                onClick={() => onNavigate(id)}
                className="w-full rounded-lg px-3 py-2.5 text-left outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-slate-400"
              >
                <span className="block text-sm font-medium text-slate-800">{title}</span>
                <span className="mt-0.5 block text-xs text-slate-500">{description}</span>
              </button>
            </li>
          ))}
        </ul>
      </dialog>
    </div>
  )
}
