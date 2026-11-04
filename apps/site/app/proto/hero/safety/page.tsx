import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

export const metadata: Metadata = {
  title: 'Remember — een vangnet voor je werk',
  robots: { index: false, follow: false },
}

export default async function SafetyPage({ searchParams }: { searchParams: Promise<{ v?: string }> }) {
  if (process.env.NODE_ENV !== 'development') notFound()
  const { getSiteLocale } = await import('../../../../lib/locale')
  const { SafetyLab } = await import('./SafetyLab')
  const [{ v }, locale] = await Promise.all([searchParams, getSiteLocale()])
  const selected = Number(v)
  const initialVariant = Number.isInteger(selected) && selected >= 1 && selected <= 4 ? selected - 1 : 1
  return <SafetyLab locale={locale} initialVariant={initialVariant} />
}
