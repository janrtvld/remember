export function readLocalStorageJson(key: string): unknown | null {
  if (typeof window === 'undefined') return null
  try {
    const value = window.localStorage.getItem(key)
    return value ? JSON.parse(value) : null
  } catch {
    return null
  }
}

export function writeLocalStorageJson(key: string, value: unknown) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    return
  }
}

export function removeLocalStorageItem(key: string) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(key)
  } catch {
    return
  }
}

export function removeLocalStorageItemsWhere(matches: (key: string) => boolean) {
  if (typeof window === 'undefined') return
  try {
    const keys = Object.keys(window.localStorage)
    const current = window.localStorage
    for (const key of keys) if (matches(key)) current.removeItem(key)
  } catch {
    return
  }
}
