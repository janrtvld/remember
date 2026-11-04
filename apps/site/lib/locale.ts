import 'server-only'

import { cookies, headers } from 'next/headers'
import { cache } from 'react'
import type { SiteLocale } from './locale-shared'

const LOCALE_COOKIE = 'remember-locale'

export const getSiteLocale = cache(async (): Promise<SiteLocale> => {
  const savedLocale = (await cookies()).get(LOCALE_COOKIE)?.value
  if (savedLocale === 'en' || savedLocale === 'nl') return savedLocale

  const acceptedLanguages = (await headers()).get('accept-language') ?? ''
  const preferredLanguage = acceptedLanguages.split(',')[0]?.trim().split(';')[0]
  return preferredLanguage?.toLocaleLowerCase().split(/[-_]/)[0] === 'nl' ? 'nl' : 'en'
})

export const siteLocaleCookie = LOCALE_COOKIE
