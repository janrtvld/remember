import { ChevronRight as IconChevronRight } from 'lucide-react'

export function BreadcrumbSeparator() {
  return (
    <li aria-hidden="true" className="flex shrink-0 items-center text-current">
      <IconChevronRight className="size-2.5" />
    </li>
  )
}
