import type { WorkItem, WorkItemSource } from '@remember/shared'
import type { SiteLocale } from '../../lib/locale-shared'
import { previewText } from './locale'

type PreviewWorkItemFixture = {
  id: string
  title: [dutch: string, english: string]
  description: [dutch: string, english: string]
  source: {
    kind: WorkItemSource['kind']
    label: [dutch: string, english: string]
    detail: [dutch: string, english: string]
  }
  ageMinutes: number
  dueAt: number | null
  status: WorkItem['status']
  evidence: Array<[dutch: string, english: string]>
  returnPoint: {
    lastMove: [dutch: string, english: string]
    unresolved: [dutch: string, english: string]
    nextMove: [dutch: string, english: string]
  }
  activity: [dutch: string, english: string]
}

function localized(locale: SiteLocale, [dutch, english]: [string, string]) {
  return previewText(locale, dutch, english)
}

function tomorrowAtNoon(now: number) {
  const date = new Date(now)
  date.setHours(12, 0, 0, 0)
  date.setDate(date.getDate() + 1)
  return date.getTime()
}

function createWorkItem(locale: SiteLocale, fixture: PreviewWorkItemFixture, now: number): WorkItem {
  const updatedAt = now - fixture.ageMinutes * 60_000
  const evidence = fixture.evidence.map((entry) => localized(locale, entry))
  const sourceKind = fixture.source.kind

  return {
    id: fixture.id,
    title: localized(locale, fixture.title),
    description: localized(locale, fixture.description),
    prompt: localized(locale, fixture.returnPoint.nextMove),
    context: evidence[0] ?? '',
    returnPoint: {
      lastMove: localized(locale, fixture.returnPoint.lastMove),
      unresolved: localized(locale, fixture.returnPoint.unresolved),
      nextMove: localized(locale, fixture.returnPoint.nextMove),
    },
    lifecycle: 'open',
    status: fixture.status,
    priority: 'none',
    dueAt: fixture.dueAt,
    attention: 'idle',
    createdAt: updatedAt,
    updatedAt,
    closedAt: null,
    userEditedTitle: sourceKind === 'manual',
    userEditedDescription: sourceKind === 'manual',
    sources: [
      {
        id: `${fixture.id}-source`,
        kind: sourceKind,
        label: localized(locale, fixture.source.label),
        detail: localized(locale, fixture.source.detail),
        workdayId: sourceKind === 'manual' ? null : 'preview-today',
        conversationReference: sourceKind === 'meeting' ? 'weekly-product-sync' : null,
        conversationStartTime: null,
        observedAt: updatedAt,
        confidence: sourceKind === 'manual' ? null : 0.94,
      },
    ],
    facts: [
      {
        id: `${fixture.id}-created`,
        type: 'created',
        actor: sourceKind === 'manual' ? 'user' : 'agent',
        summary: localized(locale, fixture.activity),
        at: updatedAt,
        agentSessionId: null,
      },
    ],
    observations: evidence.slice(1).map((summary, index) => ({
      id: `${fixture.id}-evidence-${index + 1}`,
      kind: 'progress',
      summary,
      confidence: 0.9,
      workdayId: 'preview-today',
      observedAt: updatedAt + index + 1,
      dismissedAt: null,
    })),
    agentSessions: [],
  }
}

