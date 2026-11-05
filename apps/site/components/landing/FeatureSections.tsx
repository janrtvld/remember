import {
  ArrowRight as IconArrowRight,
  Book as IconBook,
  MessagesSquare as IconBubbles,
  Inbox as IconInbox,
} from 'lucide-react'
import { type SiteLocale, siteText } from '../../lib/locale-shared'
import { Button, DOWNLOAD_URL } from '../ui'
import { FeatureVideo } from './FeatureVideo'
import './feature-sections.css'

export function FeatureSections({ locale }: { locale: SiteLocale }) {
  const features = [
    {
      id: 'conversations',
      video: {
        src: '/videos/convos.mp4',
        poster: '/videos/convos-poster.webp',
        width: 1632,
        height: 1080,
      },
      icon: IconBubbles,
      overview: siteText(locale, 'Onthoud wat er is besproken.', 'Remember what was discussed.'),
      summary: siteText(
        locale,
        'Bewaar de belangrijkste punten en afspraken uit je gesprekken, zonder zelf mee te schrijven.',
        'Keep the key points and commitments from your conversations without taking notes.'
      ),
      title: siteText(locale, 'Onthoud de details van je gesprekken.', 'Keep the details from your conversations.'),
      description: siteText(
        locale,
        'Volg het gesprek zonder mee te schrijven. Vind achteraf de belangrijkste punten en afspraken terug, en open het oorspronkelijke gesprek als je meer context nodig hebt.',
        'Focus on the conversation without taking notes. Find the key points and next steps afterwards, and return to what was said whenever you need more context.'
      ),
    },
    {
      id: 'follow-ups',
      video: {
        src: '/videos/recognized.mp4',
        poster: '/videos/recognized-poster.webp',
        width: 1632,
        height: 1080,
      },
      icon: IconInbox,
      overview: siteText(locale, 'Weet wat er nog openstaat.', "Know what's still open."),
      summary: siteText(
        locale,
        'Zie welke actiepunten nog openstaan, met de context om ze op te pakken.',
        'See outstanding action points with the context you need to follow through.'
      ),
      title: siteText(locale, 'Pak de draad weer op.', 'Pick up where you left off.'),
      description: siteText(
        locale,
        'Zie welke verzoeken en toezeggingen nog je aandacht nodig hebben. Vind ze bij elkaar in één Inbox, met een link naar waar ze vandaan komen.',
        'See which requests and commitments still need your attention. Find them together in one Inbox, with a link back to where they came from.'
      ),
    },
    {
      id: 'project-memory',
      video: {
        src: '/videos/wiki.mp4',
        poster: '/videos/wiki-poster.webp',
        width: 1632,
        height: 1080,
      },
      icon: IconBook,
      overview: siteText(locale, 'Bouw kennis op terwijl je werkt.', 'Build knowledge as you work.'),
      summary: siteText(
        locale,
        'Bewaar nuttige kennis in lokale Spaces voor jezelf en je AI-tools.',
        'Keep useful knowledge in local Spaces for yourself and your AI tools.'
      ),
      title: siteText(locale, 'Geef je projecten een langetermijngeheugen.', 'Give your projects a long-term memory.'),
      description: siteText(
        locale,
        'Bewaar wat je hebt geleerd zonder alles zelf uit te schrijven. Remember bouwt kennis op in je Personal Space. Maak extra Spaces voor projecten of onderwerpen, en laat je AI-tools daarop voortbouwen.',
        "Keep what you've learned without writing it all from scratch. Remember builds knowledge in your Personal Space. Create more Spaces for projects or topics, and let your AI tools build on that context."
      ),
    },
  ]

  return (
    <div id="features" className="landing-features">
      <section className="feature-overview" aria-labelledby="feature-heading">
        <div className="feature-overview-heading">
          <h2 id="feature-heading">{siteText(locale, 'Je werk krijgt een geheugen.', 'Your work has a memory.')}</h2>
          <p>
            {siteText(
              locale,
              'Vind terug wat je deed en waarom. Pak openstaande zaken op en geef je AI-tools de context om verder te werken.',
              'Revisit what you did and why. Follow through on outstanding work and give your AI tools the context to move forward.'
            )}
          </p>
        </div>
        <div className="feature-overview-points">
          {features.map((feature) => (
            <article key={feature.id}>
              <div className="feature-point-symbol">
                <feature.icon aria-hidden="true" />
              </div>
              <h3>
                <a href={`#${feature.id}`}>
                  {feature.overview}
                  <IconArrowRight aria-hidden="true" />
                </a>
              </h3>
              <p>{feature.summary}</p>
            </article>
          ))}
        </div>
      </section>
      {features.map((feature, index) => (
        <section className="feature-section" id={feature.id} key={feature.id} aria-labelledby={`${feature.id}-heading`}>
          <div className={`feature-row${index === 1 ? ' feature-row-reversed' : ''}`}>
            <div className="feature-copy">
              <h2 id={`${feature.id}-heading`}>{feature.title}</h2>
              <p>{feature.description}</p>
              <Button href={DOWNLOAD_URL} size="small" variant="primary" className="feature-cta">
                {siteText(locale, 'Aan de slag', 'Get started')}
                <IconArrowRight className="size-4" aria-hidden="true" />
              </Button>
            </div>
            <div className="feature-media">
              <FeatureVideo locale={locale} {...feature.video} />
            </div>
          </div>
        </section>
      ))}
    </div>
  )
}
