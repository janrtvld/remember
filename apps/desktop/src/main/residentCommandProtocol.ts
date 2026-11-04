import { createHash } from 'node:crypto'
import type { AgentTurnStep, AssistantMessageStatus, RemoteAgentComputer } from '@remember/shared'
import { agentComputerExecutionKey, normalizeAgentComputer } from '@remember/shared'
import type { CodexRemoteCheckpoint } from './codexRemoteRecovery'
import { canonicalHostTaskJson } from './hostTaskProtocol'

export type ResidentCommandState =
  | 'reserved'
  | 'dispatching'
  | 'running'
  | 'unknown'
  | 'completed'
  | 'stopped'
  | 'cancelled'

export type ResidentCommandCheckpoint = CodexRemoteCheckpoint & {
  messageId: string
  contextInvalidated?: boolean
}

export type ResidentCommand = {
  messageId: string
  userMessageId: string
  instructionHash: string
  computer: RemoteAgentComputer
  executionKey: string
  targetLabel: string
  state: ResidentCommandState
  stopRequested: boolean
  contextInvalidated: boolean
  checkpoint: ResidentCommandCheckpoint | null
  settled: boolean
  createdAt: number
  updatedAt: number
}

export type ResidentCommandPatch = {
  text: string
  steps: AgentTurnStep[]
  status: AssistantMessageStatus
  error?: string | null
}
export type ResidentCommandConfirmation = 'completed' | 'stopped' | 'unsubmitted' | 'unknown'

export function commandTerminal(command: ResidentCommand) {
  return ['completed', 'stopped', 'cancelled'].includes(command.state)
}

export function commandInput(text: string, computer: RemoteAgentComputer, targetLabel: string) {
  if (typeof text !== 'string' || !text.trim() || text.length > 100_000)
    throw new Error('assistant-command-instruction-invalid')
  const target = normalizeAgentComputer(computer)
  if (target.kind !== 'remote') throw new Error('assistant-command-target-invalid')
  if (typeof targetLabel !== 'string' || !targetLabel.trim() || targetLabel.length > 200)
    throw new Error('assistant-command-target-invalid')
  const instruction = text.trim()
  return {
    instruction,
    instructionHash: createHash('sha256').update(instruction).digest('hex'),
    computer: target,
    executionKey: agentComputerExecutionKey(target),
    targetLabel: targetLabel.trim(),
  }
}

const identifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200 && value === value.trim()

export function commandCheckpoint(command: ResidentCommand, input: ResidentCommandCheckpoint) {
  const value = JSON.parse(canonicalHostTaskJson(input)) as ResidentCommandCheckpoint
  const target = normalizeAgentComputer(value.computer)
  const previous = command.checkpoint
  if (
    Object.keys(value).some(
      (key) =>
        ![
          'messageId',
          'computer',
          'threadId',
          'turnId',
          'previousTurnId',
          'commandItemIds',
          'contextInvalidated',
        ].includes(key)
    ) ||
    value.messageId !== command.messageId ||
    target.kind !== 'remote' ||
    canonicalHostTaskJson(target) !== canonicalHostTaskJson(command.computer) ||
    !identifier(value.threadId) ||
    (value.turnId !== null && !identifier(value.turnId)) ||
    value.previousTurnId !== null ||
    (value.contextInvalidated !== undefined && typeof value.contextInvalidated !== 'boolean') ||
    (value.commandItemIds !== undefined &&
      (!Array.isArray(value.commandItemIds) ||
        value.commandItemIds.length > 1000 ||
        !value.commandItemIds.every(identifier) ||
        new Set(value.commandItemIds).size !== value.commandItemIds.length)) ||
    (previous &&
      (previous.threadId !== value.threadId ||
        (previous.turnId !== null && previous.turnId !== value.turnId) ||
        previous.commandItemIds?.some((id) => !value.commandItemIds?.includes(id))))
  )
    throw new Error('assistant-command-checkpoint-conflict')
  return { ...value, computer: command.computer, ...(command.contextInvalidated ? { contextInvalidated: true } : {}) }
}

export function commandPatch(input: ResidentCommandPatch): Required<ResidentCommandPatch> {
  const value = JSON.parse(
    canonicalHostTaskJson({ text: input.text, steps: input.steps, status: input.status, error: input.error ?? null })
  )
  if (
    typeof value.text !== 'string' ||
    value.text.length > 1_000_000 ||
    !Array.isArray(value.steps) ||
    value.steps.length > 1000 ||
    !['streaming', 'completed', 'failed', 'cancelled', 'interrupted'].includes(value.status) ||
    (value.error !== null && typeof value.error !== 'string') ||
    value.steps.some(
      (step: AgentTurnStep) =>
        !step ||
        !identifier(step.id) ||
        !['status', 'reasoning'].includes(step.kind) ||
        typeof step.text !== 'string' ||
        !Number.isSafeInteger(step.at) ||
        step.at < 0
    )
  )
    throw new Error('assistant-command-patch-invalid')
  return value
}
