const fallbackSiteUrl = 'https://www.remember.computer'

export const siteUrl = new URL(process.env.SITE_URL?.trim() || fallbackSiteUrl)

export function absoluteSiteUrl(path = '/') {
  return new URL(path, siteUrl).toString()
}
