import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

export const metadata: Metadata = {
  title: 'Remember — Hero explorations',
  robots: { index: false, follow: false },
}

export default async function HeroExploration({ searchParams }: { searchParams: Promise<{ v?: string }> }) {
  if (process.env.NODE_ENV !== 'development') notFound()
  const { HeroLab } = await import('./HeroLab')
  const { v } = await searchParams
  const selected = Number(v)
  const initialVariant = Number.isInteger(selected) && selected >= 1 && selected <= 4 ? selected - 1 : 0

  return <HeroLab initialVariant={initialVariant} />
}
