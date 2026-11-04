import type { PropsWithChildren } from 'react'
import type { SiteLocale } from '../lib/locale-shared'
import { Footer } from './Footer'
import { Header } from './Header'
import { Container } from './ui'

export function LandingPageShell({ children, locale }: PropsWithChildren<{ locale: SiteLocale }>) {
  return (
    <div className="flex min-h-screen min-w-0 flex-col justify-between overflow-x-hidden">
      <Header locale={locale} />
      <main className="-mt-3 min-w-0 flex-1">
        <section className="border-y border-slate-300">
          <Container
            padding="none"
            className="landing-frame-x flex min-h-[calc(100vh-6rem)] flex-col items-center px-4 pb-16 pt-24 sm:px-8 md:pb-24 md:pt-32"
          >
            {children}
          </Container>
        </section>
      </main>
      <Footer locale={locale} />
    </div>
  )
}
