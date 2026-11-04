import type { AgentProvider, WorkItem } from '@remember/shared'
import { findAgentExecutable } from '../agent'
import { getUserName } from '../userName'
import { parseClaudeResponse, parseJsonResponse } from './agentResponse'
import { AMBIENT_TASK_SCHEMA, parseAmbientTaskPlan } from './ambientTaskPolicy'
import { AMBIENT_TASK_SYSTEM_PROMPT, ambientTaskPrompt } from './ambientTaskPrompt'
import type { AmbientEvidence } from './ambientTaskStore'
import { runAgentReliably } from './analyzer'

export async function analyzeAmbientTasks(
  evidence: AmbientEvidence[],
  items: WorkItem[],
  provider: AgentProvider,
  language: 'en' | 'nl',
  signal: AbortSignal
) {
  const executable = findAgentExecutable(provider)
  if (!executable) throw new Error('agent-cli-missing')
  const userName = await getUserName()
  const parse = (value: unknown) => parseAmbientTaskPlan(value, evidence, userName, items)
  return runAgentReliably(
    {
      executable,
      provider,
      signal,
      toolsDisabled: true,
      schema: AMBIENT_TASK_SCHEMA,
      systemPrompt: AMBIENT_TASK_SYSTEM_PROMPT,
      prompt: ambientTaskPrompt(evidence, items, userName, language),
      parseOutput: {
        claude: (output) => parse(parseClaudeResponse(output)),
        codex: (output) => parse(parseJsonResponse(output)),
      },
    },
    { phase: 'final', shardIndex: null, shardCount: null }
  )
}
