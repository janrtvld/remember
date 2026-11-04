import type { WorkItem } from '@remember/shared'
import { REMEMBER_WORK_ITEM_CONTEXT_HEADER } from './agentTurnEnvelope'

export function buildWorkItemAgentContext(item: WorkItem) {
  return `${REMEMBER_WORK_ITEM_CONTEXT_HEADER}\n${JSON.stringify({
    title: item.title,
    description: item.description,
    context: item.context,
    returnPoint: item.returnPoint,
  })}`
}
