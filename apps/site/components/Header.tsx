'use client'

import { ArrowRight as IconArrowRight } from 'lucide-react'
import type { MouseEvent } from 'react'
import type { SiteLocale } from '../lib/locale-shared'
import { siteText } from '../lib/locale-shared'
import { DownloadButton } from './DownloadButton'
import { Container, Logo } from './ui'

const navigationLinks = [
  { label: 'Features', href: '/#product-preview' },
  { label: 'FAQ', href: '/#faqs' },
] as const

function scrollToFeatures(event: MouseEvent<HTMLAnchorElement>) {
  if (window.location.pathname !== '/') return

  const preview = document.getElementById('product-preview')
  if (!preview) return

  event.preventDefault()
  preview.scrollIntoView({ block: 'center' })
  window.history.replaceState(null, '', '#product-preview')
}

export function Header({ locale }: { locale: SiteLocale }) {
  const downloadLabel = (
    <>
      {siteText(locale, 'Download', 'Download')} <IconArrowRight className="-ml-1 size-3.5" />
    </>
  )

  return (
    <header className="sticky top-4 z-30">
      <Container padding="none" className="landing-frame-x border-transparent px-2 sm:px-4">
        <nav
          aria-label={siteText(locale, 'Hoofdnavigatie', 'Main navigation')}
          className="mx-auto flex h-14 w-fit items-center rounded-xl border border-slate-300 bg-slate-50 px-2 sm:px-4"
        >
          <div className="flex items-center gap-1 sm:gap-3">
            <Logo wordmark homeLabel={siteText(locale, 'Remember-homepagina', 'Remember home')} />
            <div className="flex items-center gap-0 px-0 sm:gap-2 sm:px-2 md:gap-3 md:px-3">
              {navigationLinks.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  onClick={link.href === '/#product-preview' ? scrollToFeatures : undefined}
                  className="rounded-lg px-1.5 py-2 text-xs font-medium text-slate-600 outline-none transition-opacity duration-150 hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-600 sm:p-2 sm:text-sm"
                >
                  {link.label === 'Features' ? siteText(locale, 'Functies', 'Features') : link.label}
                </a>
              ))}
            </div>
            <DownloadButton
              size="small"
              variant="outline"
              className="border border-slate-300 bg-slate-50 px-2.5 text-xs sm:px-3 sm:text-sm"
            >
              {downloadLabel}
            </DownloadButton>
          </div>
        </nav>
      </Container>
    </header>
  )
}
