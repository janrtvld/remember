import type { CalendarBlock, DailyReviewSession, TimelineEvidenceReference } from '@remember/shared'
import { timelineEvidenceReferences } from './timelineItems'

export type TimelineWindow = { startedAt: number; endedAt: number }

function localDay(timestamp: number) {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function timestampForDayTime(dayStartedAt: number, time: string) {
  const [hours, minutes] = time.split(':').map(Number)
  const timestamp = new Date(dayStartedAt)
  timestamp.setHours(hours === 24 ? 0 : hours, minutes, 0, 0)
  if (hours === 24) timestamp.setDate(timestamp.getDate() + 1)
  return timestamp.getTime()
}

export function blockOverlapsWindow(dayStartedAt: number, block: CalendarBlock, window: TimelineWindow) {
  const startedAt = timestampForDayTime(dayStartedAt, block.startTime)
  let endedAt = timestampForDayTime(dayStartedAt, block.endTime)
  if (endedAt <= startedAt) endedAt += 24 * 60 * 60_000
  return startedAt < window.endedAt && endedAt > window.startedAt
}

function referenceCounts(references: TimelineEvidenceReference[]) {
  const counts = { context: 0, audio: 0, app: 0 }
  for (const reference of references) counts[reference.kind] += 1
  return counts
}

function renderBlock(block: CalendarBlock) {
  const details = (block.details ?? []).map((detail) => `- ${detail.at} ${detail.text}`).join('\n')
  return [
    `## ${block.startTime}–${block.endTime} ${block.title}`,
    '',
    block.description,
    ...(details ? ['', details] : []),
  ].join('\n')
}

export function summarizeTimelineBlocks(blocks: CalendarBlock[]) {
  if (!blocks.length) return 'No meaningful activity was summarized in this interval.'
  return blocks.map((block) => `${block.title}: ${block.description}`).join(' ')
}

export function renderTimelineMarkdown(
  session: DailyReviewSession,
  blocks: CalendarBlock[],
  window: TimelineWindow,
  evidencePath: string,
  summary = summarizeTimelineBlocks(blocks)
) {
  const memory = session.memory
  if (!memory) return ''
  const references = blocks.flatMap((block) => timelineEvidenceReferences(session, block))
  const counts = referenceCounts(references)
  const applications = Array.from(
    new Set(
      references.flatMap((reference) => {
        if (reference.kind !== 'app') return []
        const activity = session.appActivity.find((candidate) => candidate.id === reference.id)
        return activity?.bundleId ? [activity.bundleId] : []
      })
    )
  ).sort()
  const title = blocks.length === 1 ? blocks[0]?.title : `Timeline ${localDay(session.startedAt)}`

  return [
    '---',
    `title: ${JSON.stringify(title ?? 'Timeline')}`,
    `description: ${JSON.stringify(summary.replace(/\s+/g, ' ').trim())}`,
    `applications: ${JSON.stringify(applications)}`,
    `startedAt: ${JSON.stringify(new Date(window.startedAt).toISOString())}`,
    `endedAt: ${JSON.stringify(new Date(window.endedAt).toISOString())}`,
    '---',
    '',
    '# Activity summary',
    '',
    summary,
    '',
    '# Activity record',
    '',
    blocks.length ? blocks.map(renderBlock).join('\n\n') : 'No meaningful activity was summarized in this interval.',
    '',
    '# Evidence',
    '',
    `- ${evidencePath}`,
    `- ${counts.context} context records, ${counts.audio} audio records, ${counts.app} app periods`,
    '',
  ].join('\n')
}
