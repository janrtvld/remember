import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

export const metadata: Metadata = {
  title: 'Remember — Afdruk, Focus, Tijd',
  robots: { index: false, follow: false },
}

export default async function NextHeroPage({ searchParams }: { searchParams: Promise<{ v?: string }> }) {
  if (process.env.NODE_ENV !== 'development') notFound()
  const { getSiteLocale } = await import('../../../../lib/locale')
  const { NextHeroLab } = await import('./NextHeroLab')
  const [{ v }, locale] = await Promise.all([searchParams, getSiteLocale()])
  const selected = Number(v)
  const initialVariant = Number.isInteger(selected) && selected >= 1 && selected <= 4 ? selected - 1 : 0

  return <NextHeroLab locale={locale} initialVariant={initialVariant} />
}
