export type CodexClientTool = {
  name: string
  description: string
  inputSchema: object
  call: (
    input: unknown,
    context: { threadId: string; turnId: string; callId: string; signal: AbortSignal }
  ) => Promise<unknown>
}

export async function callCodexClientTool(
  tool: CodexClientTool,
  input: unknown,
  context: Parameters<CodexClientTool['call']>[1]
) {
  try {
    if (context.signal.aborted) throw new Error('agent-cancelled')
    const result = await tool.call(input, context)
    if (context.signal.aborted) throw new Error('agent-cancelled')
    const text = JSON.stringify(result)
    if (text.length > 32_000) throw new Error('remember-tool-result-too-large')
    return { success: true, contentItems: [{ type: 'inputText', text }] }
  } catch (error) {
    return {
      success: false,
      contentItems: [
        { type: 'inputText', text: error instanceof Error ? error.message.slice(0, 1000) : 'remember-tool-failed' },
      ],
    }
  }
}
