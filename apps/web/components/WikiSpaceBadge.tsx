import type { WikiSpaceColor, WikiSpaceIcon } from '@remember/shared'
import {
  Landmark as IconBank,
  Book as IconBook,
  Building2 as IconBuildings,
  Code as IconCode,
  Folder as IconFolder1,
  Heart as IconHeart,
  Lightbulb as IconLightBulb,
  LockKeyhole as IconLock,
  Users as IconPeople,
  Rocket as IconRocket,
  Star as IconStar,
} from 'lucide-react'
import { twMerge } from 'tailwind-merge'

const icons: Record<WikiSpaceIcon, typeof IconLock> = {
  lock: IconLock,
  book: IconBook,
  folder: IconFolder1,
  building: IconBuildings,
  code: IconCode,
  bank: IconBank,
  heart: IconHeart,
  idea: IconLightBulb,
  people: IconPeople,
  rocket: IconRocket,
  star: IconStar,
}

export const wikiSpaceIconChoices: Array<{ id: WikiSpaceIcon; label: string }> = [
  { id: 'lock', label: 'Slot' },
  { id: 'book', label: 'Boek' },
  { id: 'folder', label: 'Map' },
  { id: 'building', label: 'Organisatie' },
  { id: 'code', label: 'Code' },
  { id: 'bank', label: 'Finance' },
  { id: 'heart', label: 'Hart' },
  { id: 'idea', label: 'Idee' },
  { id: 'people', label: 'Mensen' },
  { id: 'rocket', label: 'Raket' },
  { id: 'star', label: 'Ster' },
]

export const wikiSpaceColorChoices: Array<{ id: WikiSpaceColor; label: string }> = [
  { id: 'slate', label: 'Grijs' },
  { id: 'purple', label: 'Paars' },
  { id: 'teal', label: 'Turkoois' },
  { id: 'green', label: 'Groen' },
  { id: 'amber', label: 'Geel' },
  { id: 'orange', label: 'Oranje' },
  { id: 'pink', label: 'Roze' },
  { id: 'red', label: 'Rood' },
  { id: 'sky', label: 'Blauw' },
]

const colorStyles: Record<WikiSpaceColor, { surface: string; foreground: string; swatch: string }> = {
  slate: {
    surface: 'bg-[oklch(var(--categorical-grey)/0.16)]',
    foreground: 'text-[oklch(var(--categorical-grey))]',
    swatch: 'bg-[oklch(var(--categorical-grey))]',
  },
  purple: {
    surface: 'bg-[oklch(var(--categorical-purple)/0.16)]',
    foreground: 'text-[oklch(var(--categorical-purple))]',
    swatch: 'bg-[oklch(var(--categorical-purple))]',
  },
  teal: {
    surface: 'bg-[oklch(var(--categorical-teal)/0.16)]',
    foreground: 'text-[oklch(var(--categorical-teal))]',
    swatch: 'bg-[oklch(var(--categorical-teal))]',
  },
  green: {
    surface: 'bg-[oklch(var(--categorical-green)/0.16)]',
    foreground: 'text-[oklch(var(--categorical-green))]',
    swatch: 'bg-[oklch(var(--categorical-green))]',
  },
  amber: {
    surface: 'bg-[oklch(var(--categorical-yellow)/0.16)]',
    foreground: 'text-[oklch(var(--categorical-yellow))]',
    swatch: 'bg-[oklch(var(--categorical-yellow))]',
  },
  orange: {
    surface: 'bg-[oklch(var(--categorical-orange)/0.16)]',
    foreground: 'text-[oklch(var(--categorical-orange))]',
    swatch: 'bg-[oklch(var(--categorical-orange))]',
  },
  pink: {
    surface: 'bg-[oklch(var(--categorical-pink)/0.16)]',
    foreground: 'text-[oklch(var(--categorical-pink))]',
    swatch: 'bg-[oklch(var(--categorical-pink))]',
  },
  red: {
    surface: 'bg-[oklch(var(--categorical-red)/0.16)]',
    foreground: 'text-[oklch(var(--categorical-red))]',
    swatch: 'bg-[oklch(var(--categorical-red))]',
  },
  sky: {
    surface: 'bg-[oklch(var(--categorical-blue)/0.16)]',
    foreground: 'text-[oklch(var(--categorical-blue))]',
    swatch: 'bg-[oklch(var(--categorical-blue))]',
  },
}

export function WikiSpaceGlyph({
  icon,
  color,
  className,
}: {
  icon: WikiSpaceIcon
  color: WikiSpaceColor
  className?: string
}) {
  const Icon = icons[icon]
  return <Icon className={twMerge('shrink-0', colorStyles[color].foreground, className)} aria-hidden="true" />
}

export function WikiSpaceBadge({
  icon,
  color,
  className,
  iconClassName,
}: {
  icon: WikiSpaceIcon
  color: WikiSpaceColor
  className?: string
  iconClassName?: string
}) {
  return (
    <span
      className={twMerge('flex shrink-0 items-center justify-center rounded-lg', colorStyles[color].surface, className)}
      aria-hidden="true"
    >
      <WikiSpaceGlyph icon={icon} color={color} className={iconClassName} />
    </span>
  )
}

export function wikiSpaceColorSwatch(color: WikiSpaceColor) {
  return colorStyles[color].swatch
}
