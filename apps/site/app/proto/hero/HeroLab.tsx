'use client'

import { useCallback, useState } from 'react'
import { DownloadButton } from '../../../components/DownloadButton'
import { LocalAppPreview } from '../../../components/LocalAppPreview'
import { LandingPage } from '../../../components/landing/LandingPage'
import { Logo } from '../../../components/ui'
import { AfterHoursHero } from './AfterHoursHero'
import { ContinuumHero } from './ContinuumHero'
import { PrismHero } from './PrismHero'
import { PrototypePicker } from './PrototypePicker'
import './hero-lab.css'
import './picker.css'

const variants = ['Current', 'Prism', 'Continuum', 'Room']
const directions = ['current', 'prism', 'continuum', 'after-hours']

function LabHeader() {
  return (
    <header className="hero-lab-header">
      <a className="hero-lab-skip" href="#hero-content">
        Skip to content
      </a>
      <nav aria-label="Main navigation" className="hero-lab-navigation">
        <Logo wordmark />
        <div className="hero-lab-navigation-links">
          <a href="#product-preview">The product</a>
          <a href="/privacy">Your privacy</a>
        </div>
        <DownloadButton size="small" variant="secondary" className="hero-lab-download">
          Get Remember <span aria-hidden="true">↗</span>
        </DownloadButton>
      </nav>
    </header>
  )
}

function ProductPreview() {
  return (
    <section id="product-preview" className="hero-lab-product" aria-labelledby="hero-lab-product-title">
      <div className="hero-lab-product-intro">
        <h2 id="hero-lab-product-title">Right where you left off.</h2>
        <p>Your conversations, decisions, and next steps. Together, with the context to keep going.</p>
      </div>
      <div
        className="hero-lab-product-frame"
        role="region"
        aria-label="Interactive Remember preview"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The wide app preview supports native keyboard scrolling.
        tabIndex={0}
      >
        <div className="hero-lab-product-scaled">
          <div className="hero-lab-product-canvas">
            <LocalAppPreview locale="en" />
          </div>
        </div>
      </div>
      <p className="hero-lab-local-note">
        Recordings and history stay on your Mac. AI processing uses the providers you connect.
      </p>
    </section>
  )
}

export function HeroLab({ initialVariant }: { initialVariant: number }) {
  const [active, setActive] = useState(initialVariant)
  const [replay, setReplay] = useState(0)

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
    <div className="hero-lab" data-direction={directions[active]} lang="en">
      {active === 0 ? (
        <LandingPage key={replay} locale="en" />
      ) : (
        <>
          <LabHeader />
          <main id="hero-content">
            <div key={`${active}-${replay}`}>
              {active === 1 ? <PrismHero /> : active === 2 ? <ContinuumHero /> : <AfterHoursHero />}
            </div>
            <ProductPreview />
          </main>
          <footer className="hero-lab-footer">
            <Logo wordmark />
            <span>A little less to carry.</span>
            <a href="/privacy">Privacy</a>
          </footer>
        </>
      )}
      <PrototypePicker labels={variants} active={active} onSelect={selectVariant} onReplay={replayVariant} />
    </div>
  )
}
