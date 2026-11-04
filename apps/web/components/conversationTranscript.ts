export type TranscriptTurn = {
  label: string | null
  text: string
}

const revinoteSpeakerLine = /^\[([^\]\r\n]{1,80})\]:\s*(.*)$/

function timestampForDayTime(dayStartedAt: number, time: string) {
  const [hours, minutes] = time.split(':').map(Number)
  const timestamp = new Date(dayStartedAt)
  timestamp.setHours(hours === 24 ? 0 : hours, minutes, 0, 0)
  if (hours === 24) timestamp.setDate(timestamp.getDate() + 1)
  return timestamp.getTime()
}

function transcriptSourceLabel(source: 'microphone' | 'system', conversation: ConversationSummary) {
  if (source === 'microphone') return 'Microfoon'
  return conversation.otherParticipantName?.trim() || 'Systeemaudio'
}

export function transcriptForConversation(day: Pick<Day, 'startedAt' | 'moments'>, conversation: ConversationSummary) {
  if (conversation.recordingSource && conversation.source !== 'revinote') {
    return conversation.recordingSource.segments.map(({ id, source, text }) => ({
      id,
      label: transcriptSourceLabel(source, conversation),
      text: text.trim(),
    }))
  }

  const startedAt =
    conversation.recordingSource?.startedAt ?? timestampForDayTime(day.startedAt, conversation.startTime)
  const endedAt = conversation.recordingSource?.endedAt ?? timestampForDayTime(day.startedAt, conversation.endTime)
  return day.moments
    .filter((moment) => {
      if (moment.status !== 'ready' || !moment.transcript.trim()) return false
      if (conversation.source === 'revinote' && conversation.externalId) {
        return moment.id === `revinote:${conversation.externalId}`
      }
      const momentEndedAt = moment.startedAt + moment.durationMs
      return moment.startedAt < endedAt && momentEndedAt > startedAt
    })
    .sort((first, second) => first.startedAt - second.startedAt || first.source.localeCompare(second.source))
    .flatMap(({ id, source, transcript }) => {
      const text = transcript.trim()
      if (source !== 'revinote') return [{ id, label: transcriptSourceLabel(source, conversation), text }]
      return revinoteTranscriptTurns(text).map((turn, index) => ({ id: `${id}:${index}`, ...turn }))
    })
}

export function revinoteTranscriptTurns(transcript: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = []
  let label: string | null = null
  let lines: string[] = []
  let foundSpeaker = false

  const appendTurn = () => {
    const text = lines.join('\n').trim()
    if (text) turns.push({ label, text })
    lines = []
  }

  for (const line of transcript.replace(/\r\n?/g, '\n').split('\n')) {
    const speaker = line.match(revinoteSpeakerLine)
    if (!speaker) {
      lines.push(line)
      continue
    }

    appendTurn()
    label = speaker[1]?.trim() || null
    lines.push(speaker[2] ?? '')
    foundSpeaker = true
  }

  appendTurn()
  return foundSpeaker ? turns : [{ label: null, text: transcript.trim() }].filter((turn) => turn.text)
}

import type { ConversationSummary, Day } from '@remember/shared'
