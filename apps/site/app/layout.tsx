import type { Metadata } from 'next'
import localFont from 'next/font/local'
import type { ReactNode } from 'react'
import { getSiteLocale } from '../lib/locale'
import { rootMetadata } from '../lib/siteMetadata'
import './globals.css'

const manrope = localFont({
  src: '../public/fonts/manrope-latin.woff2',
  variable: '--font-manrope',
  weight: '200 800',
  display: 'swap',
})
const figtree = localFont({
  src: '../public/fonts/figtree-latin.woff2',
  variable: '--font-figtree',
  weight: '300 900',
  display: 'swap',
})

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getSiteLocale()
  return rootMetadata(locale)
}

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const locale = await getSiteLocale()
  return (
    <html lang={locale} className={`${manrope.variable} ${figtree.variable}`} data-scroll-behavior="smooth">
      <body className="flex min-h-screen w-full flex-col justify-between bg-slate-50">
        {children}
        <script
          defer
          src="https://static.cloudflareinsights.com/beacon.min.js"
          data-cf-beacon='{"token":"1f9f49d4a19f4ac6bf182052c8d28f55"}'
        />
      </body>
    </html>
  )
}
