export type SiteLocale = 'en' | 'nl'

export function siteText(locale: SiteLocale, dutch: string, english: string) {
  return locale === 'nl' ? dutch : english
}
