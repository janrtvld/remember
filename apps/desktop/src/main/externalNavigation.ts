/** Renderer content may open web pages and mail, but must not invoke arbitrary OS handlers. */
export function externalNavigationUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (!['https:', 'http:', 'mailto:'].includes(url.protocol) || url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}
