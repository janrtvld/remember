export function isAgentDisplayUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'vnc:'
  } catch {
    return false
  }
}
