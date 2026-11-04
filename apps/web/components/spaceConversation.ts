import type { DeleteWikiPageInput, SaveWikiPageInput, WikiPage } from '@remember/shared'
import { type ManualMeetingSpaceContext, withConversationSpaceContext } from './conversationSpaceContext'
import { manualMeetingPendingHref } from './manualMeetingConversation'

export const SPACE_CONVERSATION_PRIVACY_NOTE =
  'Deze bron blijft lokaal beschikbaar voor de eigenaar. Deel relevante passages afzonderlijk en bewust.'

export type SpaceConversationSource =
  | { kind: 'conversation'; dayId: string; conversationReference: string; href: string }
  | { kind: 'pending'; meetingId: string; href: string }

export function discardableManualMeetingSource(
  meetingId: string,
  context: ManualMeetingSpaceContext | null,
  pages: WikiPage[]
): DeleteWikiPageInput | null {
  if (!context?.sourceRevision || context.pageSlug !== `meetings/${meetingId}`) return null
  const page = pages.find((candidate) => candidate.slug === context.pageSlug)
  if (!page || page.revision !== context.sourceRevision) return null
  if (pages.some((candidate) => candidate.slug.startsWith(`${page.slug}/`))) return null
  const source = spaceConversationSource(page, context.spaceId)
  if (source?.kind !== 'pending' || source.meetingId !== meetingId) return null
  return { spaceId: context.spaceId, slug: page.slug, expectedRevision: context.sourceRevision, onlyIfLeaf: true }
}

export function discardedManualMeetingSourceUpdate(
  meetingId: string,
  context: ManualMeetingSpaceContext | null,
  pages: WikiPage[],
  discardedLabel: string
): SaveWikiPageInput | null {
  if (context?.pageSlug !== `meetings/${meetingId}`) return null
  const page = pages.find((candidate) => candidate.slug === context.pageSlug)
  if (!page?.revision) return null
  const sourceLink = `[Open opname en transcript](${manualMeetingPendingHref(meetingId, context)})`
  if (!page.content.includes(sourceLink)) return null
  const paragraphs = page.content.split(/(\r?\n[ \t]*\r?\n)/)
  for (let index = 0; index < paragraphs.length; index += 2) {
    if (paragraphs[index] === sourceLink && paragraphs[index + 2] === SPACE_CONVERSATION_PRIVACY_NOTE) {
      paragraphs.splice(index + 1, 2)
    }
  }
  return {
    spaceId: context.spaceId,
    slug: page.slug,
    title: page.title,
    content: paragraphs.join('').replaceAll(sourceLink, discardedLabel),
    expectedRevision: page.revision,
    strictRevision: true,
  }
}

/** Only bypass untouched source stubs; a page with user notes remains a document. */
export function spaceConversationSource(
  page: Pick<WikiPage, 'slug' | 'content'>,
  spaceId: string,
  allPages: readonly Pick<WikiPage, 'slug'>[] = []
): SpaceConversationSource | null {
  if (
    !/^meetings\/[^/\s]+$/.test(page.slug) ||
    allPages.some((candidate) => candidate.slug.startsWith(`${page.slug}/`))
  )
    return null
  const sections = page.content
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n\s*\n/)
  if (sections.length > 2 || (sections.length === 2 && sections[1] !== SPACE_CONVERSATION_PRIVACY_NOTE)) return null

  const link = sections[0]?.match(/^\[Open opname en transcript\]\(([^\s)]+)\)$/)?.[1]
  if (!link || !/^\/conversations\/(?:conversation|pending)\/\?/.test(link)) return null

  let url: URL
  try {
    url = new URL(link, 'http://remember.local')
  } catch {
    return null
  }
  if (url.origin !== 'http://remember.local' || url.hash) return null
  const pending = url.pathname === '/conversations/pending/'
  if (!pending && url.pathname !== '/conversations/conversation/') return null
  const allowedKeys = new Set(pending ? ['meeting', 'space', 'document'] : ['id', 'conversation', 'space', 'document'])
  for (const [key, value] of url.searchParams) {
    if (!allowedKeys.has(key) || url.searchParams.getAll(key).length !== 1 || /\p{Cc}/u.test(value)) {
      return null
    }
  }

  const context = { spaceId, pageSlug: page.slug }
  if (pending) {
    const meetingId = url.searchParams.get('meeting')
    if (!meetingId?.trim() || meetingId !== page.slug.slice('meetings/'.length)) return null
    const href = withConversationSpaceContext(
      `/conversations/pending/?${new URLSearchParams({ meeting: meetingId })}`,
      context
    )
    return { kind: 'pending', meetingId, href }
  }

  const dayId = url.searchParams.get('id')
  const conversationReference = url.searchParams.get('conversation')
  if (!dayId?.trim() || !conversationReference?.trim()) return null
  const href = withConversationSpaceContext(
    `/conversations/conversation/?${new URLSearchParams({ id: dayId, conversation: conversationReference })}`,
    context
  )
  return { kind: 'conversation', dayId, conversationReference, href }
}
