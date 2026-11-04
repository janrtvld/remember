import type { BriefingOutput } from '../proactive-agent/briefing-models/validateOutput.mjs'
import type { BriefingDescriptor, BriefingExecution, BriefingSlot, BriefingSpec } from './briefing-protocol.mjs'
export function renderBriefingMarkdown(output: BriefingOutput): string | null
export type BriefingExecutor = {
  run(
    spec: BriefingSpec,
    controls: { signal: AbortSignal; onExecution(value: BriefingExecution): void }
  ): Promise<{ rawOutput: string; execution: BriefingExecution; usage?: Record<string, number> }>
}
export function createBriefingHost(options: {
  descriptor?: BriefingDescriptor
  slot?: BriefingSlot
  executor: BriefingExecutor
  clock?: () => number
  monotonic?: () => number
  fault?: (point: string) => void
}): {
  request(method: string, payload: unknown): Promise<unknown>
  socketPath: string
  listen(): Promise<string>
  close(): Promise<void>
}
