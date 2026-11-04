import type { AppLocale } from '@remember/shared'

export function localText(locale: AppLocale, dutch: string, english: string) {
  return locale === 'nl' ? dutch : english
}