export function createPreviewInboxItems(locale: SiteLocale, now = Date.now()): WorkItem[] {
  const fixtures: PreviewWorkItemFixture[] = [
    {
      id: 'meeting-flow',
      title: ['Deel de herziene onboardingflow met Elena', 'Share the revised onboarding flow with Elena'],
      description: [
        'Stuur vandaag de definitieve Figma-flow voor Elena’s review morgenochtend.',
        'Send the final Figma flow today for Elena’s review tomorrow morning.',
      ],
      source: {
        kind: 'meeting',
        label: ['Wekelijkse productsync', 'Weekly product sync'],
        detail: ['Vervolg afgesproken in de wekelijkse productsync.', 'Follow-up agreed in the weekly product sync.'],
      },
      ageMinutes: 1,
      dueAt: tomorrowAtNoon(now),
      status: 'in_progress',
      evidence: [
        [
          'Elena kan morgenochtend reviewen als de laatste variant vandaag gedeeld wordt.',
          'Elena can review tomorrow morning if the final version is shared today.',
        ],
        ['De definitieve flow staat klaar in Figma.', 'The final flow is ready in Figma.'],
      ],
      returnPoint: {
        lastMove: [
          'De definitieve onboardingflow is verwerkt in Figma.',
          'The final onboarding flow has been updated in Figma.',
        ],
        unresolved: [
          'Elena moet de laatste variant nog goedkeuren.',
          'Elena still needs to approve the final version.',
        ],
        nextMove: [
          'Deel de flow vandaag en vraag om review morgenochtend.',
          'Share the flow today and ask for a review tomorrow morning.',
        ],
      },
      activity: ['Remember herkende dit als open actiepunt', 'Remember recognized this as an open action item'],
    },
    {
      id: 'screen-rollout',
      title: ['Werk de rolloutnotitie bij met de meetpunten', 'Update the rollout note with the metrics'],
      description: [
        'Leg activatie en onboardingvoltooiing vast als eerste signalen.',
        'Record activation and onboarding completion as the first signals.',
      ],
      source: {
        kind: 'observed',
        label: ['Gezien in Notion', 'Observed in Notion'],
        detail: ['De rolloutnotitie bevat nog twee placeholders.', 'The rollout note still contains two placeholders.'],
      },
      ageMinutes: 60,
      dueAt: null,
      status: 'todo',
      evidence: [
        [
          'De secties voor activatie en onboardingvoltooiing zijn nog leeg.',
          'The activation and onboarding completion sections are still empty.',
        ],
      ],
      returnPoint: {
        lastMove: [
          'De eerste twee meetpunten zijn in de productsync gekozen.',
          'The first two metrics were chosen in the product sync.',
        ],
        unresolved: ['De definities en eigenaren ontbreken nog.', 'The definitions and owners are still missing.'],
        nextMove: ['Werk de placeholders in Notion bij.', 'Update the placeholders in Notion.'],
      },
      activity: [
        'Remember zag dat de rolloutnotitie nog niet af was',
        'Remember saw that the rollout note was unfinished',
      ],
    },
    {
      id: 'manual-support',
      title: ['Vraag support om de nieuwe formulering te gebruiken', 'Ask support to use the new wording'],
      description: ['Zelf toegevoegd na de designreview.', 'Added manually after the design review.'],
      source: {
        kind: 'manual',
        label: ['Zelf toegevoegd', 'Added manually'],
        detail: ['Door jou toegevoegd aan Taken.', 'Added to Tasks by you.'],
      },
      ageMinutes: 240,
      dueAt: null,
      status: 'todo',
      evidence: [],
      returnPoint: {
        lastMove: ['', ''],
        unresolved: ['Support gebruikt nog de oude succesboodschap.', 'Support still uses the old success message.'],
        nextMove: ['Deel de nieuwe zin in het supportkanaal.', 'Share the new sentence in the support channel.'],
      },
      activity: ['Door jou toegevoegd aan Taken', 'Added to Tasks by you'],
    },
  ]

  return fixtures.map((fixture) => createWorkItem(locale, fixture, now))
}

export function createManualPreviewWorkItem(
  locale: SiteLocale,
  input: { id: string; title: string; description: string },
  now = Date.now()
) {
  return createWorkItem(
    locale,
    {
      id: input.id,
      title: [input.title, input.title],
      description: [input.description, input.description],
      source: {
        kind: 'manual',
        label: ['Zelf toegevoegd', 'Added manually'],
        detail: ['Door jou toegevoegd aan Taken.', 'Added to Tasks by you.'],
      },
      ageMinutes: 1,
      dueAt: null,
      status: 'todo',
      evidence: [],
      returnPoint: {
        lastMove: ['', ''],
        unresolved: [input.description, input.description],
        nextMove: ['Pak het actiepunt op wanneer het uitkomt.', 'Pick up the action item when it fits.'],
      },
      activity: ['Door jou toegevoegd aan Taken', 'Added to Tasks by you'],
    },
    now
  )
}
