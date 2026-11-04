import type { Metadata } from 'next'
import type { SiteLocale } from './locale-shared'
import { siteText } from './locale-shared'
import { siteUrl } from './site'

const socialImage = {
  url: '/seo.jpg',
  width: 1200,
  height: 630,
  alt: 'Remember.',
}

export function landingTitle(locale: SiteLocale) {
  return siteText(
    locale,
    'Remember - het systeem dat je werk onthoudt',
    'Remember - The system for work that remembers'
  )
}

export function landingDescription(locale: SiteLocale) {
  return siteText(
    locale,
    'Remember maakt van je werk levende context, zodat jij en je AI-agents direct verder kunnen.',
    'Remember turns your work into living context, so you and your AI agents can pick up right where you left off.'
  )
}

export function rootMetadata(locale: SiteLocale): Metadata {
  const title = landingTitle(locale)
  const description = landingDescription(locale)

  return {
    metadataBase: siteUrl,
    applicationName: 'Remember',
    title: { default: title, template: '%s — Remember' },
    description,
    authors: [{ name: 'Remember' }],
    creator: 'Remember',
    publisher: 'Remember',
    category: 'productivity',
    formatDetection: { email: false, address: false, telephone: false },
    icons: {
      icon: [{ url: '/app-icon.svg', type: 'image/svg+xml' }],
      apple: [{ url: '/apple-icon.png', type: 'image/png', sizes: '180x180' }],
    },
    openGraph: {
      type: 'website',
      url: '/',
      siteName: 'Remember',
      title,
      description,
      locale: locale === 'nl' ? 'nl_NL' : 'en_US',
      images: [socialImage],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [socialImage],
    },
  }
}

export function pageMetadata({
  locale,
  title,
  description,
  path,
  index = true,
}: {
  locale: SiteLocale
  title: string
  description: string
  path: `/${string}`
  index?: boolean
}): Metadata {
  return {
    title,
    description,
    alternates: index ? { canonical: path } : undefined,
    robots: { index, follow: index },
    openGraph: {
      type: 'website',
      url: path,
      siteName: 'Remember',
      title,
      description,
      locale: locale === 'nl' ? 'nl_NL' : 'en_US',
      images: [socialImage],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [socialImage],
    },
  }
}
