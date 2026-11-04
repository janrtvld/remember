import type { Metadata } from 'next'
import { LandingPage } from '../components/landing/LandingPage'
import { getSiteLocale } from '../lib/locale'
import { absoluteSiteUrl } from '../lib/site'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  alternates: { canonical: '/' },
}

export default async function Home() {
  const locale = await getSiteLocale()
  const softwareApplicationJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Remember',
    url: absoluteSiteUrl('/'),
    applicationCategory: 'ProductivityApplication',
    operatingSystem: 'macOS 14.4 or newer',
    offers: {
      '@type': 'Offer',
      price: 0,
      priceCurrency: 'EUR',
      url: absoluteSiteUrl('/download'),
      availability: 'https://schema.org/InStock',
    },
  }
  return (
    <>
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: This controlled JSON-LD payload escapes HTML delimiters.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareApplicationJsonLd).replace(/</g, '\\u003c') }}
      />
      <LandingPage locale={locale} />
    </>
  )
}
