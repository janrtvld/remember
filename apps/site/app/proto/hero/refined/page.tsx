import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

export const metadata: Metadata = {
  title: 'Remember — Interactieve hero',
  robots: { index: false, follow: false },
}

export default async function RefinedHeroPage({ searchParams }: { searchParams: Promise<{ v?: string }> }) {
  if (process.env.NODE_ENV !== 'development') notFound()
  const { getSiteLocale } = await import('../../../../lib/locale')
  const { RefinedLab } = await import('./RefinedLab')
  const [{ v }, locale] = await Promise.all([searchParams, getSiteLocale()])
  const selected = Number(v)
  const initialVariant = Number.isInteger(selected) && selected >= 1 && selected <= 3 ? selected - 1 : 0

  return <RefinedLab locale={locale} initialVariant={initialVariant} />
}
