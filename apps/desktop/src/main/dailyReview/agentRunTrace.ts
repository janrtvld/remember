import type { AgentRunContextCategory, DailyReviewSession, DayMemory } from '@remember/shared'

export function agentContextUsed(session: DailyReviewSession): AgentRunContextCategory[] {
  const categories: AgentRunContextCategory[] = []
  if (session.appActivity.length > 0) {
    categories.push({ category: 'app-usage', itemCount: session.appActivity.length })
  }
  if (session.contextMoments.length > 0) {
    categories.push({ category: 'screen-context', itemCount: session.contextMoments.length })
  }
  const transcriptCount = session.moments.filter(
    (moment) => moment.status === 'ready' && moment.transcript.trim()
  ).length
  if (transcriptCount > 0) {
    categories.push({ category: 'audio-transcripts', itemCount: transcriptCount })
  }
  return categories
}

export function memoryInsights(memory: Omit<DayMemory, 'refreshedAt' | 'coveredThrough'>, createdWorkItems = 0) {
  const insights: string[] = ['Dag bijgewerkt']
  if (createdWorkItems > 0) {
    insights.push(`${createdWorkItems} ${createdWorkItems === 1 ? 'open punt' : 'open punten'} gevonden`)
  }
  const wikiCount = memory.knowledgeSuggestions.length
  if (wikiCount > 0) insights.push(`${wikiCount} wiki-${wikiCount === 1 ? 'pagina' : 'pagina’s'} bijgewerkt`)
  const conversationCount = memory.conversations.length
  if (conversationCount > 0) insights.push(`${conversationCount} gesprekken samengevat`)
  return insights
}
