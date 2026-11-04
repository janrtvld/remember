import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import * as z from 'zod'
import type { CodexClientTool } from './codexClientTools'

export function createClaudeClientToolServer(
  tools: CodexClientTool[],
  context: {
    turnId: string
    threadId: () => string
    signal: AbortSignal
    assertCurrent?: () => void
  }
) {
  const server = createSdkMcpServer({ name: 'remember', version: '1.0.0', tools: [] })
  for (const definition of tools) {
    const schema = z.fromJSONSchema({ ...definition.inputSchema })
    if (!(schema instanceof z.ZodObject)) throw new Error('remember-tool-schema-invalid')
    server.instance.registerTool(
      definition.name,
      { description: definition.description, inputSchema: schema },
      async (input, extra) => {
        const signal = AbortSignal.any([context.signal, extra.signal])
        const guard = () => {
          signal.throwIfAborted()
          context.assertCurrent?.()
          signal.throwIfAborted()
        }
        try {
          guard()
          const result = await definition.call(input, {
            threadId: context.threadId(),
            turnId: context.turnId,
            callId: String(extra.requestId),
            signal,
          })
          guard()
          const text = JSON.stringify(result)
          if (typeof text !== 'string' || text.length > 32_000) throw new Error('remember-tool-result-too-large')
          return { content: [{ type: 'text', text }] }
        } catch (error) {
          return {
            isError: true,
            content: [
              { type: 'text', text: error instanceof Error ? error.message.slice(0, 1000) : 'remember-tool-failed' },
            ],
          }
        }
      }
    )
  }
  return { server, allowedTools: tools.map(({ name }) => `mcp__remember__${name}`) }
}
