import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConversationEpisode, Day } from '@remember/shared'
import {
  conversationAudioPathAt,
  renderConversationAudioAt,
  saveConversationAudioChunkAt,
} from '../../src/main/dailyReview/conversationAudio'
import { EvidenceStore } from '../../src/main/dailyReview/evidenceStore'
import { createQaAudioFixture } from '../../src/main/dailyReview/qaAudioFixture'
import { DEFAULT_SETTINGS } from '../../src/main/settingsStore'

export function seedProfile(profile: string) {
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  writeFileSync(
    join(profile, 'settings.json'),
    JSON.stringify({
      ...DEFAULT_SETTINGS,
      interfaceLanguage: 'en',
      offlineMode: true,
      automaticUpdates: false,
      launchAtLogin: false,
      frequentDayRefresh: false,
      capturePaused: true,
      cloudAnalysisConsent: true,
      dayAnalysisProvider: 'codex',
      dayAnalysisOnboardingCompleted: true,
      privacyOnboardingCompleted: true,
      audioCaptureOnboardingCompleted: true,
      contextImportOnboardingCompleted: true,
    }),
    { mode: 0o600 }
  )
  for (const marker of [
    '.legacy-user-data-migration-complete',
    '.legacy-archive-import-complete',
    '.legacy-model-import-complete',
  ]) {
    writeFileSync(join(profile, marker), 'qa\n')
  }
  const start = new Date()
  start.setDate(start.getDate() - 1)
  start.setHours(9, 0, 0, 0)
  const startedAt = start.getTime()
  const day: Day = {
    id: 'qa-day',
    startedAt,
    endedAt: startedAt + 60_000,
    activeDurationMs: 60_000,
    moments: [
      {
        id: 'qa-audio',
        sessionId: 'qa-day',
        source: 'microphone',
        startedAt,
        durationMs: 2_000,
        status: 'ready',
        transcript: 'Synthetic QA evidence. No real speech was recorded.',
        captureOutcome: 'transcribed',
      },
    ],
    appActivity: [],
    contextMoments: [],
    memory: {
      summary: 'Verification fixture',
      currentFocus: null,
      outcomes: [],
      decisions: [],
      openLoops: [],
      conversations: [
        {
          episodeId: 'qa-episode',
          startTime: '09:00',
          endTime: '09:01',
          title: 'QA audio fixture',
          description: 'Generated tone',
        },
      ],
      timeline: [
        {
          id: 'qa-timeline',
          startTime: '09:00',
          endTime: '09:01',
          title: 'QA timeline fixture',
          description: 'Persisted context fixture',
        },
      ],
      knowledgeSuggestions: [],
      refreshedAt: startedAt + 60_000,
      coveredThrough: startedAt + 60_000,
    },
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  }
  const episode: ConversationEpisode = {
    id: 'qa-episode',
    workdayId: day.id,
    startedAt,
    endedAt: startedAt + 2_000,
    state: 'final',
    surfaceKey: 'manual:qa-recording',
    provider: 'manual',
    boundaryReason: 'call-ended',
    segmentIds: [],
    deletedAt: null,
    automaticRevinoteProcessingBlocked: true,
  }
  const root = join(profile, 'daily-review')
  const store = new EvidenceStore(join(root, 'evidence.sqlite'))
  try {
    store.upsertSession(day)
    store.upsertAppActivity(day.id, {
      id: 'qa-focus',
      appName: 'QA fixture',
      bundleId: 'com.example.qa.fixture',
      startedAt,
      endedAt: startedAt + 60_000,
    })
    for (const moment of day.moments) store.appendAudioMoment(moment, 0.01)
    store.appendContextMoment(
      day.id,
      {
        id: 'qa-context',
        timestamp: startedAt,
        appName: 'QA fixture',
        windowTitle: 'Verification loop',
        text: 'Known context evidence for restart verification',
        textSource: 'accessibility',
        trigger: 'focus',
        monitorName: 'Fixture display',
        screenshotPath: '',
        url: 'https://example.test/verification',
        focusedElement: { role: 'AXTextField', title: 'QA note', description: '', value: 'Known input value' },
      },
      'qa-focus',
      'com.example.qa.fixture'
    )
    store.upsertManualMeetingEpisode(episode)
    store.applyAnalyzedWorkItems({
      workdayId: day.id,
      analysisStartedAt: startedAt + 60_000,
      observedAt: startedAt + 60_000,
      conversations: [],
      plan: {
        proposed: [
          {
            title: 'Make a QA PDF',
            description: 'Collect the fixture answers.',
            prompt: 'Create a PDF with the fixture answers.',
            aiSuggestion: 'Want me to make a PDF with the answers?',
            source: { kind: 'task', label: 'QA answers', detail: 'PDF requested.', evidenceId: 'qa-context' },
          },
          {
            title: 'Swap suitcase with Tom',
            description: 'Swap the suitcase before the trip.',
            aiSuggestion: null,
            source: { kind: 'task', label: 'QA trip', detail: 'Swap agreed.', evidenceId: 'qa-context' },
          },
        ],
        changes: [],
      },
    })
    saveConversationAudioChunkAt(root, day.id, 'qa-audio', createQaAudioFixture(2_000))
    renderConversationAudioAt(root, episode, day.moments)
  } finally {
    store.close()
  }
  return {
    dayId: day.id,
    episodeId: episode.id,
    timelineId: 'qa-timeline',
    audioPath: conversationAudioPathAt(root, episode),
  }
}

export function writeSystemAudioStimulus(target: string) {
  const tone = createQaAudioFixture(3_000)
  const wav = Buffer.concat([tone.subarray(0, 44), ...Array.from({ length: 30 }, () => tone.subarray(44))])
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.writeUInt32LE(wav.length - 44, 40)
  writeFileSync(target, wav, { mode: 0o600 })
}
