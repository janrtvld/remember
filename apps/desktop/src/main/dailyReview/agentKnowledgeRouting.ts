import type { WikiPageUpdate, WikiSpace } from '@remember/shared'
import { KNOWLEDGE_ORGANIZATION_INSTRUCTIONS } from '../knowledgeOrganization'

export type AgentKnowledgeSpace = Pick<WikiSpace, 'id' | 'name' | 'description' | 'maintenanceMode'>

/** Keep a model-selected destination explicit through review and persistence. */
export function groupAgentKnowledgeUpdatesBySpace(updates: WikiPageUpdate[], spaces: AgentKnowledgeSpace[]) {
  const destinations = new Map(spaces.map((space) => [space.id, space]))
  const groups = new Map<string, WikiPageUpdate[]>()
  for (const update of updates) {
    const space = update.suggestedSpaceId ? destinations.get(update.suggestedSpaceId) : undefined
    if (!space) throw new Error('agent-learning-invalid-destination')
    groups.set(space.id, [...(groups.get(space.id) ?? []), update])
  }
  return groups
}

/** An omitted verdict is incomplete review, not evidence that a finding was rejected. */
export function agentKnowledgeReviewRejections(value: unknown, candidateCount: number) {
  if (!value || typeof value !== 'object' || !('accepted' in value) || !('rejected' in value))
    throw new Error('agent-learning-incomplete-review')
  if (!Array.isArray(value.accepted) || !Array.isArray(value.rejected))
    throw new Error('agent-learning-incomplete-review')
  const seen = new Set<number>()
  for (const verdict of [...value.accepted, ...value.rejected]) {
    if (
      !verdict ||
      !Number.isInteger(verdict.index) ||
      verdict.index < 0 ||
      verdict.index >= candidateCount ||
      seen.has(verdict.index)
    )
      throw new Error('agent-learning-incomplete-review')
    seen.add(verdict.index)
  }
  if (seen.size !== candidateCount) throw new Error('agent-learning-incomplete-review')
  return value.rejected.map((verdict) => {
    if (typeof verdict.reason !== 'string' || !verdict.reason.trim())
      throw new Error('agent-learning-incomplete-review')
    return { index: verdict.index as number, reason: verdict.reason.trim() }
  })
}

export function agentKnowledgeRoutingPrompt(spaces: AgentKnowledgeSpace[]) {
  return `${KNOWLEDGE_ORGANIZATION_INSTRUCTIONS}

Choose the destination for each individual finding from wiki_spaces. No folder mapping or project assignment is required. Conversation titles and working directories are weak context; use the actual evidence to choose the relevant Space.
Use the space's name, description, existing knowledge and the original conversation to establish where the finding belongs. A conversation can yield findings in different spaces and categories. Use projects/, decisions/, research/, people/, processes/, or concepts/ as appropriate. General company research does not need a project; use the company's research category. Put project-specific findings under that project's existing root in the appropriate space.
Set suggestedSpaceId to the exact destination id for EVERY returned page, including personal. Never invent a space. Page identity is the pair (spaceId, slug): the same slug can belong to different spaces. Reuse an existing subject within its destination space, never merge or copy pages across spaces just because their names match.
Keep personal preferences and general exploration in Personal. Choose a project or topic Space when the finding clearly belongs there. When the destination is ambiguous, retain useful knowledge in Personal. Store relevant durable findings, not raw conversations or incidental details. Preserve research sources and uncertainty. An assistant proposal is not a confirmed decision.
If the intended destination is unavailable, defer the source rather than create a replacement in another space. The application validates the destination and follows each space's Auto or Suggestions setting; you cannot change those settings.
<wiki_spaces>
${JSON.stringify(spaces)}
</wiki_spaces>`
}
