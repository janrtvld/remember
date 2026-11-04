export function requestedRevinoteOAuthScopes(scopesSupported?: readonly string[]) {
  const scopes = ['meetings:read']
  if (scopesSupported?.includes('meetings:write')) scopes.push('meetings:write')
  scopes.push('offline_access')
  return scopes
}
