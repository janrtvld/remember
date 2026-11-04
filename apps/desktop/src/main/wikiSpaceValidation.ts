import { WIKI_SPACE_COLORS, WIKI_SPACE_ICONS, type WikiSpaceColor, type WikiSpaceIcon } from '@remember/shared'

const WIKI_SPACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isWikiSpaceId(value: unknown): value is string {
  return typeof value === 'string' && WIKI_SPACE_ID_PATTERN.test(value)
}

export function normalizeWikiSpaceName(value: unknown) {
  if (typeof value !== 'string') return null
  const name = value.replace(/\s+/g, ' ').trim()
  return name && name.length <= 80 ? name : null
}

export function normalizeWikiSpaceDescription(value: unknown) {
  if (typeof value !== 'string') return null
  const description = value.replace(/\s+/g, ' ').trim()
  return description.length <= 280 ? description : null
}

export function isWikiSpaceIcon(value: unknown): value is WikiSpaceIcon {
  return typeof value === 'string' && WIKI_SPACE_ICONS.some((icon) => icon === value)
}

export function isWikiSpaceColor(value: unknown): value is WikiSpaceColor {
  return typeof value === 'string' && WIKI_SPACE_COLORS.some((color) => color === value)
}
