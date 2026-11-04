'use client'

import { useSearchParams } from 'next/navigation'
import { type WikiRoute, WikiView } from './WikiView'
import { wikiSpaceId } from './wikiRoutes'

type WikiRouteKind = WikiRoute['kind']

export function WikiRouteView({ kind }: { kind: WikiRouteKind }) {
  const params = useSearchParams()
  const spaceId = wikiSpaceId(params.get('space'))

  if (kind === 'category') {
    return <WikiView route={{ kind, spaceId, category: params.get('category') ?? '' }} />
  }
  if (kind === 'page') {
    return <WikiView route={{ kind, spaceId, slug: params.get('slug') ?? '' }} />
  }
  return <WikiView route={{ kind, spaceId }} />
}
