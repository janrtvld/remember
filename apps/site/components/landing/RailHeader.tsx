import { ArrowRight as IconArrowRight } from 'lucide-react'
import { type SiteLocale, siteText } from '../../lib/locale-shared'
import { DownloadButton } from '../DownloadButton'
import { Button, Logo } from '../ui'
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
          <Button
            href="https://github.com/janrtvld/remember"
            target="_blank"
            rel="noopener noreferrer"
            size="small"
            variant="secondary"
            className="rail-header-github"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="size-[18px]" aria-hidden="true">
              <path d="M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656" />
            </svg>
            <span className="sr-only">{siteText(locale, 'Remember op GitHub', 'Remember on GitHub')}</span>
          </Button>
          <DownloadButton size="small" variant="secondary" className="rail-header-download">
            Download <IconArrowRight className="size-4" />
          </DownloadButton>
        </div>
      </nav>
    </header>
  )
}
