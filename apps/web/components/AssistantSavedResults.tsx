import type { AssistantResult } from '@remember/shared'
import { AssistantReferenceCard } from './AssistantReferenceCard'
import { wikiPageHref } from './wikiRoutes'

export function AssistantSavedResults({
  results,
  label,
}: {
  results?: AssistantResult[]
  label: string
  openLabel: string
}) {
  if (!results?.length) return null
  return (
    <ul aria-label={label} className="mt-3 flex flex-wrap">
      {results.map((result) => (
        <li key={result.id} className="min-w-0">
          <AssistantReferenceCard
            reference={{
              kind: 'document',
              spaceId: result.spaceId,
              slug: result.slug,
              href: wikiPageHref(result.spaceId, result.slug),
            }}
          >
            {result.title}
          </AssistantReferenceCard>
        </li>
      ))}
    </ul>
  )
}
