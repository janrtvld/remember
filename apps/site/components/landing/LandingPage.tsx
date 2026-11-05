import { ArrowRight as IconArrowRight } from 'lucide-react'
import { type SiteLocale, siteText } from '../../lib/locale-shared'
import { DownloadButton } from '../DownloadButton'
import { Faqs } from '../Faqs'
import { Footer } from '../Footer'
import { LocalAppPreview } from '../LocalAppPreview'
import { FeatureSections } from './FeatureSections'
import { RailHeader } from './RailHeader'
import './landing-grid.css'
import './hero-intro.css'

function Cross({ className }: { className: string }) {
  return <span aria-hidden="true" className={`grid-cross ${className}`} />
}

function SectionSpacer() {
  return <div aria-hidden="true" className="section-spacer" />
}

function HeroCopy({ locale }: { locale: SiteLocale }) {
  return (
    <div className="landing-hero-copy">
      <h1 className="font-marketing" id="hero-title">
        <span className="hero-blur inline-block">{siteText(locale, 'Het systeem dat', 'The system that')}</span>
        <span className="landing-hero-accent hero-blur" style={{ animationDelay: '90ms' }}>
          {siteText(locale, 'je werk onthoudt', 'remembers your work')}
        </span>
      </h1>
      <div className="landing-hero-details">
        <p className="hero-blur font-medium" style={{ animationDelay: '180ms' }}>
          {siteText(
            locale,
            'Remember maakt van al je werk een levend geheugen waar je altijd op kunt terugvallen.',
            'Remember turns your work into a living memory you can always return to.'
          )}
        </p>
        <div className="landing-hero-actions hero-blur" style={{ animationDelay: '260ms' }}>
          <a href="#features" className="landing-hero-link">
            {siteText(locale, 'Zo werkt het', 'How it works')}
            <IconArrowRight className="size-3.5" aria-hidden="true" />
          </a>
          <DownloadButton size="small" className="min-h-11 px-5 text-base">
            {siteText(locale, 'Download voor Mac', 'Download for Mac')}
            <IconArrowRight className="size-4" aria-hidden="true" />
          </DownloadButton>
        </div>
      </div>
    </div>
  )
}

function ProductPreview({ locale }: { locale: SiteLocale }) {
  return (
    <section
      id="product-preview"
      aria-label={siteText(locale, 'Ontdek Remember', 'Explore Remember')}
      className="grid-rule relative scroll-mt-16"
    >
      <Cross className="-left-px top-0" />
      <Cross className="-right-px top-0" />
      <div className="product-preview-framing p-3 sm:p-4">
        <div
          className="product-preview-window hero-dash overflow-hidden rounded-xl border border-[var(--grid-line)] bg-slate-50 shadow-soft"
          style={{ animationDelay: '380ms' }}
        >
          <div
            role="region"
            aria-label={siteText(locale, 'Productdemo', 'Product demo')}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: The overflowing demo region needs native keyboard scrolling.
            tabIndex={0}
            data-grid-preview=""
            className="overflow-x-auto overscroll-x-contain focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-slate-500"
          >
            <div className="product-preview-canvas">
              <LocalAppPreview locale={locale} />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function Closing({ locale }: { locale: SiteLocale }) {
  return (
    <section aria-labelledby="footer-cta-title" className="grid-rule relative grid md:grid-cols-3">
      <Cross className="-left-px top-0" />
      <Cross className="-right-px top-0" />
      <div className="flex flex-col gap-4 px-6 py-12 sm:px-8 sm:py-16 md:col-span-2">
        <h2
          id="footer-cta-title"
          className="font-marketing text-balance text-3xl font-semibold tracking-tight text-slate-900"
        >
          <span className="text-slate-500">{siteText(locale, 'Je hoeft niet', "You don't have to")}</span>
          <br />
          {siteText(locale, 'alles te onthouden', 'remember everything')}
        </h2>
        <p className="max-w-lg text-pretty text-base font-medium leading-relaxed text-slate-600">
          {siteText(
            locale,
            'Vind terug wat je deed, wat je besloot en waar je gebleven was.',
            'Rediscover what you did, what you decided, and where you left off.'
          )}
        </p>
      </div>
      <div className="grid-hatch flex flex-col items-start justify-center gap-3 border-t border-[var(--grid-line)] p-6 sm:p-8 md:items-center md:border-l md:border-t-0 md:p-4 lg:p-8">
        <DownloadButton size="small" className="min-h-11 whitespace-nowrap px-5 text-base">
          {siteText(locale, 'Download voor Mac', 'Download for Mac')}
          <IconArrowRight className="size-4" />
        </DownloadButton>
      </div>
    </section>
  )
}

export function LandingPage({ locale }: { locale: SiteLocale }) {
  return (
    <div className="landing-grid min-h-screen min-w-0 overflow-x-clip">
      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: Fixed first-paint session guard, matching the Revinote hero.
        dangerouslySetInnerHTML={{
          __html:
            "try{if(sessionStorage.getItem('remember-intro-seen')){document.documentElement.classList.add('intro-seen')}else{sessionStorage.setItem('remember-intro-seen','1')}}catch(e){}",
        }}
      />
      <RailHeader locale={locale} />
      <main className="mx-auto max-w-[1200px] border-x border-[var(--grid-line)]">
        <section className="landing-hero" aria-labelledby="hero-title">
          <HeroCopy locale={locale} />
        </section>
        <ProductPreview locale={locale} />
        <FeatureSections locale={locale} />
        <SectionSpacer />
        <div className="grid-rule grid-faq">
          <Faqs locale={locale} />
        </div>
        <Closing locale={locale} />
        <SectionSpacer />
      </main>
      <Footer locale={locale} />
    </div>
  )
}
