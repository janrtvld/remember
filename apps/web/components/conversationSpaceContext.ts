import type { WikiPage, WikiSpace } from '@remember/shared'
import { wikiHomeHref, wikiPageHref } from './wikiRoutes'

export interface ConversationSpaceContext {
  spaceId: string
  pageSlug?: string
}

export interface ManualMeetingSpaceContext extends ConversationSpaceContext {
  sourceRevision?: string
}

const activeMeetingContextKey = 'remember:active-meeting-space'
const pendingSourceCreations = new Map<string, Promise<ManualMeetingSpaceContext | null>>()
const preservedSources = new Set<string>()

function sourceKey(context: ConversationSpaceContext) {
  return `${context.spaceId}\u0000${context.pageSlug ?? ''}`
}

export function conversationSpaceContext(params: Pick<URLSearchParams, 'get'>): ConversationSpaceContext | null {
  const spaceId = params.get('space')?.trim()
  if (!spaceId) return null
  const pageSlug = params.get('document')?.trim()
  return { spaceId, ...(pageSlug ? { pageSlug } : {}) }
}

export function withConversationSpaceContext(href: string, context: ConversationSpaceContext | null) {
  if (!context) return href
  const [pathname, query = ''] = href.split('?')
  const params = new URLSearchParams(query)
  params.set('space', context.spaceId)
  if (context.pageSlug) params.set('document', context.pageSlug)
  else params.delete('document')
  return `${pathname}?${params.toString()}`
}

/** A navigation hint never grants access to a Space or its source audio. */
export function conversationSpaceDestination(
  context: ConversationSpaceContext | null,
  spaces: WikiSpace[],
  pagesBySpace: Record<string, WikiPage[]>
) {
  const space = context && spaces.find((candidate) => candidate.id === context.spaceId)
  if (!space) return null
  const page = pagesBySpace[space.id]?.find((candidate) => candidate.slug === context.pageSlug)
  return {
    space,
    page,
    href: page ? wikiPageHref(space.id, page.slug) : wikiHomeHref(space.id),
  }
}

/** Keep only the current recording's navigation origin, including across a renderer reload. */
export function saveManualMeetingSpaceContext(meetingId: string, context: ManualMeetingSpaceContext) {
  try {
    window.localStorage.setItem(activeMeetingContextKey, JSON.stringify({ meetingId, ...context }))
  } catch {
    // The source document and its contextual link remain the durable reference if storage is unavailable.
  }
}

export function readManualMeetingSpaceContext(meetingId: string): ManualMeetingSpaceContext | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(activeMeetingContextKey) ?? 'null')
    if (value?.meetingId !== meetingId || typeof value.spaceId !== 'string' || !value.spaceId.trim()) return null
    return {
      spaceId: value.spaceId,
      ...(typeof value.pageSlug === 'string' && value.pageSlug.trim() ? { pageSlug: value.pageSlug } : {}),
      ...(typeof value.sourceRevision === 'string' && value.sourceRevision && !preservedSources.has(sourceKey(value))
        ? { sourceRevision: value.sourceRevision }
        : {}),
    }
  } catch {
    return null
  }
}

/** Revoke automatic cleanup on the first edit, before debounced autosave can run. */
export function preserveManualMeetingSource(spaceId: string, pageSlug: string) {
  if (!/^meetings\/[^/]+$/.test(pageSlug)) return
  preservedSources.add(sourceKey({ spaceId, pageSlug }))
  try {
    const value = JSON.parse(window.localStorage.getItem(activeMeetingContextKey) ?? 'null')
    if (value?.spaceId !== spaceId || value?.pageSlug !== pageSlug || typeof value.meetingId !== 'string') return
    saveManualMeetingSpaceContext(value.meetingId, { spaceId, pageSlug })
  } catch {
    // The in-memory veto still protects a draft when storage is temporarily unavailable.
  }
}

export async function trackManualMeetingSourceCreation(
  meetingId: string,
  creation: Promise<ManualMeetingSpaceContext | null>
) {
  pendingSourceCreations.set(meetingId, creation)
  try {
    await creation
  } finally {
    if (pendingSourceCreations.get(meetingId) === creation) pendingSourceCreations.delete(meetingId)
  }
}

/** Capture before native discard releases the recording slot to the next meeting. */
export function captureManualMeetingSourceContext(meetingId: string) {
  const origin = readManualMeetingSpaceContext(meetingId)
  const creation = pendingSourceCreations.get(meetingId)
  return {
    origin,
    async resolve() {
      const created = await creation
      if (!origin) return null
      const context = created ?? origin
      if (!preservedSources.has(sourceKey(context))) return context
      return { spaceId: context.spaceId, pageSlug: context.pageSlug }
    },
  }
}

export function clearManualMeetingSpaceContext(meetingId: string) {
  const context = readManualMeetingSpaceContext(meetingId)
  if (!context) return
  try {
    window.localStorage.removeItem(activeMeetingContextKey)
    preservedSources.delete(sourceKey(context))
  } catch {
    // A discarded recording must still be discarded when browser storage is unavailable.
  }
}
