import type { HostTaskRuntime } from './hostTaskRuntime'

type Runtime = Pick<HostTaskRuntime, 'snapshot' | 'draft' | 'send' | 'control' | 'prepareForDeletion'>
function object(value: unknown, keys: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('host-task-input-invalid')
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key)))
    throw new Error('host-task-input-invalid')
  return record
}

function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 200 || value.includes('\0'))
    throw new Error('host-task-input-invalid')
}

/** Parsing happens before readiness; a renderer cannot mutate an admitted payload during that await. */
export function createHostTaskNativeFacade(input: {
  ready: Promise<Runtime>
  ownsMessage(messageId: string): boolean
  disposed(): boolean
  dispose(): Promise<void>
}) {
  const alive = () => {
    if (input.disposed()) throw new Error('host-task-disposed')
  }
  const runtime = async () => {
    alive()
    const owner = await input.ready
    alive()
    return owner
  }
  return {
    async snapshot(before?: unknown) {
      if (before !== undefined) identifier(before)
      return (await runtime()).snapshot(before)
    },
    async draft(id: unknown) {
      identifier(id)
      return (await runtime()).draft(id)
    },
    async send(value: unknown) {
      const data = object(value, ['text', 'provider', 'task'])
      const task = object(data.task, ['token'])
      identifier(task.token)
      if (typeof data.text !== 'string' || data.provider !== 'codex') throw new Error('host-task-input-invalid')
      const parsed = { token: task.token, text: data.text }
      return (await runtime()).send(parsed)
    },
    async control(value: unknown) {
      const data = object(value, ['actionId', 'messageId', 'command'])
      identifier(data.actionId)
      identifier(data.messageId)
      if (data.command !== 'check' && data.command !== 'stop' && data.command !== 'cancel')
        throw new Error('host-task-input-invalid')
      const parsed: Parameters<Runtime['control']>[0] = {
        actionId: data.actionId,
        messageId: data.messageId,
        command: data.command,
      }
      return (await runtime()).control(parsed)
    },
    ownsMessage(messageId: string) {
      alive()
      identifier(messageId)
      return input.ownsMessage(messageId)
    },
    async prepareForDeletion() {
      await (await runtime()).prepareForDeletion()
    },
    dispose: input.dispose,
  }
}
