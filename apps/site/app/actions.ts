'use server'

import { cookies } from 'next/headers'
import { siteLocaleCookie } from '../lib/locale'
import type { SiteLocale } from '../lib/locale-shared'

export async function changeSiteLocale(locale: SiteLocale) {
  if (locale !== 'en' && locale !== 'nl') throw new Error('Invalid locale')
  const cookieStore = await cookies()
  cookieStore.set(siteLocaleCookie, locale, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  })
}
