import { ArrowRight as IconArrowRight } from 'lucide-react'
import type { Metadata } from 'next'
import { LandingPageShell } from '../../components/LandingPageShell'
import { Button, DOWNLOAD_URL } from '../../components/ui'
import { getSiteLocale } from '../../lib/locale'
import { siteText } from '../../lib/locale-shared'
import { pageMetadata } from '../../lib/siteMetadata'

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getSiteLocale()
  return pageMetadata({
    locale,
    title: 'Download Remember',
    description: siteText(
      locale,
      'Installeer Remember op je Mac en geef je AI-agents de context om direct verder te gaan.',
      'Install Remember on your Mac and give your AI agents the context to pick up right away.'
    ),
    path: '/download',
  })
}

export default async function DownloadPage() {
  const locale = await getSiteLocale()
  return (
    <LandingPageShell locale={locale}>
      <div className="flex w-full max-w-2xl flex-col items-center text-center">
        <h1 className="mt-8 font-marketing text-balance text-[40px] font-semibold leading-[1.1] tracking-tight text-slate-900 sm:text-4xl">
          {siteText(locale, 'Download Remember', 'Download Remember')}
        </h1>
        <p className="mt-4 max-w-xl text-pretty text-lg font-medium leading-7 text-slate-600">
          {siteText(
            locale,
            'Installeer Remember op je Mac en geef je AI-agents de context om direct verder te gaan.',
            'Install Remember on your Mac and give your AI agents the context to pick up right away.'
          )}
        </p>
        <div className="mt-8">
          <Button href={DOWNLOAD_URL}>
            {siteText(locale, 'Download voor Mac', 'Download for Mac')} <IconArrowRight className="size-4" />
          </Button>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          {siteText(locale, 'Voor Apple Silicon · macOS 14.4 of nieuwer', 'For Apple Silicon · macOS 14.4 or newer')}
        </p>
      </div>
    </LandingPageShell>
  )
}
