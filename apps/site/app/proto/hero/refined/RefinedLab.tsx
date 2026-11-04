'use client'

import { useCallback, useState } from 'react'
import { Faqs } from '../../../../components/Faqs'
import { Footer } from '../../../../components/Footer'
import { FeatureSections } from '../../../../components/landing/FeatureSections'
import { LandingPage } from '../../../../components/landing/LandingPage'
import { RailHeader } from '../../../../components/landing/RailHeader'
import type { SiteLocale } from '../../../../lib/locale-shared'
import { PrototypePicker } from '../PrototypePicker'
import { Closing, Cross, HeroCopy, ProductPreview, SectionSpacer } from './ExistingPageParts'
import { GlassRibbonScene } from './GlassRibbonScene'
import { ThreadScene } from './ThreadScene'
import '../../../../components/landing/landing-grid.css'
import './refined.css'

export function RefinedLab({ initialVariant, locale }: { initialVariant: number; locale: SiteLocale }) {
  const [active, setActive] = useState(initialVariant)
  const [replay, setReplay] = useState(0)
  const labels = locale === 'nl' ? ['Huidig', 'Stroom', 'Glas'] : ['Current', 'Thread', 'Glass']

  const selectVariant = useCallback((index: number) => {
    setActive(index)
    setReplay((value) => value + 1)
    const url = new URL(window.location.href)
    url.searchParams.set('v', String(index + 1))
    url.hash = ''
    window.history.replaceState(null, '', url)
    window.scrollTo({ top: 0, behavior: 'instant' })
  }, [])

  const replayVariant = useCallback(() => setReplay((value) => value + 1), [])

  return (
    <>
      {active === 0 ? (
        <LandingPage key={replay} locale={locale} />
      ) : (
        <div className="landing-grid refined-landing min-h-screen min-w-0 overflow-x-clip">
          <RailHeader locale={locale} />
          <main className="mx-auto max-w-[1200px] border-x border-[var(--grid-line)]">
            <section className="square-grid square-inset refined-square">
              <div aria-hidden="true" className="square-lattice" />
              <div className="square-copy refined-copy">
                <Cross className="-left-px top-0" />
                <Cross className="-right-px top-0" />
                <HeroCopy locale={locale} />
              </div>
              <div className="refined-scene" data-scene-input="" key={`${active}-${replay}`}>
                {active === 1 ? <ThreadScene locale={locale} /> : <GlassRibbonScene locale={locale} />}
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
      )}
      <PrototypePicker
        active={active}
        labels={labels}
        position="top"
        onSelect={selectVariant}
        onReplay={replayVariant}
      />
    </>
  )
}
