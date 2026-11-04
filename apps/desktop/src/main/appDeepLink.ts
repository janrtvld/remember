export const REMEMBER_WIKI_DEEP_LINK = 'remember://wiki'
export const REMEMBER_DEVELOPMENT_WIKI_DEEP_LINK = 'remember-development://wiki'

export type RememberDeepLink =
  | { kind: 'activate' }
  | {
      kind: 'renderer'
      rendererPath: string
    }
  | {
      kind: 'revinote-oauth'
      code: string | null
      state: string
      issuer: string | null
      error: string | null
    }

export function parseRememberDeepLink(value: string): RememberDeepLink | null {
  try {
    const url = new URL(value)
    const pathname = url.pathname || '/'
    if (
      (url.protocol !== 'remember:' && url.protocol !== 'remember-development:') ||
      url.username ||
      url.password ||
      url.hash
    )
      return null

    if (url.hostname === 'open' && pathname === '/' && !url.search) return { kind: 'activate' }

    if (url.hostname === 'wiki' && pathname === '/' && !url.search) {
      return { kind: 'renderer', rendererPath: '/wiki/' }
    }

    if (url.hostname !== 'revinote' || pathname !== '/callback') return null
    const allowed = new Set(['code', 'state', 'iss', 'error', 'error_description'])
    if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) return null
    const state = url.searchParams.get('state')?.trim() ?? ''
    const code = url.searchParams.get('code')?.trim() || null
    const error = url.searchParams.get('error')?.trim() || null
    if (!state || (!code && !error)) return null
    return {
      kind: 'revinote-oauth',
      code,
      state,
      issuer: url.searchParams.get('iss')?.trim() || null,
      error,
    }
  } catch {
    return null
  }
}
