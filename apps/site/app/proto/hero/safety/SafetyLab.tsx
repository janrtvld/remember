'use client'

import { useCallback, useState } from 'react'
import { Faqs } from '../../../../components/Faqs'
import { Footer } from '../../../../components/Footer'
import { FeatureSections } from '../../../../components/landing/FeatureSections'
import { LandingPage } from '../../../../components/landing/LandingPage'
import { RailHeader } from '../../../../components/landing/RailHeader'
import type { SiteLocale } from '../../../../lib/locale-shared'
import { PrototypePicker } from '../PrototypePicker'
import { Closing, Cross, HeroCopy, ProductPreview, SectionSpacer } from '../refined/ExistingPageParts'
import { SafetyScene } from './SafetyScene'
import type { SceneVariant } from './scene-types'
import '../../../../components/landing/landing-grid.css'
import './safety.css'

const variants: SceneVariant[] = ['net', 'ribbon', 'drawer']

export function SafetyLab({ initialVariant, locale }: { initialVariant: number; locale: SiteLocale }) {
  const [active, setActive] = useState(initialVariant)
  const [replay, setReplay] = useState(0)
  const labels = locale === 'nl' ? ['Huidig', 'Doek', 'Glas', 'Lade'] : ['Current', 'Net', 'Glass', 'Drawer']

  const select = useCallback((index: number) => {
    setActive(index)
    setReplay((value) => value + 1)
    const url = new URL(window.location.href)
    url.searchParams.set('v', String(index + 1))
    window.history.replaceState(null, '', url)
    window.scrollTo({ top: 0, behavior: 'instant' })
  }, [])
  const replayScene = useCallback(() => setReplay((value) => value + 1), [])

  return (
    <>
      {active === 0 ? (
        <LandingPage key={replay} locale={locale} />
      ) : (
        <div className="landing-grid safety-landing min-h-screen min-w-0 overflow-x-clip">
          <RailHeader locale={locale} />
          <main className="mx-auto max-w-[1200px] border-x border-[var(--grid-line)]">
            <section className="square-grid square-inset safety-square">
              <div className="square-lattice" aria-hidden="true" />
              <div className="square-copy safety-copy">
                <Cross className="-left-px top-0" />
                <Cross className="-right-px top-0" />
                <HeroCopy
                  locale={locale}
                  description={
                    locale === 'nl'
                      ? 'Gesprekken, ideeën, kleine doorbraken. Remember vangt je werk op, zodat je altijd de draad weer vindt.'
                      : 'Conversations, ideas, little breakthroughs. Remember catches your work, so you can always pick up the thread.'
                  }
                />
              </div>
              <SafetyScene key={`${active}-${replay}`} variant={variants[active - 1]} locale={locale} />
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
      <PrototypePicker active={active} labels={labels} position="top" onSelect={select} onReplay={replayScene} />
    </>
  )
}
