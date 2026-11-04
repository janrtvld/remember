import type { CodexClientTool } from './codexClientTools'
import { RESIDENT_MEMORY_SEARCH_LIMIT } from './residentAgentMemoryTool'
import type { createResidentArchiveSession } from './residentArchiveSession'
import { residentDataQuerySchema } from './residentDataTool'

// Every source tool uses the same turn-local read ledger. Successful reviewed
// writes rebase only their own records, before the final freshness check.
export function createResidentTurnTools({
  memory: makeMemoryTool,
  data: dataTool,
  task: taskTool,
  archive: archiveSession,
  conversation,
  onCall,
}: {
  memory(searchLimit?: number): CodexClientTool
  data: CodexClientTool
  task: CodexClientTool
  archive: ReturnType<typeof createResidentArchiveSession> | null
  conversation?: CodexClientTool
  onCall?: (name: string, input: unknown) => void
}): CodexClientTool[] {
  const memoryTool = makeMemoryTool()
  const filteredDataTool = archiveSession
    ? {
        ...dataTool,
        description:
          'Read privacy-filtered Remember data from the primary Mac. Start with day_state for the compact saved Day summary, task snapshot and changes since the previous sync; unavailable means no currently admitted sync snapshot. Read tasks for current stored status, user adoption and uncertainty; an automatically derived task is not a confirmed user commitment. For a named project, topic or issue, use query with that short name or ID before paginating tasks, overview or activity_details. These are text matches, not proof of project membership; describe missing matches as a search limitation. For details or dates without a saved snapshot, use overview: representative excerpts across apps, not exhaustive content or proof of work completed. Follow nextOffset. Use activity_details only for a specific detail, never to exhaustively scan a week. Use remember_archive for recorded conversations. Never infer conversation records from screen text or old assistant replies.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['action'],
          properties: {
            action: {
              type: 'string',
              enum: ['days', 'day_state', 'overview', 'activity', 'activity_details', 'tasks', 'notes'],
            },
            date: { type: 'string' },
            offset: { type: 'integer', minimum: 0 },
            query: residentDataQuerySchema,
          },
        },
        call: async (raw: unknown, context: Parameters<typeof dataTool.call>[1]) => {
          if ((raw as { action?: unknown })?.action === 'conversations')
            throw new Error('use-remember-archive-conversations')
          const input = structuredClone(raw)
          const result = await dataTool.call(input, context)
          archiveSession.recordOtherRead(JSON.stringify(input), result, (signal) =>
            dataTool.call(input, { ...context, signal })
          )
          return result
        },
      }
    : dataTool
  const stableMemory = (value: unknown) =>
    JSON.parse(JSON.stringify(value, (key, child) => (key === 'checkedAt' ? undefined : child))) as unknown
  const trackedMemoryTool = archiveSession
    ? {
        ...memoryTool,
        call: async (raw: unknown, context: Parameters<typeof memoryTool.call>[1]) => {
          const input = structuredClone(raw)
          const result = await memoryTool.call(input, context)
          const change = input as {
            action?: string
            spaceId: string
            slug: string
            expectedRevision: string
            before: string
            after: string
          }
          const receipt = result as { saved?: boolean; revision?: string; spaceId?: string; slug?: string }
          if (
            change.action === 'create' &&
            receipt.saved === true &&
            receipt.revision &&
            receipt.slug &&
            receipt.spaceId === change.spaceId
          )
            await archiveSession.refreshMemoryCreation(
              { spaceId: change.spaceId, slug: receipt.slug, revision: receipt.revision },
              async (request, signal) =>
                stableMemory(
                  await makeMemoryTool(RESIDENT_MEMORY_SEARCH_LIMIT + 1).call(request, { ...context, signal })
                ),
              context.signal
            )
          if (
            change.action === 'patch' &&
            receipt.saved === true &&
            receipt.revision &&
            receipt.spaceId === change.spaceId &&
            receipt.slug === change.slug
          )
            await archiveSession.refreshMemoryReads({ ...change, revision: receipt.revision }, context.signal)
          if (['spaces', 'search', 'read'].includes(String((input as { action?: unknown })?.action))) {
            archiveSession.recordOtherRead(`memory:${JSON.stringify(input)}`, stableMemory(result), async (signal) =>
              stableMemory(await makeMemoryTool().call(input, { ...context, signal }))
            )
          }
          return result
        },
      }
    : memoryTool
  const trackedTaskTool = {
    ...taskTool,
    call: async (raw: unknown, context: Parameters<typeof taskTool.call>[1]) => {
      const request = raw as { action?: string; taskId?: string }
      const before =
        archiveSession && request.action === 'update'
          ? await taskTool.call({ action: 'read', taskId: request.taskId }, context)
          : null
      const result = await taskTool.call(raw, context)
      if (archiveSession) {
        const taskId = (raw as { taskId: string }).taskId
        if ((result as { saved?: boolean }).saved && before)
          await archiveSession.refreshTaskReads(taskId, before, result, context.signal)
        const read = (signal: AbortSignal) => taskTool.call({ action: 'read', taskId }, { ...context, signal })
        archiveSession.recordOtherRead(
          `task:${taskId}`,
          request.action === 'read' ? result : await read(context.signal),
          read
        )
      }
      return result
    },
  }
  return [
    trackedMemoryTool,
    filteredDataTool,
    trackedTaskTool,
    ...(archiveSession?.tools ?? []),
    ...(conversation ? [conversation] : []),
  ].map((tool) => ({
    ...tool,
    call: async (raw, context) => {
      onCall?.(tool.name, raw)
      return tool.call(raw, context)
    },
  }))
}
