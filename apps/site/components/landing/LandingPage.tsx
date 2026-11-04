import { ArrowRight as IconArrowRight } from 'lucide-react'
import Image from 'next/image'
import { type SiteLocale, siteText } from '../../lib/locale-shared'
import { DownloadButton } from '../DownloadButton'
import { Faqs } from '../Faqs'
import { Footer } from '../Footer'
import { LocalAppPreview } from '../LocalAppPreview'
import { FeatureSections } from './FeatureSections'
import { RailHeader } from './RailHeader'
import './landing-grid.css'

function Cross({ className }: { className: string }) {
  return <span aria-hidden="true" className={`grid-cross ${className}`} />
}

function SectionSpacer() {
  return <div aria-hidden="true" className="section-spacer" />
}

function HeroCopy({ locale }: { locale: SiteLocale }) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-6 text-center">
      <h1 className="font-marketing max-w-4xl text-balance text-[44px] font-[650] leading-[1.12] tracking-tight text-[#272727] sm:text-4xl sm:leading-[1.13] lg:text-5xl">
        {siteText(locale, 'Het systeem dat', 'The system for work')}{' '}
        <span className="block">
          {siteText(locale, 'je werk ', 'that ')}
          <span className="bg-clip-text text-transparent" style={{ backgroundImage: 'var(--hero-text-gradient)' }}>
            {siteText(locale, 'onthoudt', 'remembers')}
          </span>
        </span>
      </h1>
      <p className="max-w-xl text-pretty text-base font-medium leading-relaxed text-slate-600 md:text-lg">
        {siteText(
          locale,
          'Remember maakt van al je werk een levend geheugen waar je altijd op kunt terugvallen.',
          'Remember turns your work into a living memory you can always return to.'
        )}
      </p>
      <div className="flex flex-col items-center gap-3">
        <DownloadButton size="small" className="min-h-11 px-5 text-base">
          {siteText(locale, 'Download voor Mac', 'Download for Mac')} <IconArrowRight className="size-4" />
        </DownloadButton>
        <p className="text-[11px] font-medium leading-5 text-slate-500">
          {siteText(locale, 'Remember is in beta.', 'Remember is currently in beta.')}{' '}
          <span className="inline-flex items-center gap-1 whitespace-nowrap align-baseline">
            {siteText(locale, 'Werkt met Codex en Claude', 'Works w/ Codex and Claude')}
            <span className="inline-flex items-center gap-0.5" aria-hidden="true">
              <Image src="/brand/codex-monochrome.svg" width={16} height={16} alt="" className="opacity-50" />
              <Image src="/brand/claude-monochrome.svg" width={12} height={12} alt="" className="opacity-50" />
            </span>
          </span>
        </p>
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
        <div className="product-preview-window overflow-hidden rounded-xl border border-[var(--grid-line)] bg-slate-50 shadow-soft">
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
      <RailHeader locale={locale} />
      <main className="mx-auto max-w-[1200px] border-x border-[var(--grid-line)]">
        <section className="square-grid square-inset has-side-columns">
          <div aria-hidden="true" className="square-lattice" />
          <div aria-hidden="true" className="square-side-column square-side-column-start" />
          <div aria-hidden="true" className="square-side-column square-side-column-end" />
          <div className="square-copy">
            <Cross className="-left-px -top-px" />
            <Cross className="-right-px -top-px" />
            <Cross className="-left-px -bottom-px" />
            <Cross className="-right-px -bottom-px" />
            <HeroCopy locale={locale} />
          </div>
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
