import { ArrowRight as IconArrowRight } from 'lucide-react'
import { type SiteLocale, siteText } from '../../lib/locale-shared'
import { DownloadButton } from '../DownloadButton'
import { Logo } from '../ui'
import './rail-header.css'

export function RailHeader({ locale }: { locale: SiteLocale }) {
  return (
    <header className="rail-header">
      <nav className="rail-header-row" aria-label={siteText(locale, 'Hoofdnavigatie', 'Main navigation')}>
        <span aria-hidden="true" className="grid-cross rail-header-cross left-0 -bottom-px" />
        <span aria-hidden="true" className="grid-cross rail-header-cross right-0 -bottom-px" />
        <div className="rail-header-left">
          <div className="rail-header-logo">
            <Logo wordmark homeLabel={siteText(locale, 'Remember-homepagina', 'Remember home')} />
          </div>
          <div className="rail-header-links">
            <a href="#product-preview" className="rail-header-link rail-header-product">
              Product
            </a>
            <a href="#features" className="rail-header-link rail-header-features">
              Features
            </a>
            <a href="#faqs" className="rail-header-link">
              FAQs
            </a>
          </div>
        </div>
        <div className="rail-header-actions">
          <DownloadButton size="small" variant="secondary" className="rail-header-download">
            Download <IconArrowRight className="size-4" />
          </DownloadButton>
        </div>
      </nav>
    </header>
  )
}
