import { isRetryableAgentResponseError } from './agentErrors'

export async function retryInvalidAgentResponse<T>(operation: (isRetry: boolean) => Promise<T>): Promise<T> {
  try {
    return await operation(false)
  } catch (error) {
    if (!isRetryableAgentResponseError(error)) throw error
    try {
      return await operation(true)
    } catch (retryError) {
      if (!isRetryableAgentResponseError(retryError)) throw retryError
      throw new Error('agent-invalid-response', { cause: retryError })
    }
  }
}
