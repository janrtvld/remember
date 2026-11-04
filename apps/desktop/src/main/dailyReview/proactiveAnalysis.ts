import type { AgentProvider } from '@remember/shared'
import { findAgentExecutable } from '../agent'
import { getUserName } from '../userName'
import { parseClaudeResponse, parseJsonResponse } from './agentResponse'
import { runAgentReliably } from './analyzer'
import {
  PROACTIVE_EFFORT,
  type ProactiveContextInput,
  parseProactivePlan,
  proactiveModelContract,
  projectProactiveContext,
} from './proactivePolicy'

export async function analyzeProactiveContext(
  input: ProactiveContextInput & {
    provider: AgentProvider
    model: string
    signal: AbortSignal
  }
) {
  if (input.provider !== 'codex') throw new Error('proactive-provider-unsupported')
  input.signal.throwIfAborted()
  const executable = findAgentExecutable(input.provider)
  if (!executable) throw new Error('agent-cli-missing')
  const snapshot: ProactiveContextInput = structuredClone({
    evidence: input.evidence,
    items: input.items,
    locale: input.locale,
    now: input.now,
    timeZone: input.timeZone,
    conversation: input.conversation,
    followUpMemory: input.followUpMemory,
    userName: input.userName,
    agentComputer: input.agentComputer ?? null,
    ...(input.briefingCandidateSourceIds === undefined
      ? {}
      : { briefingCandidateSourceIds: input.briefingCandidateSourceIds }),
  })
  snapshot.userName ??= await getUserName()
  input.signal.throwIfAborted()
  const projection = projectProactiveContext(snapshot)
  const contract = proactiveModelContract(snapshot)
  const parse = (value: unknown) => parseProactivePlan(value, snapshot)
  return runAgentReliably(
    {
      executable,
      provider: input.provider,
      signal: input.signal,
      toolsDisabled: true,
      retryInvalidResponse: false,
      modelOverride: { provider: 'codex', model: input.model, effort: PROACTIVE_EFFORT },
      schema: contract.schema,
      systemPrompt: contract.systemPrompt,
      prompt: JSON.stringify(projection),
      parseOutput: {
        claude: (output) => parse(parseClaudeResponse(output)),
        codex: (output) => parse(parseJsonResponse(output)),
      },
    },
    { phase: 'final', shardIndex: null, shardCount: null }
  )
}
