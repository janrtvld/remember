import Link from 'next/link'
import type { SiteLocale } from '../lib/locale-shared'
import { siteText } from '../lib/locale-shared'
import { LanguageSwitcher } from './LanguageSwitcher'
import { Container } from './ui'

export function Footer({ locale }: { locale: SiteLocale }) {
  return (
    <footer id="footer" className="">
      <Container padding="none" className="landing-frame-x flex items-center justify-between p-4">
        <span className="text-sm font-medium text-slate-600">© {new Date().getFullYear()} Remember</span>
        <div className="flex items-center gap-4">
          <LanguageSwitcher locale={locale} />
          <Link
            href="/privacy"
            className="hidden rounded-sm text-sm font-medium text-slate-800 underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500 sm:inline"
          >
            {siteText(locale, 'Privacybeleid', 'Privacy policy')}
          </Link>
        </div>
      </Container>
    </footer>
  )
}
