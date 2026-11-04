import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { DailyReviewContextMoment } from '@remember/shared'
import { resolveOtherParticipantName } from '../conversationParticipant'

const dayStartedAt = new Date(2026, 7, 6, 8).getTime()
const conversation = { startTime: '10:00', endTime: '10:30' }

function at(time: string, overrides: Partial<DailyReviewContextMoment> = {}): DailyReviewContextMoment {
  const [hours, minutes] = time.split(':').map(Number)
  const timestamp = new Date(dayStartedAt)
  timestamp.setHours(hours, minutes, 0, 0)
  return {
    id: `context-${time}`,
    timestamp: timestamp.getTime(),
    appName: 'Google Chrome',
    bundleId: 'com.google.Chrome',
    windowTitle: 'Weekly sync - Google Meet',
    text: '2 participants\nJan (You), participant\nMaya Chen, participant, microphone on\nLeave call',
    textSource: 'accessibility',
    trigger: 'content-change',
    monitorName: '',
    screenshotPath: '',
    ...overrides,
  }
}

describe('resolveOtherParticipantName', () => {
  it('labels a confirmed one-to-one call from explicit local meeting UI', () => {
    assert.equal(resolveOtherParticipantName(dayStartedAt, conversation, [at('10:05')]), 'Maya Chen')
    assert.equal(
      resolveOtherParticipantName(dayStartedAt, conversation, [
        at('10:05', {
          appName: 'FaceTime',
          bundleId: 'com.apple.FaceTime',
          windowTitle: 'FaceTime',
          text: 'Call with Zo\u00eb de Boer\nEnd call',
        }),
      ]),
      'Zo\u00eb de Boer'
    )
  })

  it('rejects group calls and ambiguous participant lists', () => {
    const group = at('10:05', {
      text: '3 participants\nJan (You), participant\nMaya Chen, participant\nLuis, participant\nLeave call',
    })
    const ambiguous = at('10:06', {
      text: '2 participants\nMaya Chen, participant\nLuis, participant\nLeave call',
    })
    assert.equal(resolveOtherParticipantName(dayStartedAt, conversation, [group]), null)
    assert.equal(resolveOtherParticipantName(dayStartedAt, conversation, [ambiguous]), null)
    assert.equal(resolveOtherParticipantName(dayStartedAt, conversation, [at('10:02'), group]), null)
    assert.equal(
      resolveOtherParticipantName(dayStartedAt, conversation, [
        at('10:05', { text: 'Call with Maya Chen\n3 participants\nEnd call' }),
      ]),
      null
    )
  })

  it('rejects uncertain names and snapshots without an active call marker', () => {
    assert.equal(
      resolveOtherParticipantName(dayStartedAt, conversation, [
        at('10:05', { text: '2 participants\nUnknown, participant\nLeave call' }),
      ]),
      null
    )
    assert.equal(
      resolveOtherParticipantName(dayStartedAt, conversation, [
        at('10:05', { text: '2 participants\nMaya Chen, participant' }),
      ]),
      null
    )
    assert.equal(
      resolveOtherParticipantName(dayStartedAt, conversation, [
        at('10:05', { text: '2 participants\nJan (You), participant\nMaya Chen, participant\nMute notifications' }),
      ]),
      null
    )
  })

  it('rejects non-meeting apps and context outside the conversation window', () => {
    assert.equal(
      resolveOtherParticipantName(dayStartedAt, conversation, [
        at('10:05', { appName: 'Music', bundleId: 'com.apple.Music', windowTitle: 'Maya Chen' }),
      ]),
      null
    )
    assert.equal(resolveOtherParticipantName(dayStartedAt, conversation, [at('09:55')]), null)
  })

  it('rejects conflicting names across snapshots in the same call window', () => {
    assert.equal(
      resolveOtherParticipantName(dayStartedAt, conversation, [
        at('10:05'),
        at('10:20', { text: 'Call with Luis\nEnd call' }),
      ]),
      null
    )
  })
})
