import type { AssistantConversation, AssistantTaskDraft } from '@remember/shared'
import type { createResidentAgentService } from './residentAgentService'

type TaskComponent = {
  snapshot(before?: unknown): Promise<AssistantConversation>
  draft(input: unknown): Promise<AssistantTaskDraft>
  send(input: unknown): Promise<AssistantConversation>
  control(input: unknown): Promise<AssistantConversation>
  ownsMessage(messageId: string): boolean
  prepareForDeletion(): Promise<void>
  dispose(): Promise<void>
}

export function taskStatusContext(conversation: AssistantConversation) {
  return conversation.messages
    .flatMap((message) =>
      message.taskAction
        ? [
            {
              actionId: message.taskAction.actionId,
              messageId: message.id,
              state: message.taskAction.state,
              connection: message.taskAction.connection,
            },
          ]
        : []
    )
    .slice(-20)
}

export function createResidentConversationOwner({
  chat,
  tasks,
  onTaskInput,
}: {
  chat: ReturnType<typeof createResidentAgentService>
  tasks: TaskComponent
  onTaskInput(): void
}) {
  let disposed = false
  let closing: Promise<void> | null = null
  const available = () => {
    if (disposed) throw new Error('assistant-unavailable')
  }
  const snapshot = async (before?: string): Promise<AssistantConversation> => {
    available()
    const taskConversation = await tasks.snapshot(before)
    available()
    const conversation = chat.snapshot(before)
    const actions = new Map(taskConversation.messages.map((message) => [message.id, message.taskAction]))
    return {
      ...conversation,
      execution: 'local',
      taskActionsEnabled: true,
      sharedTaskChat: true,
      activeTaskAction: taskConversation.activeTaskAction ?? null,
      messages: conversation.messages.map((message) => ({ ...message, taskAction: actions.get(message.id) })),
    }
  }
  return {
    snapshot,
    async send(input: unknown) {
      available()
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid-assistant-message')
      const data = input as Record<string, unknown>
      const task = Object.hasOwn(data, 'task')
      const keys = task
        ? ['text', 'provider', 'task']
        : [
            'text',
            'provider',
            ...(Object.hasOwn(data, 'mode') ? ['mode'] : []),
            ...(Object.hasOwn(data, 'clientMessageId') ? ['clientMessageId'] : []),
          ]
      if (
        Object.keys(data).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(data, key)) ||
        typeof data.text !== 'string' ||
        data.provider !== 'codex'
      )
        throw new Error('invalid-assistant-message')
      if (task) {
        const current = chat.snapshot()
        if (
          current.remoteRecoveryRequired ||
          (current.hostJob && !['completed', 'stopped'].includes(current.hostJob.phase))
        )
          throw new Error('assistant-remote-recovery-required')
        if (
          !data.task ||
          typeof data.task !== 'object' ||
          Array.isArray(data.task) ||
          Object.keys(data.task).length !== 1 ||
          typeof (data.task as { token?: unknown }).token !== 'string'
        )
          throw new Error('host-task-input-invalid')
        onTaskInput()
        await tasks.send({
          text: data.text,
          provider: 'codex',
          task: { token: (data.task as { token: string }).token },
        })
      } else {
        chat.send({
          text: data.text,
          provider: 'codex',
          ...(Object.hasOwn(data, 'mode') ? { mode: data.mode } : {}),
          ...(Object.hasOwn(data, 'clientMessageId') ? { clientMessageId: data.clientMessageId } : {}),
        })
      }
      return snapshot()
    },
    async draft(input: unknown) {
      available()
      return tasks.draft(input)
    },
    async control(input: unknown) {
      available()
      await tasks.control(input)
      return snapshot()
    },
    async retry(messageId: unknown) {
      available()
      if (typeof messageId !== 'string') throw new Error('invalid-assistant-message')
      if (tasks.ownsMessage(messageId)) throw new Error('host-task-exact-control-required')
      if (chat.snapshot().remoteRecoveryMessageId === messageId) throw new Error('assistant-remote-recovery-required')
      chat.retry(messageId)
      return snapshot()
    },
    async cancel(messageId?: string) {
      available()
      await chat.cancel(messageId)
      return snapshot()
    },
    async prepareForDeletion() {
      available()
      await chat.prepareForDeletion()
      await tasks.prepareForDeletion()
    },
    dispose() {
      if (closing) return closing
      disposed = true
      closing = (async () => {
        try {
          await tasks.dispose()
        } finally {
          await chat.dispose()
        }
      })()
      return closing
    },
  }
}
