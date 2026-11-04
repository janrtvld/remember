import type { AgentInteraction, AgentInteractionAnswer } from '@remember/shared'

type Ask = (
  request: Pick<AgentInteraction, 'title' | 'detail' | 'fields' | 'actions' | 'url'>
) => Promise<AgentInteractionAnswer>
export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
const string = (value: unknown) => (typeof value === 'string' ? value : '')
const actions: AgentInteraction['actions'] = [
  { id: 'accept', label: 'Toestaan' },
  { id: 'decline', label: 'Weigeren' },
]

// Keep provider request payloads in the main process. The renderer returns only
// a decision/input, never arbitrary permission grants or JSON-RPC responses.
export async function answerCodexWorkerRequest(method: string, raw: unknown, ask: Ask): Promise<unknown> {
  const params = object(raw)
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
    const allowed = Array.isArray(params.availableDecisions) ? params.availableDecisions : ['accept', 'decline']
    const answer = await ask({
      title: method.includes('commandExecution')
        ? 'Codex vraagt toestemming voor een opdracht'
        : 'Codex vraagt toestemming om bestanden te wijzigen',
      detail: [
        params.reason,
        params.command,
        params.cwd,
        params.grantRoot,
        params.changes ? JSON.stringify(params.changes, null, 2) : '',
        params.networkApprovalContext ? JSON.stringify(params.networkApprovalContext, null, 2) : '',
        params.additionalPermissions ? JSON.stringify(params.additionalPermissions, null, 2) : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      fields: [],
      actions: actions.filter((action) => action.id === 'decline' || allowed.includes(action.id)),
    })
    return { decision: answer.action }
  }
  if (method === 'item/permissions/requestApproval') {
    const answer = await ask({
      title: 'Codex vraagt extra toegang',
      detail: [params.reason, JSON.stringify(params.permissions, null, 2)].filter(Boolean).join('\n\n'),
      fields: [],
      actions,
    })
    return { permissions: answer.action === 'accept' ? params.permissions : {}, scope: 'turn' }
  }
  if (method === 'item/tool/requestUserInput') {
    const questions = Array.isArray(params.questions) ? params.questions.map(object) : []
    const answer = await ask({
      title: 'Codex heeft een vraag',
      detail: '',
      actions: [
        { id: 'accept', label: 'Antwoorden' },
        { id: 'decline', label: 'Overslaan' },
      ],
      fields: questions.map((question) => ({
        id: string(question.id),
        label: string(question.question),
        required: true,
        secret: question.isSecret === true,
        options: Array.isArray(question.options)
          ? question.options.map((option) => string(object(option).label))
          : undefined,
      })),
    })
    return {
      answers: Object.fromEntries(
        questions.map((question) => [
          string(question.id),
          { answers: answer.action === 'accept' ? [answer.values[string(question.id)] ?? ''] : [] },
        ])
      ),
    }
  }
  if (method === 'mcpServer/elicitation/request') {
    if (params.mode === 'url') {
      const url = new URL(string(params.url))
      if (!['https:', 'http:'].includes(url.protocol)) return { action: 'decline', content: null }
      const answer = await ask({
        title: `${string(params.serverName)} vraagt je aandacht`,
        detail: string(params.message),
        url: url.toString(),
        fields: [],
        actions: [
          { id: 'accept', label: 'Gereed' },
          { id: 'decline', label: 'Annuleren' },
        ],
      })
      return { action: answer.action, content: null }
    }
    const schema = object(params.requestedSchema)
    const fields = Object.entries(object(schema.properties))
    // Unsupported schemas are explicitly rejected so the provider can offer its
    // own UI. Never turn an unrendered permission form into an implicit approval.
    if (
      schema.type !== 'object' ||
      fields.some(([, value]) => !['string', 'boolean', 'number', 'integer'].includes(string(object(value).type)))
    ) {
      throw new Error('This provider form is not supported in Remember. Continue in Codex to complete it.')
    }
    const answer = await ask({
      title: `${string(params.serverName)} vraagt je aandacht`,
      detail: string(params.message),
      actions,
      fields: fields.map(([id, value]) => {
        const field = object(value)
        return {
          id,
          label: string(field.title) || string(field.description) || id,
          required: Array.isArray(schema.required) && schema.required.includes(id),
          options:
            field.type === 'boolean'
              ? ['true', 'false']
              : Array.isArray(field.enum)
                ? field.enum.map(String)
                : undefined,
        }
      }),
    })
    if (answer.action !== 'accept') return { action: 'decline', content: null }
    const content: Record<string, unknown> = {}
    for (const [id, value] of fields) {
      const field = object(value)
      const rawValue = answer.values[id]
      if (rawValue === undefined || rawValue === '') continue
      let parsed: unknown = rawValue
      if (field.type === 'boolean') {
        if (!['true', 'false'].includes(rawValue)) throw new Error('invalid-provider-form-answer')
        parsed = rawValue === 'true'
      } else if (field.type === 'number' || field.type === 'integer') {
        parsed = Number(rawValue)
        if (!Number.isFinite(parsed) || (field.type === 'integer' && !Number.isInteger(parsed)))
          throw new Error('invalid-provider-form-answer')
      }
      if (Array.isArray(field.enum) && !field.enum.includes(parsed)) throw new Error('invalid-provider-form-answer')
      content[id] = parsed
    }
    return { action: 'accept', content }
  }
  throw new Error(`Unsupported Codex request: ${method}`)
}
