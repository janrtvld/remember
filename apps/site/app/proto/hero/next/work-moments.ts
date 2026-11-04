// The same onboarding day used by components/LocalAppPreview.tsx. Keep these
// excerpts and outcomes aligned with its conversation and timeline fixtures.
export type WorkMoment = {
  time: string
  title: string
  shortTitle: string
  lines: [string, string]
  summary: string
  action: string
  question: string
  answer: string
  sourceLabel: string
  excerpt: string
  app: 'Teams' | 'Figma' | 'Notion'
}

export const workMoments: Record<'nl' | 'en', WorkMoment[]> = {
  nl: [
    {
      time: '10:30',
      title: 'Wekelijkse productsync',
      shortTitle: 'Productoverleg',
      lines: ['Donderdag live.', 'Analytics later.'],
      summary:
        'De onboarding gaat donderdag live met de begeleide lege staat. Uitgebreidere analytics wordt na de eerste week opnieuw beoordeeld.',
      action: 'Deel de herziene onboardingflow met Elena.',
      question: 'Wat spraken we af over de release?',
      answer:
        'Donderdag blijft staan. De nieuwe lege staat gaat mee; uitgebreidere analytics wordt na de eerste week opnieuw beoordeeld.',
      sourceLabel: 'Gesprekken · 10:30–11:03',
      excerpt:
        'Dan zou ik de begeleide lege staat wel meenemen, maar de uitgebreidere analytics niet aan deze release koppelen.',
      app: 'Teams',
    },
    {
      time: '15:00',
      title: 'Designreview onboarding',
      shortTitle: 'Designreview',
      lines: ['Terugknop blijft.', 'Eerste stap helder.'],
      summary:
        'De terugknop blijft zichtbaar. De succesboodschap vertelt concreet waar het eerste dagoverzicht verschijnt.',
      action: 'Pas de succesboodschap aan in het prototype.',
      question: 'Waarom bleef de terugknop?',
      answer:
        'De toestemmingsstap voelde te definitief. In de designreview besloten we de terugknop zichtbaar te houden.',
      sourceLabel: 'Gesprekken · 15:00–15:32',
      excerpt: 'Met de terugknop hier voelt de toestemmingsstap minder definitief. Die zou ik laten staan.',
      app: 'Teams',
    },
    {
      time: '16:32',
      title: 'Release-handoff geschreven',
      shortTitle: 'Overdracht',
      lines: ['Meetpunten klaar.', 'Klaar om te delen.'],
      summary:
        'De rolloutnotitie, meetpunten en gedeelde supportcopy zijn vastgelegd. De onboardingflow is klaar voor de laatste review.',
      action: 'Deel de definitieve flow en rolloutnotitie.',
      question: 'Waar staan de meetpunten?',
      answer: 'Bij de release-handoff, samen met de rolloutnotitie en gedeelde supportcopy. Je werkte eraan tot 16:32.',
      sourceLabel: 'Tijdlijn · 15:40–16:32',
      excerpt: 'Release-handoff geschreven. Rolloutnotitie, meetpunten en gedeelde supportcopy vastgelegd.',
      app: 'Notion',
    },
  ],
  en: [
    {
      time: '10:30',
      title: 'Weekly product sync',
      shortTitle: 'Product sync',
      lines: ['Live Thursday.', 'Analytics later.'],
      summary:
        'Onboarding ships on Thursday with the guided empty state. Extended analytics is reviewed after the first week.',
      action: 'Share the revised onboarding flow with Elena.',
      question: 'What did we agree on for the release?',
      answer:
        'Thursday still stands. The new empty state ships now; extended analytics is reviewed after the first week.',
      sourceLabel: 'Conversations · 10:30–11:03',
      excerpt: 'I would include the guided empty state, but keep the extended analytics out of this release.',
      app: 'Teams',
    },
    {
      time: '15:00',
      title: 'Onboarding design review',
      shortTitle: 'Design review',
      lines: ['Back button stays.', 'First step clear.'],
      summary:
        'The back button stays visible. The success message explains exactly where the first day overview will appear.',
      action: 'Update the success message in the prototype.',
      question: 'Why did we keep the back button?',
      answer: 'The permission step felt too final. In the design review we agreed to keep the back button visible.',
      sourceLabel: 'Conversations · 15:00–15:32',
      excerpt: 'With the back button here, the permission step feels less final. I would keep it.',
      app: 'Teams',
    },
    {
      time: '16:32',
      title: 'Release handoff written',
      shortTitle: 'Handoff',
      lines: ['Metrics ready.', 'Ready to share.'],
      summary:
        'The rollout note, metrics and shared support copy are documented. The onboarding flow is ready for its final review.',
      action: 'Share the final flow and rollout note.',
      question: 'Where did I put the metrics?',
      answer:
        'In the release handoff, alongside the rollout note and shared support copy. You worked on it until 16:32.',
      sourceLabel: 'Timeline · 15:40–16:32',
      excerpt: 'Release handoff written. Rollout note, metrics and shared support copy documented.',
      app: 'Notion',
    },
  ],
}
