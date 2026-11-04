import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, test } from 'node:test'
import type { DailyReviewSession } from '@remember/shared'
import { conversationActionPointItems, workItemForConversationActionPoint } from '@remember/shared'
import { selectAgentTasks } from '../../residentAgentPrivacy'
import { mergeRevinoteMeetings } from '../../revinoteMeetings'
import { DEFAULT_SETTINGS } from '../../settingsStore'
import { EvidenceStore } from '../evidenceStore'

const paths: string[] = []

afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { force: true })
})

function createStore() {
  const path = join(tmpdir(), `remember-evidence-${randomUUID()}.sqlite`)
  paths.push(path, `${path}-wal`, `${path}-shm`)
  return new EvidenceStore(path)
}

function appendScreenEvidence(
  store: EvidenceStore,
  workdayId: string,
  evidenceId: string,
  timestamp: number,
  text = 'A concrete residual step remains.'
) {
  store.appendContextMoment(
    workdayId,
    {
      id: evidenceId,
      timestamp,
      appName: 'Editor',
      windowTitle: 'Current work',
      text,
      textSource: 'accessibility',
      trigger: 'window-change',
      monitorName: 'Built-in',
      screenshotPath: '',
    },
    null,
    'com.example.editor'
  )
}

test('targeted task privacy lookup matches archive checks and observes exclusions and deletion immediately', () => {
  const store = createStore()
  for (const id of ['task-day', 'other-day']) {
    store.upsertSession({
      id,
      localDay: id === 'task-day' ? '1970-01-01' : '1970-01-02',
      startedAt: 1_000,
      endedAt: null,
      activeDurationMs: 0,
      moments: [],
      appActivity: [],
      contextMoments: [],
      memory: null,
      refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
    })
  }
  appendScreenEvidence(store, 'task-day', 'allowed-source', 2_000)
  appendScreenEvidence(store, 'other-day', 'unrelated-source', 2_000)
  const manual = store.createWorkItem('Task', '')
  const task = {
    ...manual,
    sources: [{ ...manual.sources[0], kind: 'observed' as const, workdayId: 'task-day', observedAt: 2_000 }],
  }
  const settings = { ...DEFAULT_SETTINGS }
  const targeted = () =>
    selectAgentTasks([task], {
      settings,
      contextEvidence: (workdayId, observedAt) => store.readTaskContextEvidence(workdayId, observedAt),
    })
  const full = () =>
    selectAgentTasks([task], {
      settings,
      days: store.readSessions().map((day) => ({ ...day, contextMoments: store.readContextMoments(day.id) })),
    })
  assert.equal(selectAgentTasks([task], { settings, days: store.readSessions() }).length, 0)
  assert.deepEqual(targeted(), full())
  assert.equal(targeted().length, 1)
  assert.equal(store.readTaskContextEvidence('task-day', 2_000).length, 1)
  assert.equal(store.readTaskContextEvidence('task-day', 2_001).length, 0)
  assert.equal(store.readTaskContextEvidence('task-day', 2_000)[0].text, '')

  store.appendContextMoment(
    'task-day',
    {
      id: 'excluded-same-timestamp',
      timestamp: 2_000,
      appName: 'Private',
      windowTitle: 'Private document',
      text: 'Private content',
      textSource: 'accessibility',
      trigger: 'window-change',
      monitorName: '',
      screenshotPath: '',
    },
    null,
    'com.example.private'
  )
  settings.excludedAppBundleIds = ['com.example.private']
  assert.equal(store.readTaskContextEvidence('task-day', 2_000).length, 2)
  assert.deepEqual(targeted(), full())
  assert.equal(targeted().length, 0)
  settings.excludedAppBundleIds = []
  assert.equal(targeted().length, 1)
  store.deleteEvidenceSince(2_000)
  assert.deepEqual(targeted(), full())
  assert.equal(targeted().length, 0)
  store.close()
})

test('refuses to initialize an existing zero-byte archive', () => {
  const path = join(tmpdir(), `remember-evidence-${randomUUID()}.sqlite`)
  paths.push(path, `${path}-wal`, `${path}-shm`)
  writeFileSync(path, '')

  assert.throws(() => new EvidenceStore(path), { message: 'evidence-archive-zero-byte' })
  assert.equal(readFileSize(path), 0)
})

function readFileSize(path: string) {
  return statSync(path).size
}

test('stores normalized evidence and retrieves it through FTS', async () => {
  const store = createStore()
  const session: DailyReviewSession = {
    id: 'day-1',
    startedAt: 1000,
    endedAt: null,
    activeDurationMs: 0,
    moments: [],
    appActivity: [],
    contextMoments: [],
    memory: null,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  }
  store.upsertSession(session)
  store.upsertAppActivity(session.id, {
    id: 'segment-1',
    appName: 'Editor',
    bundleId: 'com.example.editor',
    startedAt: 1000,
    endedAt: 2000,
  })
  store.appendContextMoment(
    session.id,
    {
      id: 'context-1',
      timestamp: 1100,
      appName: 'Editor',
      windowTitle: 'Capture architecture',
      text: 'The evidence layer uses indexed local storage.',
      textSource: 'accessibility',
      trigger: 'window-change',
      monitorName: 'Built-in',
      screenshotPath: '',
      url: 'https://example.com/capture-architecture',
      focusedElement: {
        role: 'AXButton',
        title: 'Save evidence',
        description: 'Persist the current event',
        value: '',
      },
    },
    'segment-1',
    'com.example.editor'
  )
  store.appendAudioMoment({
    id: 'audio-1',
    sessionId: session.id,
    source: 'microphone',
    startedAt: 1200,
    durationMs: 60_000,
    status: 'ready',
    transcript: 'We decided raw audio should be temporary.',
    mediaPlayback: {
      isPlaying: true,
      bundleIdentifier: 'org.videolan.vlc',
      applicationName: 'VLC',
    },
  })

  const [loaded] = store.readSessions()
  assert.equal(loaded?.appActivity[0]?.bundleId, 'com.example.editor')
  const context = store.readContextMoments(session.id)[0]
  assert(loaded?.contextMoments[0] && !('text' in loaded.contextMoments[0]))
  assert.equal(context?.windowTitle, 'Capture architecture')
  assert.equal(loaded?.contextMoments[0]?.bundleId, 'com.example.editor')
  assert.equal(context?.url, 'https://example.com/capture-architecture')
  assert.equal(context?.focusedElement?.title, 'Save evidence')
  assert.equal(loaded?.moments[0]?.transcript, 'We decided raw audio should be temporary.')
  assert.deepEqual(loaded?.moments[0]?.mediaPlayback, {
    isPlaying: true,
    bundleIdentifier: 'org.videolan.vlc',
    applicationName: 'VLC',
  })
  assert.equal(store.search('indexed').length, 1)
  assert.equal(store.search('capture-architecture').length, 1)
  assert.equal(store.search('Save').length, 1)
  assert.equal(store.search('temporary').length, 1)
  const analysisEvidence = await store.readAnalysisEvidence(session.id)
  assert.deepEqual(
    analysisEvidence.map((entry) => entry.kind),
    ['app-period', 'screen-context', 'transcript']
  )
  assert.equal(analysisEvidence[1]?.evidenceId, 'context-1')
  assert.equal(analysisEvidence[1]?.url, 'https://example.com/capture-architecture')
  assert.equal(analysisEvidence[1]?.focusedElement?.description, 'Persist the current event')

  store.close()
})

test('persists exact speech spans, call signals, and immutable finalized episodes', async () => {
  const store = createStore()
  store.upsertSession({
    id: 'day-episodes',
    startedAt: 1_000,
    endedAt: null,
    activeDurationMs: 0,
    moments: [],
    appActivity: [],
    contextMoments: [],
    memory: null,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  })
  store.appendAudioMoment({
    id: 'chunk-1',
    sessionId: 'day-episodes',
    source: 'microphone',
    startedAt: 1_000,
    durationMs: 60_000,
    status: 'ready',
    transcript: 'accepted noise',
  })
  store.appendSpeechSegments([
    {
      id: 'speech-accepted',
      workdayId: 'day-episodes',
      chunkId: 'chunk-1',
      source: 'microphone',
      startedAt: 11_000,
      endedAt: 17_000,
      text: 'accepted',
      detectedLanguage: 'en',
      acceptedLanguage: 'en',
      rejectionReason: null,
    },
    {
      id: 'speech-noise',
      workdayId: 'day-episodes',
      chunkId: 'chunk-1',
      source: 'microphone',
      startedAt: 40_000,
      endedAt: 41_000,
      text: 'noise',
      detectedLanguage: 'ja',
      acceptedLanguage: null,
      rejectionReason: 'unsupported-language',
    },
  ])
  store.appendCallSignal({
    id: 'call-1',
    workdayId: 'day-episodes',
    provider: 'woub',
    surfaceKey: 'woub:review',
    state: 'active',
    observedAt: 5_000,
  })
  store.syncConversationEpisodes('day-episodes', [
    {
      id: 'episode-1',
      workdayId: 'day-episodes',
      startedAt: 11_000,
      endedAt: 17_000,
      state: 'final',
      surfaceKey: 'woub:review',
      provider: 'woub',
      boundaryReason: 'call-ended',
      segmentIds: ['speech-accepted'],
      deletedAt: null,
      automaticRevinoteProcessingBlocked: false,
    },
  ])
  store.syncConversationEpisodes('day-episodes', [
    {
      ...(store.listConversationEpisodes('day-episodes')[0] as NonNullable<
        ReturnType<EvidenceStore['listConversationEpisodes']>[number]
      >),
      endedAt: 99_000,
      segmentIds: ['speech-accepted', 'speech-noise'],
    },
  ])

  assert.deepEqual(await store.readAnalysisEvidence('day-episodes'), [
    {
      timestamp: 11_000,
      evidenceId: 'speech:speech-accepted',
      endedAt: 17_000,
      kind: 'transcript',
      source: 'microphone',
      text: 'accepted',
    },
  ])
  assert.equal(store.listSpeechSegments('day-episodes').length, 2)
  assert.deepEqual(store.listSpeechSegments('day-episodes')[0]?.chunkIds, ['chunk-1'])
  assert.equal(store.listCallSignals('day-episodes')[0]?.surfaceKey, 'woub:review')
  assert.equal(store.listConversationEpisodes('day-episodes')[0]?.endedAt, 17_000)
  assert.deepEqual(store.listConversationEpisodes('day-episodes')[0]?.segmentIds, ['speech-accepted'])
  store.decideConversationEpisode('episode-1', 'confirmed', 20_000)
  assert.equal(store.listConversationEpisodes('day-episodes')[0]?.userDecision, 'confirmed')
  store.decideConversationEpisode('episode-1', 'dismissed', 21_000)
  assert.equal(store.listConversationEpisodes('day-episodes')[0]?.userDecision, 'dismissed')
  store.close()
})

test('persists capture continuity and recoverable transcription outcomes', () => {
  const store = createStore()
  store.upsertSession({
    id: 'day-continuity',
    startedAt: 1_000,
    endedAt: null,
    activeDurationMs: 0,
    moments: [],
    appActivity: [],
    contextMoments: [],
    memory: null,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  })
  store.appendAudioMoment({
    id: 'chunk-continuity',
    sessionId: 'day-continuity',
    source: 'microphone',
    startedAt: 2_000,
    durationMs: 60_000,
    status: 'empty',
    transcript: '',
    captureEpochId: 'epoch-1',
    captureSequence: 7,
    capturedSampleCount: 960_000,
    captureSampleTime: 123_456,
    captureOutcome: 'asr-empty',
  })
  store.appendSpeechSegments([
    {
      id: 'speech-empty',
      workdayId: 'day-continuity',
      chunkId: 'chunk-continuity',
      chunkIds: ['chunk-continuity', 'chunk-next'],
      source: 'microphone',
      startedAt: 55_000,
      endedAt: 65_000,
      vadStartedAt: 55_000,
      vadEndedAt: 65_000,
      asrWindowIndex: 0,
      asrWindowCount: 1,
      transcriptionOutcome: 'asr-empty',
      text: '',
      detectedLanguage: null,
      acceptedLanguage: null,
      rejectionReason: null,
    },
  ])

  const moment = store.readSessions()[0]?.moments[0]
  const segment = store.listSpeechSegments('day-continuity')[0]
  assert.equal(moment?.captureEpochId, 'epoch-1')
  assert.equal(moment?.captureSequence, 7)
  assert.equal(moment?.capturedSampleCount, 960_000)
  assert.equal(moment?.captureSampleTime, 123_456)
  assert.equal(moment?.captureOutcome, 'asr-empty')
  assert.equal(segment?.vadStartedAt, 55_000)
  assert.equal(segment?.vadEndedAt, 65_000)
  assert.deepEqual(segment?.chunkIds, ['chunk-continuity', 'chunk-next'])
  assert.equal(segment?.transcriptionOutcome, 'asr-empty')
  store.close()
})

test('promotes recent language quarantine after contextual confirmation', () => {
  const store = createStore()
  store.upsertSession({
    id: 'day-language-promotion',
    startedAt: 1_000,
    endedAt: null,
    activeDurationMs: 0,
    moments: [],
    appActivity: [],
    contextMoments: [],
    memory: null,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  })
  store.appendAudioMoment({
    id: 'chunk-language',
    sessionId: 'day-language-promotion',
    source: 'microphone',
    startedAt: 1_000,
    durationMs: 60_000,
    status: 'empty',
    transcript: '',
  })
  store.appendSpeechSegments([
    {
      id: 'speech-language',
      workdayId: 'day-language-promotion',
      chunkId: 'chunk-language',
      source: 'microphone',
      startedAt: 5_000,
      endedAt: 7_000,
      text: 'Short English turn',
      detectedLanguage: 'en-US',
      acceptedLanguage: null,
      rejectionReason: 'cross-language-unconfirmed',
    },
  ])

  const promotedChunkIds = store.promoteQuarantinedSpeechSegments('day-language-promotion', 'microphone', 'en', 8_000)

  const segment = store.listSpeechSegments('day-language-promotion')[0]
  assert.equal(segment?.acceptedLanguage, 'en')
  assert.equal(segment?.rejectionReason, null)
  assert.deepEqual(promotedChunkIds, ['chunk-language'])
  store.close()
})

test('atomically replaces source episodes with one manual merge', () => {
  const store = createStore()
  store.upsertSession({
    id: 'day-merge',
    startedAt: 1_000,
    endedAt: null,
    activeDurationMs: 0,
    moments: [],
    appActivity: [],
    contextMoments: [],
    memory: null,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  })
  const sourceEpisodes = [
    {
      id: 'source-1',
      workdayId: 'day-merge',
      startedAt: 2_000,
      endedAt: 4_000,
      state: 'final' as const,
      surfaceKey: 'discord:tom',
      provider: 'discord',
      boundaryReason: 'speech-gap' as const,
      segmentIds: ['segment-1'],
      deletedAt: null,
      automaticRevinoteProcessingBlocked: true,
    },
    {
      id: 'source-2',
      workdayId: 'day-merge',
      startedAt: 7_000,
      endedAt: 9_000,
      state: 'final' as const,
      surfaceKey: 'discord:tom',
      provider: 'discord',
      boundaryReason: 'call-ended' as const,
      segmentIds: ['segment-2'],
      deletedAt: null,
      automaticRevinoteProcessingBlocked: false,
    },
  ]
  store.syncConversationEpisodes('day-merge', sourceEpisodes)
  store.applyAnalyzedWorkItems({
    workdayId: 'day-merge',
    analysisStartedAt: 9_000,
    observedAt: 9_500,
    conversations: [
      {
        episodeId: 'source-1',
        startTime: '10:00',
        endTime: '10:02',
        title: 'First call',
        description: 'First source.',
      },
      {
        episodeId: 'source-2',
        startTime: '10:05',
        endTime: '10:07',
        title: 'Second call',
        description: 'Second source.',
      },
    ],
    plan: {
      proposed: [
        {
          title: 'Send the first follow-up',
          description: 'Follow up on the first call.',
          source: {
            kind: 'conversation',
            label: 'First call',
            detail: 'An explicit follow-up was agreed.',
            conversationStartTime: '10:00',
          },
        },
        {
          title: 'Send the second follow-up',
          description: 'Follow up on the second call.',
          source: {
            kind: 'conversation',
            label: 'Second call',
            detail: 'A separate follow-up was agreed.',
            conversationStartTime: '10:05',
          },
        },
      ],
      changes: [],
    },
  })

  store.mergeConversationEpisodes(
    {
      id: 'merged',
      workdayId: 'day-merge',
      startedAt: 2_000,
      endedAt: 9_000,
      state: 'final',
      surfaceKey: 'discord:tom',
      provider: 'discord',
      boundaryReason: 'manual-merge',
      segmentIds: ['segment-1', 'segment-2'],
      deletedAt: null,
      automaticRevinoteProcessingBlocked: false,
    },
    sourceEpisodes.map((episode) => episode.id),
    10_000
  )

  const episodes = store.listConversationEpisodes('day-merge')
  assert.deepEqual(
    episodes.map(({ id, deletedAt, boundaryReason }) => ({ id, deletedAt, boundaryReason })),
    [
      { id: 'merged', deletedAt: null, boundaryReason: 'manual-merge' },
      { id: 'source-1', deletedAt: 10_000, boundaryReason: 'speech-gap' },
      { id: 'source-2', deletedAt: 10_000, boundaryReason: 'call-ended' },
    ]
  )
  assert.equal(episodes.find((episode) => episode.id === 'merged')?.automaticRevinoteProcessingBlocked, true)
  assert.deepEqual(
    store
      .listWorkItems()
      .flatMap((item) => item.sources.map((source) => source.conversationReference))
      .sort(),
    ['episode:merged', 'episode:merged']
  )
  store.close()
})

test('keeps offline automatic Revinote exclusions durable across restarts', () => {
  const path = join(tmpdir(), `remember-evidence-${randomUUID()}.sqlite`)
  paths.push(path, `${path}-wal`, `${path}-shm`)
  const session: DailyReviewSession = {
    id: 'day-offline-episode',
    startedAt: 1_000,
    endedAt: null,
    activeDurationMs: 0,
    moments: [],
    appActivity: [],
    contextMoments: [],
    memory: null,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  }
  const episode = {
    id: 'episode-offline',
    workdayId: session.id,
    startedAt: 2_000,
    endedAt: 4_000,
    state: 'final' as const,
    surfaceKey: null,
    provider: null,
    boundaryReason: 'speech-gap' as const,
    segmentIds: ['segment-offline'],
    deletedAt: null,
    automaticRevinoteProcessingBlocked: true,
  }

  const first = new EvidenceStore(path)
  first.upsertSession(session)
  first.beginOfflinePeriod(2_500)
  first.endOfflinePeriod(3_500)
  first.syncConversationEpisodes(session.id, [episode])
  first.close()

  const second = new EvidenceStore(path)
  assert.equal(second.wasOfflineAt(3_000), true)
  assert.equal(second.wasOfflineAt(4_000), false)
  assert.equal(second.listConversationEpisodes(session.id)[0]?.automaticRevinoteProcessingBlocked, true)
  second.syncConversationEpisodes(session.id, [{ ...episode, automaticRevinoteProcessingBlocked: false }])
  second.close()

  const third = new EvidenceStore(path)
  assert.equal(third.listConversationEpisodes(session.id)[0]?.automaticRevinoteProcessingBlocked, true)
  third.close()
})

test('replaces speech-derived manual episodes with one authoritative recording episode', () => {
  const store = createStore()
  store.upsertSession({
    id: 'day-manual-episode',
    startedAt: 1_000,
    endedAt: null,
    activeDurationMs: 0,
    moments: [],
    appActivity: [],
    contextMoments: [],
    memory: null,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  })
  store.syncConversationEpisodes('day-manual-episode', [
    {
      id: 'speech-derived',
      workdayId: 'day-manual-episode',
      startedAt: 2_000,
      endedAt: 4_000,
      state: 'final',
      surfaceKey: 'manual:meeting-1',
      provider: 'manual',
      boundaryReason: 'call-ended',
      segmentIds: ['segment-1'],
      deletedAt: null,
      automaticRevinoteProcessingBlocked: true,
    },
  ])

  store.upsertManualMeetingEpisode({
    id: 'manual-meeting-meeting-1',
    workdayId: 'day-manual-episode',
    startedAt: 1_500,
    endedAt: 5_000,
    state: 'final',
    surfaceKey: 'manual:meeting-1',
    provider: 'manual',
    boundaryReason: 'call-ended',
    segmentIds: ['segment-1'],
    deletedAt: null,
    automaticRevinoteProcessingBlocked: false,
  })

  const episodes = store.listConversationEpisodes('day-manual-episode')
  assert.equal(episodes.find((episode) => episode.id === 'speech-derived')?.deletedAt, 5_000)
  assert.deepEqual(
    episodes.find((episode) => episode.id === 'manual-meeting-meeting-1'),
    {
      id: 'manual-meeting-meeting-1',
      workdayId: 'day-manual-episode',
      startedAt: 1_500,
      endedAt: 5_000,
      state: 'final',
      surfaceKey: 'manual:meeting-1',
      provider: 'manual',
      boundaryReason: 'call-ended',
      segmentIds: ['segment-1'],
      deletedAt: null,
      automaticRevinoteProcessingBlocked: true,
      userDecision: null,
    }
  )
  store.close()
})

test('migrates v9 conversation episodes without losing cached analyses', () => {
  const path = join(tmpdir(), `remember-evidence-${randomUUID()}.sqlite`)
  paths.push(path, `${path}-wal`, `${path}-shm`)
  const current = new EvidenceStore(path)
  current.upsertSession({
    id: 'day-v9',
    startedAt: 1_000,
    endedAt: null,
    activeDurationMs: 0,
    moments: [],
    appActivity: [],
    contextMoments: [],
    memory: null,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  })
  current.syncConversationEpisodes('day-v9', [
    {
      id: 'episode-v9',
      workdayId: 'day-v9',
      startedAt: 2_000,
      endedAt: 4_000,
      state: 'final',
      surfaceKey: null,
      provider: null,
      boundaryReason: 'speech-gap',
      segmentIds: ['segment-v9'],
      deletedAt: null,
      automaticRevinoteProcessingBlocked: false,
    },
  ])
  current.createManualMeeting('day-v9', 'Legacy recording', 1_500)
  current.upsertEpisodeAnalysis({
    id: 'analysis-v9',
    episodeId: 'episode-v9',
    workdayId: 'day-v9',
    startedAt: 2_000,
    endedAt: 4_000,
    classification: 'conversation',
    confidence: 'high',
    reason: 'cached-before-migration',
    title: 'Existing conversation',
    description: 'Existing description',
    summary: 'Existing summary',
    actionPoints: [],
    sourceHash: 'v9-hash',
    provider: 'codex',
    model: 'gpt-5.5',
    promptVersion: 1,
    schemaVersion: 1,
    generatedAt: 5_000,
  })
  current.close()

  const legacy = new DatabaseSync(path)
  legacy.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    CREATE TABLE conversation_episode_v9 (
      id TEXT PRIMARY KEY,
      workday_id TEXT NOT NULL REFERENCES workday(id) ON DELETE CASCADE,
      started_at INTEGER NOT NULL,
      ended_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('provisional', 'final')),
      surface_key TEXT,
      provider TEXT,
      boundary_reason TEXT NOT NULL CHECK(boundary_reason IN (
        'open', 'call-surface-changed', 'call-ended', 'speech-gap', 'capture-paused', 'day-ended'
      )),
      segment_ids_json TEXT NOT NULL DEFAULT '[]',
      deleted_at INTEGER,
      CHECK(ended_at >= started_at)
    ) STRICT;
    INSERT INTO conversation_episode_v9 (
      id, workday_id, started_at, ended_at, state, surface_key, provider,
      boundary_reason, segment_ids_json, deleted_at
    ) SELECT
      id, workday_id, started_at, ended_at, state, surface_key, provider,
      boundary_reason, segment_ids_json, deleted_at
    FROM conversation_episode;
    DROP TABLE conversation_episode;
    ALTER TABLE conversation_episode_v9 RENAME TO conversation_episode;
    CREATE INDEX conversation_episode_workday_time
      ON conversation_episode(workday_id, started_at, ended_at);
    ALTER TABLE manual_meeting DROP COLUMN automatic_revinote_processing_blocked;
    PRAGMA user_version = 9;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `)
  legacy.close()

  const migrated = new EvidenceStore(path)
  assert.equal(migrated.listConversationEpisodes('day-v9')[0]?.id, 'episode-v9')
  assert.equal(migrated.listConversationEpisodes('day-v9')[0]?.automaticRevinoteProcessingBlocked, false)
  assert.equal(migrated.listManualMeetings('day-v9')[0]?.automaticRevinoteProcessingBlocked, false)
  assert.equal(migrated.listEpisodeAnalyses('day-v9')[0]?.id, 'analysis-v9')
  migrated.close()
})

test('drops retired local-analysis cache tables from an existing archive', () => {
  const path = join(tmpdir(), `remember-evidence-${randomUUID()}.sqlite`)
  paths.push(path, `${path}-wal`, `${path}-shm`)
  const current = new EvidenceStore(path)
  current.close()

  const legacy = new DatabaseSync(path)
  legacy.exec(`
    CREATE TABLE conversation_summary (id TEXT PRIMARY KEY);
    CREATE TABLE conversation_analysis (id TEXT PRIMARY KEY);
    PRAGMA user_version = 11;
  `)
  legacy.close()

  const migrated = new EvidenceStore(path)
  migrated.close()
  const verified = new DatabaseSync(path)
  const retiredTables = verified
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('conversation_summary', 'conversation_analysis')"
    )
    .all()
  verified.close()

  assert.deepEqual(retiredTables, [])
})

test('keeps lock-screen applications out of analysis evidence', async () => {
  const store = createStore()
  store.upsertSession({
    id: 'day-lock-screen',
    startedAt: 1_000,
    endedAt: 2_000,
    activeDurationMs: 1_000,
    moments: [],
    appActivity: [],
    contextMoments: [],
    memory: null,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  })
  store.upsertAppActivity('day-lock-screen', {
    id: 'locked',
    appName: 'loginwindow',
    bundleId: 'com.apple.loginwindow',
    startedAt: 1_000,
    endedAt: 2_000,
  })
  store.appendContextMoment(
    'day-lock-screen',
    {
      id: 'locked-context',
      timestamp: 1_500,
      appName: 'loginwindow',
      bundleId: 'com.apple.loginwindow',
      windowTitle: 'Lock Screen',
      text: 'Password',
      textSource: 'accessibility',
      trigger: 'window-change',
      monitorName: 'Built-in',
      screenshotPath: '',
    },
    'locked',
    'com.apple.loginwindow'
  )

  assert.deepEqual(await store.readAnalysisEvidence('day-lock-screen'), [])
  store.close()
})

test('removes all evidence for a deleted workday', () => {
  const store = createStore()
  store.upsertSession({
    id: 'day-delete',
    startedAt: 1000,
    endedAt: 2000,
    activeDurationMs: 1000,
    moments: [],
    appActivity: [],
    contextMoments: [],
    memory: null,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  })
  store.appendAudioMoment({
    id: 'audio-delete',
    sessionId: 'day-delete',
    source: 'system',
    startedAt: 1000,
    durationMs: 1000,
    status: 'ready',
    transcript: 'Delete this indexed evidence.',
  })

  store.deleteSession('day-delete')

  assert.deepEqual(store.readSessions(), [])
  assert.deepEqual(store.search('delete'), [])
  store.close()
})

test('forgetting recent evidence removes legacy skill suggestions only for affected days after an upgrade', () => {
  const path = join(tmpdir(), `remember-evidence-${randomUUID()}.sqlite`)
  paths.push(path, `${path}-wal`, `${path}-shm`)
  const original = new EvidenceStore(path)
  for (const [id, at] of [
    ['day-recent', 86_403_000],
    ['day-older', 1_000],
  ] as const) {
    original.upsertSession({
      id,
      startedAt: at,
      endedAt: at + 100,
      activeDurationMs: 100,
      moments: [],
      appActivity: [],
      contextMoments: [],
      memory: null,
      refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
    })
    appendScreenEvidence(original, id, `source-${id}`, at)
  }
  original.close()

  const legacy = new DatabaseSync(path)
  legacy.exec(`CREATE TABLE timeline_skill_request (
    id TEXT PRIMARY KEY,
    workday_id TEXT NOT NULL REFERENCES workday(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    suggestion_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(workday_id, item_id)
  ) STRICT;
  PRAGMA user_version = 16;`)
  for (const id of ['day-recent', 'day-older']) {
    legacy
      .prepare('INSERT INTO timeline_skill_request VALUES (?, ?, ?, ?, ?)')
      .run(`skill-${id}`, id, `item-${id}`, JSON.stringify({ content: 'Derived captured content' }), 4_000)
  }
  legacy.close()

  const upgraded = new EvidenceStore(path)
  const saved = new DatabaseSync(path)
  try {
    const retainedDays = () =>
      saved
        .prepare('SELECT workday_id FROM timeline_skill_request ORDER BY workday_id')
        .all()
        .map((row) => row.workday_id)
    assert.deepEqual(retainedDays(), ['day-older', 'day-recent'])
    assert.deepEqual(upgraded.deleteEvidenceSince(86_402_000), ['day-recent'])
    assert.deepEqual(retainedDays(), ['day-older'])
    upgraded.deleteSession('day-older')
    assert.deepEqual(retainedDays(), [])
  } finally {
    saved.close()
    upgraded.close()
  }
})

test('removes recent evidence while preserving and truncating older activity', async () => {
  const store = createStore()
  store.upsertSession({
    id: 'day-recent',
    startedAt: 1_000,
    endedAt: 4_000,
    activeDurationMs: 3_000,
    moments: [],
    appActivity: [],
    contextMoments: [],
    memory: null,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  })
  store.upsertAppActivity('day-recent', {
    id: 'activity-spanning-cutoff',
    appName: 'Editor',
    bundleId: 'com.example.editor',
    startedAt: 1_500,
    endedAt: 3_500,
  })
  store.appendAudioMoment({
    id: 'audio-old',
    sessionId: 'day-recent',
    source: 'system',
    startedAt: 1_500,
    durationMs: 100,
    status: 'ready',
    transcript: 'Older searchable evidence.',
  })
  store.appendAudioMoment({
    id: 'audio-recent',
    sessionId: 'day-recent',
    source: 'system',
    startedAt: 3_000,
    durationMs: 100,
    status: 'ready',
    transcript: 'Recent removable evidence.',
  })
  store.appendAudioMoment({
    id: 'audio-overlapping',
    sessionId: 'day-recent',
    source: 'microphone',
    startedAt: 2_450,
    durationMs: 100,
    status: 'ready',
    transcript: 'Boundary evidence that overlaps the private window.',
  })
  store.appendSpeechSegments([
    {
      id: 'speech-old',
      workdayId: 'day-recent',
      chunkId: 'audio-old',
      source: 'system',
      startedAt: 1_500,
      endedAt: 1_600,
      text: 'Older raw transcript.',
      detectedLanguage: 'en',
      acceptedLanguage: 'en',
      rejectionReason: null,
    },
    {
      id: 'speech-overlapping',
      workdayId: 'day-recent',
      chunkId: 'audio-overlapping',
      source: 'microphone',
      startedAt: 2_450,
      endedAt: 2_550,
      text: 'Raw transcript crossing the private cutoff.',
      detectedLanguage: 'en',
      acceptedLanguage: 'en',
      rejectionReason: null,
    },
    {
      id: 'speech-recent',
      workdayId: 'day-recent',
      chunkId: 'audio-recent',
      source: 'system',
      startedAt: 3_000,
      endedAt: 3_100,
      text: 'Raw transcript inside the private window.',
      detectedLanguage: 'en',
      acceptedLanguage: 'en',
      rejectionReason: null,
    },
  ])
  store.createManualMeeting('day-recent', 'Private call', 2_400)

  assert.deepEqual(store.deleteEvidenceSince(2_500), ['day-recent'])
  const [loaded] = store.readSessions()
  assert.equal(loaded?.appActivity[0]?.endedAt, 2_500)
  assert.deepEqual(
    loaded?.moments.map((moment) => moment.id),
    ['audio-old']
  )
  assert.equal(store.search('older').length, 1)
  assert.equal(store.search('removable').length, 0)
  assert.equal(store.search('boundary').length, 0)
  assert.equal(store.activeManualMeeting(), null)
  assert.deepEqual(
    store.listSpeechSegments('day-recent').map((segment) => segment.id),
    ['speech-old']
  )
  assert.deepEqual(
    (await store.readAnalysisEvidence('day-recent')).filter((entry) => entry.kind === 'transcript'),
    [
      {
        timestamp: 1_500,
        endedAt: 1_600,
        evidenceId: 'speech:speech-old',
        kind: 'transcript',
        source: 'system',
        text: 'Older raw transcript.',
      },
    ]
  )
  store.close()
})

test('enforces one workday per local calendar day', () => {
  const store = createStore()
  const startedAt = new Date(2026, 7, 12, 9).getTime()
  const session = {
    id: 'day-one',
    startedAt,
    endedAt: startedAt + 60_000,
    activeDurationMs: 60_000,
    moments: [],
    appActivity: [],
    contextMoments: [],
    memory: null,
    refresh: { status: 'idle' as const, reason: null, targetThrough: null, error: null, progress: null, run: null },
  }
  store.upsertSession(session)
  assert.throws(() => store.upsertSession({ ...session, id: 'day-two', startedAt: startedAt + 60 * 60_000 }))
  assert.deepEqual(
    store.readSessions().map((day) => day.id),
    ['day-one']
  )
  store.close()
})

test('keeps captured calendar identity immutable after timezone travel', () => {
  const path = join(tmpdir(), `remember-evidence-${randomUUID()}.sqlite`)
  paths.push(path, `${path}-wal`, `${path}-shm`)
  const previousTimezone = process.env.TZ
  try {
    process.env.TZ = 'Europe/Amsterdam'
    const store = new EvidenceStore(path)
    for (const [id, startedAt] of [
      ['old-day', Date.parse('2026-08-27T12:00:00Z')],
      ['travel-day', Date.parse('2026-08-28T01:30:00Z')],
    ] as const) {
      store.upsertSession({
        id,
        startedAt,
        endedAt: null,
        activeDurationMs: 0,
        moments: [],
        appActivity: [],
        contextMoments: [],
        memory: null,
        refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
      })
    }
    store.close()

    process.env.TZ = 'America/New_York'
    const traveled = new EvidenceStore(path)
    assert.deepEqual(
      traveled
        .readSessions()
        .map((session) => session.id)
        .sort(),
      ['old-day', 'travel-day']
    )
    traveled.close()

    const database = new DatabaseSync(path)
    const localDays = database
      .prepare('SELECT id, local_day FROM workday ORDER BY id')
      .all()
      .map((row) => ({ id: String(row.id), local_day: String(row.local_day) }))
    assert.deepEqual(localDays, [
      { id: 'old-day', local_day: '2026-08-27' },
      { id: 'travel-day', local_day: '2026-08-28' },
    ])
    database.close()
  } finally {
    process.env.TZ = previousTimezone
  }
})

test('persists startup meeting imports without duplicate Days after travel and restart', () => {
  const previousTimezone = process.env.TZ
  const path = join(tmpdir(), `remember-travel-${randomUUID()}.sqlite`)
  paths.push(path, `${path}-wal`, `${path}-shm`)
  const imported = {
    id: 'travel-meeting',
    title: 'Synthetic travel meeting',
    status: 'finished' as const,
    date: '2026-09-24T15:00:00Z',
    updatedAt: '2026-09-24T15:01:00Z',
    participants: [],
    summary: null,
    actionItems: [],
    durationSeconds: 60,
    transcript: 'Synthetic fixture',
  }
  try {
    process.env.TZ = 'Europe/Amsterdam'
    const initial = new EvidenceStore(path)
    initial.upsertSession({
      id: 'captured-day',
      startedAt: Date.parse('2026-09-23T22:00:00Z'),
      endedAt: Date.parse('2026-09-24T16:00:00Z'),
      activeDurationMs: 60_000,
      moments: [],
      appActivity: [],
      contextMoments: [],
      memory: null,
      refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
    })
    initial.close()
    for (const timezone of ['America/Los_Angeles', 'Europe/Amsterdam', 'Asia/Tokyo']) {
      process.env.TZ = timezone
      const restarted = new EvidenceStore(path)
      try {
        const days = mergeRevinoteMeetings(restarted.readSessions(), [imported])
        assert.equal(days.length, 1)
        assert.equal(days[0]?.id, 'captured-day')
        assert.equal(days[0]?.localDay, '2026-09-24')
        for (const day of days) restarted.upsertSession(day)
        assert.equal(restarted.readSessions().length, 1)
      } finally {
        restarted.close()
      }
    }
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ
    else process.env.TZ = previousTimezone
  }
})

test('migrates and consolidates duplicate v2 workdays without deleting the database', () => {
  const path = join(tmpdir(), `remember-evidence-${randomUUID()}.sqlite`)
  paths.push(path, `${path}-wal`, `${path}-shm`)
  const legacy = new DatabaseSync(path)
  legacy.exec(`
    CREATE TABLE workday (
      id TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      active_duration_ms INTEGER NOT NULL DEFAULT 0,
      memory_json TEXT,
      memory_refreshed_at INTEGER,
      memory_covered_through INTEGER,
      refresh_status TEXT NOT NULL DEFAULT 'idle',
      refresh_reason TEXT,
      refresh_target_through INTEGER,
      refresh_error TEXT,
      refresh_progress_json TEXT,
      refresh_run_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    PRAGMA user_version = 2;
  `)
  const startedAt = new Date(2026, 7, 11, 9).getTime()
  const insert = legacy.prepare(
    `INSERT INTO workday (
      id, started_at, ended_at, active_duration_ms, refresh_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'idle', ?, ?)`
  )
  insert.run('older', startedAt, startedAt + 60_000, 60_000, startedAt, startedAt)
  insert.run('newer', startedAt + 1_000, startedAt + 120_000, 120_000, startedAt + 1_000, startedAt + 2_000)
  legacy.close()

  const migrated = new EvidenceStore(path)
  const sessions = migrated.readSessions()
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0]?.id, 'newer')
  assert.equal(sessions[0]?.startedAt, startedAt)
  assert.equal(sessions[0]?.activeDurationMs, 120_000)
  migrated.close()
})

test('migrates schema v5 audio evidence to preserve media playback context', () => {
  const path = join(tmpdir(), `remember-evidence-${randomUUID()}.sqlite`)
  paths.push(path, `${path}-wal`, `${path}-shm`)
  const legacy = new DatabaseSync(path)
  legacy.exec(`
    CREATE TABLE workday (
      id TEXT PRIMARY KEY,
      local_day TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      active_duration_ms INTEGER NOT NULL DEFAULT 0,
      memory_json TEXT,
      memory_refreshed_at INTEGER,
      memory_covered_through INTEGER,
      refresh_status TEXT NOT NULL DEFAULT 'idle',
      refresh_reason TEXT,
      refresh_target_through INTEGER,
      refresh_error TEXT,
      refresh_progress_json TEXT,
      refresh_run_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE audio_evidence (
      id TEXT PRIMARY KEY,
      workday_id TEXT NOT NULL REFERENCES workday(id) ON DELETE CASCADE,
      source TEXT NOT NULL CHECK(source IN ('microphone', 'system')),
      started_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      average_level REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK(status IN ('transcribing', 'ready', 'empty', 'failed')),
      transcript TEXT NOT NULL DEFAULT ''
    ) STRICT;
    PRAGMA user_version = 5;
  `)
  legacy.close()

  const migrated = new EvidenceStore(path)
  migrated.upsertSession({
    id: 'day-v5',
    startedAt: 1_000,
    endedAt: null,
    activeDurationMs: 0,
    moments: [],
    appActivity: [],
    contextMoments: [],
    memory: null,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  })
  migrated.appendAudioMoment({
    id: 'audio-v5',
    sessionId: 'day-v5',
    source: 'microphone',
    startedAt: 1_000,
    durationMs: 30_000,
    status: 'ready',
    transcript: 'Dialogue playing from a television.',
    mediaPlayback: {
      isPlaying: true,
      bundleIdentifier: 'org.videolan.vlc',
      applicationName: 'VLC',
    },
  })

  assert.deepEqual(migrated.readSessions()[0]?.moments[0]?.mediaPlayback, {
    isPlaying: true,
    bundleIdentifier: 'org.videolan.vlc',
    applicationName: 'VLC',
  })
  migrated.close()
})

test('migrates schema v14 work-item sources to durable conversation action identity', () => {
  const path = join(tmpdir(), `remember-evidence-${randomUUID()}.sqlite`)
  paths.push(path, `${path}-wal`, `${path}-shm`)
  const current = new EvidenceStore(path)
  current.close()

  const legacy = new DatabaseSync(path)
  legacy.exec(`
    DROP INDEX IF EXISTS work_item_source_conversation_action;
    ALTER TABLE work_item_source DROP COLUMN conversation_action_id;
    PRAGMA user_version = 14;
  `)
  legacy.close()

  const migrated = new EvidenceStore(path)
  migrated.synchronizeConversationActionPoints({
    workdayId: 'day-v14-action',
    conversations: [
      {
        episodeId: 'episode-v14-action',
        startTime: '09:00',
        endTime: '09:30',
        title: 'Migration review',
        description: 'One follow-up was agreed.',
        actionPoints: ['Verify the migrated link'],
      },
    ],
    observedAt: 1_000,
  })

  assert.equal(migrated.listWorkItems()[0]?.sources[0]?.conversationActionId, 'episode:episode-v14-action:action:0')
  migrated.close()
})

test('imports legacy Day task state once without resynchronizing later snapshots', () => {
  const path = join(tmpdir(), `remember-evidence-${randomUUID()}.sqlite`)
  paths.push(path, `${path}-wal`, `${path}-shm`)
  const session: DailyReviewSession = {
    id: 'day-legacy-import',
    startedAt: 1000,
    endedAt: null,
    activeDurationMs: 0,
    moments: [],
    appActivity: [],
    contextMoments: [],
    memory: {
      summary: '',
      currentFocus: null,
      outcomes: [],
      decisions: [],
      openLoops: [],
      openTasks: [],
      taskRecords: [
        {
          id: 'legacy-release-task',
          task: {
            id: 'legacy-release-task',
            title: 'Review the release',
            description: 'Check the final build.',
          },
          state: 'completed',
          createdAt: 1_100,
          updatedAt: 2_000,
          events: [
            {
              id: 'legacy-completed',
              type: 'completed',
              at: 2_000,
              title: 'Review the release',
              reason: 'The final build was checked.',
            },
          ],
        },
      ],
      conversations: [],
      timeline: [],
      knowledgeSuggestions: [],
      refreshedAt: 2_000,
      coveredThrough: 2_000,
    },
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  }

  const store = new EvidenceStore(path)
  store.upsertSession(session)
  assert.deepEqual(store.listWorkItems(), [])
  store.close()

  const reopened = new EvidenceStore(path)
  const [imported] = reopened.listWorkItems()
  assert.equal(imported?.title, 'Review the release')
  assert.equal(imported?.lifecycle, 'completed')
  assert.equal(imported?.facts.at(-1)?.summary, 'The final build was checked.')
  assert.ok(session.memory)
  reopened.upsertSession({
    ...session,
    memory: {
      ...session.memory,
      openLoops: ['Stale rewrite'],
      openTasks: [{ id: 'legacy-release-task', title: 'Stale rewrite', description: 'Old analysis.' }],
      taskRecords: session.memory.taskRecords?.map((record) => ({
        ...record,
        task: { ...record.task, title: 'Stale rewrite', description: 'Old analysis.' },
        state: 'open' as const,
        updatedAt: 3_000,
      })),
      refreshedAt: 3_000,
      coveredThrough: 3_000,
    },
  })
  reopened.close()

  const migratedAgain = new EvidenceStore(path)
  assert.equal(migratedAgain.listWorkItems().length, 1)
  assert.equal(migratedAgain.listWorkItems()[0]?.title, 'Review the release')
  assert.equal(migratedAgain.listWorkItems()[0]?.lifecycle, 'completed')
  migratedAgain.close()
})

test('stores durable work items independently from a workday', () => {
  const store = createStore()
  const created = store.createWorkItem('Prepare the release', 'Verify the signed build.')
  assert.equal(created.lifecycle, 'open')
  assert.equal(created.returnPoint.lastMove, 'Door jou aan Inbox toegevoegd.')
  assert.equal(created.returnPoint.unresolved, 'Verify the signed build.')
  assert.equal(created.sources[0]?.kind, 'manual')
  assert.equal(created.sources[0]?.conversationStartTime, null)
  assert.equal(created.facts[0]?.actor, 'user')

  const updated = store.updateWorkItem(created.id, 'Prepare release notes', 'Verify and publish the signed build.')
  assert.equal(updated.userEditedTitle, true)
  assert.equal(updated.returnPoint.unresolved, 'Verify and publish the signed build.')
  assert.equal(updated.facts.at(-1)?.type, 'edited')

  const running = store.startWorkItemAgentSession(created.id, {
    sessionId: 'agent-session-1',
    provider: 'codex',
    prompt: 'Prepare the release notes.',
    message: 'Pak dit op.',
    startedAt: 2000,
  })
  assert.equal(running.attention, 'agent_running')
  assert.equal(running.agentSessions[0]?.status, 'running')

  const finished = store.finishWorkItemAgentSession(created.id, 'agent-session-1', {
    response: 'De release notes zijn voorbereid.',
    durationMs: 500,
    steps: [],
  })
  assert.equal(finished.attention, 'idle')
  assert.equal(finished.agentSessions[0]?.status, 'completed')

  const completed = store.setWorkItemLifecycle(created.id, 'completed')
  assert.equal(completed.lifecycle, 'completed')
  assert.equal(completed.facts.at(-1)?.type, 'completed')
  store.close()
})

test('recovers interrupted Inbox agent sessions once after restart', () => {
  const path = join(tmpdir(), `remember-evidence-${randomUUID()}.sqlite`)
  paths.push(path, `${path}-wal`, `${path}-shm`)
  const startedAt = Date.now() - 2_000
  const store = new EvidenceStore(path)
  const interrupted = store.createWorkItem('Prepare the handoff', 'Collect the remaining release evidence.')
  const completed = store.createWorkItem('Publish the notes', 'Share the approved release notes.')
  const manuallyActive = store.createWorkItem('Review the build', 'Keep this item under manual review.')

  store.startWorkItemAgentSession(interrupted.id, {
    sessionId: 'interrupted-session',
    provider: 'codex',
    prompt: 'Prepare the handoff.',
    message: 'Pak dit op.',
    startedAt,
  })
  store.startWorkItemAgentSession(completed.id, {
    sessionId: 'completed-session',
    provider: 'claude',
    prompt: 'Publish the notes.',
    message: 'Pak dit op.',
    startedAt,
  })
  store.finishWorkItemAgentSession(completed.id, 'completed-session', {
    response: 'De release notes zijn gepubliceerd.',
    durationMs: 500,
    steps: [],
  })
  store.close()

  const database = new DatabaseSync(path)
  database.prepare("UPDATE work_item SET attention = 'user_active' WHERE id = ?").run(manuallyActive.id)
  database.close()

  const reopened = new EvidenceStore(path)
  const recovered = reopened.getWorkItem(interrupted.id)
  assert.equal(recovered?.attention, 'idle')
  assert.equal(recovered?.lifecycle, 'open')
  const recoveredSession = recovered?.agentSessions.find((session) => session.id === 'interrupted-session')
  assert.equal(recoveredSession?.status, 'stale')
  assert.ok(recoveredSession?.completedAt)
  assert.equal(recoveredSession.durationMs, recoveredSession.completedAt - startedAt)
  assert.deepEqual(
    recovered?.facts.filter((fact) => fact.id === 'interrupted-session:stale'),
    [
      {
        id: 'interrupted-session:stale',
        type: 'agent_failed',
        actor: 'system',
        summary: 'Agentsessie onderbroken door een herstart van Remember.',
        at: recoveredSession.completedAt,
        agentSessionId: 'interrupted-session',
      },
    ]
  )
  assert.equal(reopened.getWorkItem(completed.id)?.agentSessions[0]?.status, 'completed')
  assert.equal(reopened.getWorkItem(manuallyActive.id)?.attention, 'user_active')
  reopened.close()

  const reopenedAgain = new EvidenceStore(path)
  assert.equal(
    reopenedAgain.getWorkItem(interrupted.id)?.facts.filter((fact) => fact.id === 'interrupted-session:stale').length,
    1
  )
  reopenedAgain.close()
})

test('persists Inbox planning metadata independently from task content', () => {
  const store = createStore()
  const item = store.createWorkItem('Ship the field test', 'Verify the installed relaunch.')
  const dueAt = new Date('2026-09-02T12:00:00').getTime()

  const updated = store.updateWorkItemMetadata(item.id, {
    status: 'in_progress',
    priority: 'high',
    dueAt,
  })

  assert.equal(updated.status, 'in_progress')
  assert.equal(updated.priority, 'high')
  assert.equal(updated.dueAt, dueAt)
  assert.equal(updated.title, item.title)
  assert.match(updated.facts.at(-1)?.summary ?? '', /Deadline bijgewerkt/)
  store.close()
})

test('persists a manual recording lifecycle and assembled episode', () => {
  const store = createStore()
  const session: DailyReviewSession = {
    id: 'manual-meeting-day',
    startedAt: 1000,
    endedAt: null,
    activeDurationMs: 0,
    moments: [],
    appActivity: [],
    contextMoments: [],
    memory: null,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  }
  store.upsertSession(session)

  const meeting = store.createManualMeeting(session.id, '', 1500, 2000, 1000, false)
  const adjusted = store.updateManualMeetingStart(meeting.id, 1000)
  const withSystemAudio = store.markManualMeetingSystemAudioAvailable(meeting.id)
  const finished = store.finishManualMeeting(meeting.id, 5000, true)
  const withEpisode = store.setManualMeetingEpisode(meeting.id, 'episode-manual-1')
  const processing = store.processingManualMeeting()
  const completed = store.completeManualMeeting(meeting.id)

  assert.equal(meeting.title, '')
  assert.equal(meeting.notes, '')
  assert.equal(meeting.startedAt, 1500)
  assert.equal(meeting.confirmedAt, 2000)
  assert.equal(meeting.availableFromAt, 1000)
  assert.equal(meeting.systemAudioAvailable, false)
  assert.equal(withSystemAudio.systemAudioAvailable, true)
  assert.equal(finished.systemAudioAvailable, true)
  assert.equal(completed.systemAudioAvailable, true)
  assert.equal(adjusted.startedAt, 1000)
  assert.equal(finished.status, 'processing')
  assert.equal(finished.automaticRevinoteProcessingBlocked, true)
  assert.equal(withEpisode.episodeId, 'episode-manual-1')
  assert.equal(processing?.episodeId, 'episode-manual-1')
  assert.equal(processing?.id, meeting.id)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.endedAt, 5000)
  assert.equal(completed.pausedAt, null)
  assert.equal(completed.pausedMs, 0)
  assert.equal(completed.title, '')
  assert.equal(completed.notes, '')
  assert.equal(store.activeManualMeeting(), null)
  assert.equal(store.processingManualMeeting(), null)
  assert.deepEqual(store.listManualMeetings(session.id), [completed])
  store.close()
})

test('tracks every pause, including when the meeting is stopped while paused', () => {
  const store = createStore()
  const session: DailyReviewSession = {
    id: 'manual-meeting-pause-day',
    startedAt: 1000,
    endedAt: null,
    activeDurationMs: 0,
    moments: [],
    appActivity: [],
    contextMoments: [],
    memory: null,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  }
  store.upsertSession(session)

  const meeting = store.createManualMeeting(session.id, 'Standup', 2000)
  const paused = store.pauseManualMeeting(meeting.id, 3500)
  const resumed = store.resumeManualMeeting(meeting.id, 5000)
  store.pauseManualMeeting(meeting.id, 6000)
  const finished = store.finishManualMeeting(meeting.id, 8000)

  assert.equal(paused.pausedAt, 3500)
  assert.equal(paused.pausedMs, 0)
  assert.equal(resumed.pausedAt, null)
  assert.equal(resumed.pausedMs, 1500)
  assert.equal(resumed.status, 'recording')
  assert.equal(finished.endedAt, 8000)
  assert.equal(finished.pausedAt, null)
  assert.equal(finished.pausedMs, 3500)
  assert.equal(finished.status, 'processing')
  store.close()
})

test('lists every manual meeting still processing in recording order', () => {
  const store = createStore()
  const session: DailyReviewSession = {
    id: 'manual-meeting-processing-day',
    startedAt: 1000,
    endedAt: null,
    activeDurationMs: 0,
    moments: [],
    appActivity: [],
    contextMoments: [],
    memory: null,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  }
  store.upsertSession(session)

  const first = store.createManualMeeting(session.id, '', 2000)
  store.finishManualMeeting(first.id, 3000)
  const second = store.createManualMeeting(session.id, '', 4000)
  store.finishManualMeeting(second.id, 5000)

  assert.deepEqual(
    store.processingManualMeetings().map((meeting) => meeting.id),
    [first.id, second.id]
  )
  store.close()
})

test('discards a manual meeting and its overlapping audio evidence', async () => {
  const store = createStore()
  const session: DailyReviewSession = {
    id: 'discarded-manual-meeting',
    startedAt: 1000,
    endedAt: null,
    activeDurationMs: 0,
    moments: [],
    appActivity: [],
    contextMoments: [],
    memory: null,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  }
  store.upsertSession(session)
  store.appendAudioMoment(
    {
      id: 'before-meeting',
      sessionId: session.id,
      source: 'microphone',
      startedAt: 1000,
      durationMs: 500,
      status: 'ready',
      transcript: 'Keep this',
    },
    0.4
  )
  store.appendAudioMoment(
    {
      id: 'inside-meeting',
      sessionId: session.id,
      source: 'microphone',
      startedAt: 2500,
      durationMs: 500,
      status: 'ready',
      transcript: 'Delete this',
    },
    0.4
  )
  store.appendSpeechSegments([
    {
      id: 'speech-before-meeting',
      workdayId: session.id,
      chunkId: 'before-meeting',
      source: 'microphone',
      startedAt: 1_000,
      endedAt: 1_500,
      text: 'Keep this raw transcript',
      detectedLanguage: 'en',
      acceptedLanguage: 'en',
      rejectionReason: null,
    },
    {
      id: 'speech-overlapping-meeting',
      workdayId: session.id,
      chunkId: 'inside-meeting',
      source: 'microphone',
      startedAt: 1_900,
      endedAt: 2_100,
      text: 'Delete this overlapping raw transcript',
      detectedLanguage: 'en',
      acceptedLanguage: 'en',
      rejectionReason: null,
    },
  ])
  const meeting = store.createManualMeeting(session.id, 'Discard me', 2000)
  store.appendCallSignal({
    id: `manual-meeting:${meeting.id}:active`,
    workdayId: session.id,
    provider: 'manual',
    surfaceKey: `manual:${meeting.id}`,
    state: 'active',
    observedAt: 2000,
  })

  store.discardManualMeeting(meeting.id, 3500)

  assert.equal(store.activeManualMeeting(), null)
  assert.deepEqual(store.listManualMeetings(session.id), [])
  assert.deepEqual(store.listCallSignals(session.id), [])
  assert.deepEqual(
    store.readSessions()[0]?.moments.map((moment) => moment.id),
    ['before-meeting']
  )
  assert.deepEqual(
    store.listSpeechSegments(session.id).map((segment) => segment.id),
    ['speech-before-meeting']
  )
  assert.deepEqual(
    (await store.readAnalysisEvidence(session.id)).filter((entry) => entry.kind === 'transcript'),
    [
      {
        timestamp: 1_000,
        endedAt: 1_500,
        evidenceId: 'speech:speech-before-meeting',
        kind: 'transcript',
        source: 'microphone',
        text: 'Keep this raw transcript',
      },
    ]
  )
  store.close()
})

test('applies analyzed work by durable identity without duplicating or overwriting user copy', () => {
  const store = createStore()
  store.upsertSession({
    id: 'day-analyzed-work',
    startedAt: 1_000,
    endedAt: null,
    activeDurationMs: 0,
    moments: [],
    appActivity: [],
    contextMoments: [],
    memory: null,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  })
  appendScreenEvidence(store, 'day-analyzed-work', 'renderer-evidence', 1_150)
  const firstPlan = {
    proposed: [
      {
        title: 'Verify the renderer',
        description: 'Check the narrow layout.',
        prompt: 'Open the renderer at 520 px.',
        context: 'Desktop QA passed; narrow-window QA remains.',
        returnPoint: {
          lastMove: 'Desktop QA passed.',
          unresolved: 'Narrow-window QA remains.',
          nextMove: 'Open the renderer at 520 px.',
        },
        source: {
          kind: 'task' as const,
          label: 'Renderer QA',
          detail: 'The narrow layout still needs proof.',
          evidenceId: 'renderer-evidence',
        },
      },
    ],
    changes: [],
  }

  assert.deepEqual(
    store.applyAnalyzedWorkItems({
      workdayId: 'day-analyzed-work',
      plan: firstPlan,
      conversations: [],
      analysisStartedAt: 1_100,
      observedAt: 1_200,
    }),
    { created: 1, updated: 0, closed: 0 }
  )
  const [created] = store.listWorkItems()
  assert.ok(created)
  assert.deepEqual(
    store.applyAnalyzedWorkItems({
      workdayId: 'day-analyzed-work',
      plan: firstPlan,
      conversations: [],
      analysisStartedAt: 1_300,
      observedAt: 1_400,
    }),
    { created: 0, updated: 0, closed: 0 }
  )
  assert.equal(store.listWorkItems().length, 1)

  const userEdited = store.updateWorkItem(created.id, 'Verify signed renderer', 'Install and inspect the signed app.')
  const updated = store.applyAnalyzedWorkItems({
    workdayId: 'day-analyzed-work',
    plan: {
      proposed: [
        {
          ...firstPlan.proposed[0],
          id: created.id,
          title: 'Model rewrite',
          description: 'Model rewrite.',
          prompt: 'Capture proof at 520 px.',
        },
      ],
      changes: [],
    },
    conversations: [],
    analysisStartedAt: userEdited.updatedAt,
    observedAt: userEdited.updatedAt + 1,
  })

  assert.deepEqual(updated, { created: 0, updated: 1, closed: 0 })
  const persisted = store.getWorkItem(created.id)
  assert.equal(persisted?.title, 'Verify signed renderer')
  assert.equal(persisted?.description, 'Install and inspect the signed app.')
  assert.equal(persisted?.prompt, 'Capture proof at 520 px.')
  assert.equal(persisted?.sources.length, 1)
  assert.equal(persisted?.sources[0]?.observedAt, 1_150)
  store.close()
})

test('persists optional AI offers across restart and clears them when analysis identifies personal work', () => {
  const path = join(tmpdir(), `remember-ai-suggestion-${randomUUID()}.sqlite`)
  paths.push(path, `${path}-wal`, `${path}-shm`)
  let store = new EvidenceStore(path)
  store.upsertSession({
    id: 'ai-offers-day',
    startedAt: 1_000,
    endedAt: null,
    activeDurationMs: 0,
    moments: [],
    appActivity: [],
    contextMoments: [],
    memory: null,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  })
  appendScreenEvidence(store, 'ai-offers-day', 'ai-offer-evidence', 1_100)
  const task = {
    title: 'Make a PDF',
    description: 'Collect the answers.',
    prompt: 'Create the PDF.',
    aiSuggestion: 'Want me to make a PDF with the answers?',
    source: { kind: 'task' as const, label: 'Answers', detail: 'PDF still needed.', evidenceId: 'ai-offer-evidence' },
  }
  const input = { workdayId: 'ai-offers-day', conversations: [], analysisStartedAt: 1_200, observedAt: 1_300 }
  store.applyAnalyzedWorkItems({ ...input, plan: { proposed: [task], changes: [] } })
  const created = store.listWorkItems()[0]
  assert.ok(created)
  assert.equal(created.aiSuggestion, task.aiSuggestion)
  store.close()
  store = new EvidenceStore(path)
  assert.equal(store.getWorkItem(created.id)?.aiSuggestion, task.aiSuggestion)

  store.applyAnalyzedWorkItems({
    ...input,
    analysisStartedAt: 1_400,
    observedAt: 1_500,
    plan: { proposed: [{ ...task, id: created.id, aiSuggestion: undefined }], changes: [] },
  })
  assert.equal(store.getWorkItem(created.id)?.aiSuggestion, task.aiSuggestion)
  store.applyAnalyzedWorkItems({
    ...input,
    analysisStartedAt: 1_600,
    observedAt: 1_700,
    plan: { proposed: [{ ...task, id: created.id, aiSuggestion: null }], changes: [] },
  })
  assert.equal(store.getWorkItem(created.id)?.aiSuggestion, null)
  store.close()
  store = new EvidenceStore(path)
  assert.equal(store.getWorkItem(created.id)?.aiSuggestion, null)
  assert.equal(store.getWorkItem(created.id)?.lifecycle, 'open')
  store.close()

  // Simulate an older archive: an existing brief does not opt the task into AI.
  const database = new DatabaseSync(path)
  database.exec('ALTER TABLE work_item DROP COLUMN ai_suggestion')
  database.close()
  store = new EvidenceStore(path)
  assert.equal(store.getWorkItem(created.id)?.aiSuggestion, null)
  assert.equal(store.getWorkItem(created.id)?.prompt, task.prompt)
  store.close()
})

test('rejects generated Inbox items whose source does not resolve to persisted evidence', () => {
  const store = createStore()
  store.upsertSession({
    id: 'day-source-invariant',
    startedAt: 1_000,
    endedAt: null,
    activeDurationMs: 0,
    moments: [],
    appActivity: [],
    contextMoments: [],
    memory: null,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  })
  appendScreenEvidence(store, 'day-source-invariant', 'persisted-evidence', 1_100)
  const manual = store.createWorkItem('Manual reminder', 'Keep the user-created item.')

  const result = store.applyAnalyzedWorkItems({
    workdayId: 'day-source-invariant',
    plan: {
      proposed: [
        {
          title: 'Keep grounded task',
          description: 'Continue the evidenced workflow.',
          source: {
            kind: 'task',
            label: 'Grounded workflow',
            detail: 'Concrete evidence shows residual work.',
            evidenceId: 'persisted-evidence',
          },
        },
        { title: 'Fabricated fallback', description: 'This has no source.' },
        {
          title: 'Unknown screen source',
          description: 'This source is not persisted.',
          source: {
            kind: 'task',
            label: 'Unknown workflow',
            detail: 'The model invented this evidence.',
            evidenceId: 'missing-evidence',
          },
        },
        {
          title: 'Unknown meeting source',
          description: 'This meeting does not exist.',
          source: {
            kind: 'conversation',
            label: 'Missing meeting',
            detail: 'The model invented this meeting.',
            conversationStartTime: '09:30',
          },
        },
      ],
      changes: [],
    },
    conversations: [],
    analysisStartedAt: 1_200,
    observedAt: 1_300,
  })

  assert.deepEqual(result, { created: 1, updated: 0, closed: 0 })
  assert.deepEqual(
    store
      .listWorkItems()
      .map((item) => item.title)
      .sort(),
    ['Keep grounded task', 'Manual reminder']
  )
  assert.equal(store.getWorkItem(manual.id)?.sources[0]?.kind, 'manual')
  const generated = store.listWorkItems().find((item) => item.id !== manual.id)
  assert.equal(generated?.sources[0]?.kind, 'observed')
  assert.equal(generated?.sources[0]?.observedAt, 1_100)
  store.close()
})

test('Remember screen output cannot create tasks or reinforce canonical user work', () => {
  const store = createStore()
  const workdayId = 'day-remember-derived-output'
  store.upsertSession({
    id: workdayId,
    startedAt: 1_000,
    endedAt: null,
    activeDurationMs: 0,
    moments: [],
    appActivity: [],
    contextMoments: [],
    memory: null,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  })
  const manual = store.createWorkItem('Write the Atlas intro', 'Use the fictional project for the demo.')
  const derivedText =
    'Open day overview\nDay update\n2026-10-28\nFeiten van het verzonnen project Atlas: een TypeScript-planningsinterface gebouwd; handmatige planningsstappen van zes naar twee teruggebracht.'
  const proposals = [
    { appName: 'Remember', bundleId: 'computer.remember.app' },
    { appName: 'Renamed personal build', bundleId: 'computer.remember.qa' },
    { appName: 'Remember', bundleId: '' },
  ].flatMap((application, index) => {
    const evidenceId = `remember-rendered-${index}`
    store.appendContextMoment(
      workdayId,
      {
        id: evidenceId,
        timestamp: 1_100 + index,
        appName: application.appName,
        windowTitle: 'Agent',
        text: derivedText,
        textSource: 'accessibility',
        trigger: 'window-change',
        monitorName: 'Built-in',
        screenshotPath: '',
      },
      null,
      application.bundleId
    )
    const source = {
      kind: 'task' as const,
      evidenceId,
      label: 'Atlas data cleanup',
      detail: 'Remove fictional Atlas data before continuing.',
    }
    return [
      { title: 'Remove fictional Atlas data', description: 'Clean up the fictional project.', source },
      {
        id: manual.id,
        title: manual.title,
        description: 'Remove fictional Atlas data before writing the intro.',
        prompt: 'Delete the fictional project.',
        source,
      },
    ]
  })
  const result = store.applyAnalyzedWorkItems({
    workdayId,
    plan: { proposed: proposals, changes: [] },
    conversations: [],
    analysisStartedAt: manual.updatedAt,
    observedAt: manual.updatedAt + 1,
  })

  assert.deepEqual(result, { created: 0, updated: 0, closed: 0 })
  assert.deepEqual(store.listWorkItems(), [manual])
  store.close()
})

test('original notes and conversation records remain task evidence when they discuss Remember', () => {
  const store = createStore()
  const workdayId = 'day-original-intent'
  store.upsertSession({
    id: workdayId,
    startedAt: 1_000,
    endedAt: null,
    activeDurationMs: 0,
    moments: [],
    appActivity: [],
    contextMoments: [],
    memory: null,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  })
  store.appendContextMoment(
    workdayId,
    {
      id: 'original-user-note',
      timestamp: 1_100,
      appName: 'Notes',
      windowTitle: 'Remember cleanup',
      text: 'I will remove the fictional Atlas data after the demo.',
      textSource: 'accessibility',
      trigger: 'window-change',
      monitorName: 'Built-in',
      screenshotPath: '',
    },
    null,
    'com.apple.Notes'
  )
  const conversation = {
    episodeId: 'original-planning-conversation',
    startTime: '09:30',
    endTime: '10:00',
    title: 'Remember demo planning',
    description: 'We agreed to prepare the real demo.',
    actionPoints: ['Prepare the real demo'],
  }
  const result = store.applyAnalyzedWorkItems({
    workdayId,
    plan: {
      proposed: [
        {
          title: 'Remove fictional Atlas data',
          description: 'Clean up after the demo.',
          source: {
            kind: 'task',
            evidenceId: 'original-user-note',
            label: 'Remember cleanup',
            detail: 'I will remove the fictional Atlas data after the demo.',
          },
        },
        {
          title: 'Prepare the real demo',
          description: 'Prepare the agreed demonstration.',
          source: {
            kind: 'conversation',
            conversationStartTime: conversation.startTime,
            label: conversation.title,
            detail: 'We agreed to prepare the real demo.',
          },
        },
      ],
      changes: [],
    },
    conversations: [conversation],
    analysisStartedAt: 1_200,
    observedAt: 1_300,
  })

  assert.deepEqual(result, { created: 2, updated: 0, closed: 0 })
  assert.deepEqual(
    store
      .listWorkItems()
      .map((item) => item.sources[0]?.kind)
      .sort(),
    ['meeting', 'observed']
  )
  store.close()
})

test('keeps distinct actions from one conversation and never closes work by omission', () => {
  const store = createStore()
  store.upsertSession({
    id: 'day-shared-conversation',
    startedAt: 1_000,
    endedAt: null,
    activeDurationMs: 0,
    moments: [],
    appActivity: [],
    contextMoments: [],
    memory: null,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  })
  const conversation = {
    episodeId: 'episode-planning',
    startTime: '09:30',
    endTime: '10:00',
    title: 'Release planning',
    description: 'Release ownership was agreed.',
  }
  const source = {
    kind: 'conversation' as const,
    label: conversation.title,
    detail: 'Explicit release follow-ups.',
    conversationStartTime: conversation.startTime,
  }
  const proposed = [
    { title: 'Verify the build', description: 'Verify the signed build.', source },
    { title: 'Publish the notes', description: 'Publish the release notes.', source },
    { title: 'Notify the testers', description: 'Send testers the release update.', source },
  ]

  assert.deepEqual(
    store.applyAnalyzedWorkItems({
      workdayId: 'day-shared-conversation',
      plan: { proposed, changes: [] },
      conversations: [conversation],
      analysisStartedAt: 1_100,
      observedAt: 1_200,
    }),
    { created: 3, updated: 0, closed: 0 }
  )
  const items = store.listWorkItems()
  assert.equal(items.length, 3)
  assert.ok(items.every((item) => item.sources[0]?.conversationReference === 'episode:episode-planning'))

  const retained = items.find((item) => item.title === proposed[0]?.title)
  assert.ok(retained)
  store.applyAnalyzedWorkItems({
    workdayId: 'day-shared-conversation',
    plan: { proposed: [{ ...proposed[0], id: retained.id }], changes: [] },
    conversations: [conversation],
    analysisStartedAt: 1_300,
    observedAt: 1_400,
  })
  assert.equal(store.listWorkItems().length, 3)
  assert.ok(store.listWorkItems().every((item) => item.lifecycle === 'open'))
  store.close()
})

test('materializes conversation action points as durable Inbox items and preserves their lifecycle', () => {
  const store = createStore()
  const conversation = {
    episodeId: 'episode-action-points',
    startTime: '09:30',
    endTime: '10:00',
    title: 'Release planning',
    description: 'The release follow-up was agreed.',
    summary: 'The team agreed who would verify and publish the release.',
    actionPoints: ['Verify the signed build', 'Publish the release notes'],
  }

  assert.deepEqual(
    store.synchronizeConversationActionPoints({
      workdayId: 'day-action-points',
      conversations: [conversation],
      observedAt: 1_000,
    }),
    { created: 2, linked: 0, updated: 0 }
  )
  assert.equal(store.listWorkItems().length, 2)
  assert.ok(
    store
      .listWorkItems()
      .every(
        (item) =>
          item.sources[0]?.conversationReference === 'episode:episode-action-points' &&
          item.sources[0]?.conversationActionId?.startsWith('episode:episode-action-points:action:')
      )
  )

  const verify = store.listWorkItems().find((item) => item.title === 'Verify the signed build')
  assert.ok(verify)
  store.setWorkItemLifecycle(verify.id, 'completed')

  assert.deepEqual(
    store.synchronizeConversationActionPoints({
      workdayId: 'day-action-points',
      conversations: [conversation],
      observedAt: 2_000,
    }),
    { created: 0, linked: 0, updated: 0 }
  )
  assert.equal(store.getWorkItem(verify.id)?.lifecycle, 'completed')
  store.close()
})

test('does not turn unlinked historical conversation actions into a surprise Inbox backlog', () => {
  const store = createStore()
  const conversation = {
    externalId: 'historical-meeting',
    source: 'revinote' as const,
    startTime: '09:30',
    endTime: '10:00',
    title: 'Historical planning',
    description: 'An older imported meeting.',
    actionPoints: ['An old action that was never tracked'],
  }

  assert.deepEqual(
    store.synchronizeConversationActionPoints({
      workdayId: 'day-historical-action',
      conversations: [conversation],
      observedAt: 1_000,
      createMissing: false,
    }),
    { created: 0, linked: 0, updated: 0 }
  )
  assert.deepEqual(store.listWorkItems(), [])
  store.close()
})

test('recovers a renamed action task with multiple meeting sources during historical synchronization', () => {
  const path = join(tmpdir(), `remember-evidence-${randomUUID()}.sqlite`)
  paths.push(path, `${path}-wal`, `${path}-shm`)
  const store = new EvidenceStore(path)
  const conversation = {
    episodeId: 'episode-recovered-actions',
    externalId: 'revinote-recovered-actions',
    source: 'revinote' as const,
    startTime: '12:22',
    endTime: '14:01',
    title: 'Travel and project planning',
    description: 'Travel and project follow-ups.',
    actionPointItems: [
      { id: 'revinote:recovered-actions:action:0', text: 'Hotels boeken tot aan Yosemite' },
      { id: 'revinote:recovered-actions:action:1', text: 'Finish the migration', completed: true },
      { id: 'revinote:recovered-actions:action:2', text: 'Prepare the remote setup', completed: true },
      { id: 'revinote:recovered-actions:action:3', text: 'Review the GitLab workflow', completed: true },
    ],
  }
  store.synchronizeConversationActionPoints({
    workdayId: 'day-recovered-actions',
    conversations: [{ ...conversation, actionPointItems: undefined, actionPoints: ['Look for Airbnb options'] }],
    observedAt: 900,
  })
  const [previousTask] = store.listWorkItems()
  assert.ok(previousTask)
  store.setWorkItemLifecycle(previousTask.id, 'completed')
  store.synchronizeConversationActionPoints({
    workdayId: 'day-recovered-actions',
    conversations: [conversation],
    observedAt: 1_000,
  })
  const hotelTask = store.listWorkItems().find((item) => item.title === 'Hotels boeken tot aan Yosemite')
  assert.ok(hotelTask)
  store.updateWorkItem(hotelTask.id, 'Book Yosemite lodging', hotelTask.description)
  store.close()

  const legacy = new DatabaseSync(path)
  legacy.prepare('UPDATE work_item_source SET conversation_action_id = NULL WHERE work_item_id = ?').run(hotelTask.id)
  for (let index = 0; index < 4; index += 1) {
    legacy
      .prepare(
        `INSERT INTO work_item_source
         (id, work_item_id, kind, label, detail, workday_id, conversation_reference,
          conversation_action_id, conversation_start_time, observed_at, confidence)
         SELECT ?, work_item_id, kind, label, ?, workday_id, conversation_reference,
                NULL, conversation_start_time, ?, confidence
         FROM work_item_source WHERE id = ?`
      )
      .run(
        `additional-hotel-source-${index}`,
        `Updated booking context ${index}`,
        1_100 + index,
        hotelTask.sources[0].id
      )
  }
  legacy.close()

  const restored = new EvidenceStore(path)
  assert.deepEqual(
    restored.synchronizeConversationActionPoints({
      workdayId: 'day-recovered-actions',
      conversations: [conversation],
      observedAt: 2_000,
      createMissing: false,
    }),
    { created: 0, linked: 1, updated: 0 }
  )
  const items = restored.listWorkItems()
  assert.equal(items.length, 5)
  assert.equal(restored.getWorkItem(previousTask.id)?.title, 'Look for Airbnb options')
  assert.equal(restored.getWorkItem(previousTask.id)?.lifecycle, 'completed')
  for (const actionPoint of conversationActionPointItems(conversation)) {
    const item = workItemForConversationActionPoint(items, conversation, actionPoint)
    assert.ok(item)
    assert.equal(item.lifecycle, actionPoint.completed ? 'completed' : 'open')
  }
  const recovered = restored.getWorkItem(hotelTask.id)
  assert.equal(recovered?.title, 'Book Yosemite lodging')
  assert.equal(recovered?.userEditedTitle, true)
  assert.equal(recovered?.sources.length, 5)
  assert.deepEqual(
    restored.synchronizeConversationActionPoints({
      workdayId: 'day-recovered-actions',
      conversations: [conversation],
      observedAt: 3_000,
      createMissing: false,
    }),
    { created: 0, linked: 0, updated: 0 }
  )
  restored.close()
})

test('resolves reordered action text before an edited action can claim its old provider slot', () => {
  const store = createStore()
  const conversation = {
    episodeId: 'episode-reordered-actions',
    startTime: '09:30',
    endTime: '10:00',
    title: 'Release planning',
    description: 'Two release follow-ups.',
    actionPoints: ['Verify the signed build', 'Publish the release notes'],
  }
  store.synchronizeConversationActionPoints({
    workdayId: 'day-reordered-actions',
    conversations: [conversation],
    observedAt: 1_000,
  })
  const verify = store.listWorkItems().find((item) => item.title === 'Verify the signed build')
  const publish = store.listWorkItems().find((item) => item.title === 'Publish the release notes')
  assert.ok(verify)
  assert.ok(publish)
  store.setWorkItemLifecycle(verify.id, 'completed')

  const reordered = { ...conversation, actionPoints: ['Publish the revised release notes', 'Verify the signed build'] }
  store.synchronizeConversationActionPoints({
    workdayId: 'day-reordered-actions',
    conversations: [reordered],
    observedAt: 2_000,
    createMissing: false,
  })
  const [publishAction, verifyAction] = conversationActionPointItems(reordered)
  const items = store.listWorkItems()
  assert.equal(items.length, 2)
  assert.equal(workItemForConversationActionPoint(items, reordered, publishAction)?.id, publish.id)
  assert.equal(workItemForConversationActionPoint(items, reordered, verifyAction)?.id, verify.id)
  assert.equal(store.getWorkItem(verify.id)?.lifecycle, 'completed')
  assert.equal(store.getWorkItem(publish.id)?.lifecycle, 'open')
  store.close()
})

test('does not guess between multiple unlinked actions and renamed tasks', () => {
  const store = createStore()
  const conversation = {
    episodeId: 'episode-ambiguous-actions',
    startTime: '09:30',
    endTime: '10:00',
    title: 'Release planning',
    description: 'Two release follow-ups.',
  }
  store.applyAnalyzedWorkItems({
    workdayId: 'day-ambiguous-actions',
    conversations: [conversation],
    plan: {
      proposed: ['Verify the signed build', 'Publish the release notes'].map((title) => ({
        title,
        description: title,
        source: {
          kind: 'conversation' as const,
          label: conversation.title,
          detail: title,
          conversationStartTime: conversation.startTime,
        },
      })),
      changes: [],
    },
    analysisStartedAt: 1_000,
    observedAt: 1_100,
  })
  assert.deepEqual(
    store.synchronizeConversationActionPoints({
      workdayId: 'day-ambiguous-actions',
      conversations: [{ ...conversation, actionPoints: ['Share the updated changelog', 'Test the release'] }],
      observedAt: 2_000,
      createMissing: false,
    }),
    { created: 0, linked: 0, updated: 0 }
  )
  assert.equal(store.listWorkItems().length, 2)
  assert.ok(store.listWorkItems().every((item) => item.sources.every((source) => source.conversationActionId == null)))
  store.close()
})

test('counts distinct tasks when adopting a renamed legacy action with repeated meeting evidence', () => {
  const store = createStore()
  const conversation = {
    episodeId: 'episode-legacy-action',
    startTime: '09:30',
    endTime: '10:00',
    title: 'Release planning',
    description: 'One release follow-up.',
  }
  const proposed = {
    title: 'Publish notes',
    description: 'Publish notes.',
    source: {
      kind: 'conversation' as const,
      label: conversation.title,
      detail: 'Follow-up agreed in release planning.',
      conversationStartTime: conversation.startTime,
    },
  }
  store.applyAnalyzedWorkItems({
    workdayId: 'day-legacy-action',
    conversations: [conversation],
    plan: { proposed: [proposed], changes: [] },
    analysisStartedAt: 1_000,
    observedAt: 1_100,
  })
  const [original] = store.listWorkItems()
  assert.ok(original)
  store.applyAnalyzedWorkItems({
    workdayId: 'day-legacy-action',
    conversations: [conversation],
    plan: {
      proposed: [
        { ...proposed, id: original.id, source: { ...proposed.source, detail: 'Release is ready for notes.' } },
      ],
      changes: [],
    },
    analysisStartedAt: 1_200,
    observedAt: 1_300,
  })
  assert.equal(store.getWorkItem(original.id)?.sources.length, 2)

  assert.deepEqual(
    store.synchronizeConversationActionPoints({
      workdayId: 'day-legacy-action',
      conversations: [{ ...conversation, actionPoints: ['Publish the release notes'] }],
      observedAt: 2_000,
      createMissing: false,
    }),
    { created: 0, linked: 1, updated: 1 }
  )
  assert.equal(store.listWorkItems().length, 1)
  assert.equal(store.getWorkItem(original.id)?.title, 'Publish the release notes')
  store.close()
})

test('adopts the single analyzed item for a conversation action instead of duplicating it', () => {
  const store = createStore()
  const conversation = {
    episodeId: 'episode-adopt-action',
    startTime: '11:00',
    endTime: '11:30',
    title: 'Launch review',
    description: 'One launch follow-up remained.',
    actionPoints: ['Publish the launch notes'],
  }
  store.applyAnalyzedWorkItems({
    workdayId: 'day-adopt-action',
    plan: {
      proposed: [
        {
          title: 'Publish notes',
          description: 'Publish the launch notes.',
          source: {
            kind: 'conversation',
            label: conversation.title,
            detail: 'Follow-up agreed in launch review.',
            conversationStartTime: conversation.startTime,
          },
        },
      ],
      changes: [],
    },
    conversations: [conversation],
    analysisStartedAt: 1_000,
    observedAt: 1_100,
  })

  assert.deepEqual(
    store.synchronizeConversationActionPoints({
      workdayId: 'day-adopt-action',
      conversations: [conversation],
      observedAt: 1_100,
    }),
    { created: 0, linked: 0, updated: 1 }
  )
  const items = store.listWorkItems()
  assert.equal(items.length, 1)
  assert.equal(items[0]?.title, 'Publish the launch notes')
  assert.equal(items[0]?.sources[0]?.conversationActionId, 'episode:episode-adopt-action:action:0')
  store.close()
})

test('imports Revinote completion once without overwriting later local lifecycle choices', () => {
  const store = createStore()
  const conversation = {
    externalId: 'revinote-meeting',
    source: 'revinote' as const,
    startTime: '14:00',
    endTime: '14:30',
    title: 'Partner review',
    description: 'The partner review produced one follow-up.',
    actionPoints: ['Send the revised proposal'],
    actionPointItems: [
      { id: 'revinote:revinote-meeting:action:0', text: 'Send the revised proposal', completed: true },
    ],
  }

  store.synchronizeConversationActionPoints({
    workdayId: 'day-revinote-action',
    conversations: [conversation],
    observedAt: 1_000,
  })
  const [imported] = store.listWorkItems()
  assert.equal(imported?.lifecycle, 'completed')
  assert.ok(imported)
  store.setWorkItemLifecycle(imported.id, 'open')

  store.synchronizeConversationActionPoints({
    workdayId: 'day-revinote-action',
    conversations: [conversation],
    observedAt: 2_000,
  })
  assert.equal(store.getWorkItem(imported.id)?.lifecycle, 'open')
  store.close()
})

test('does not treat the same short title on a later day as durable identity', () => {
  const store = createStore()
  const proposal = {
    title: 'Send the update',
    description: 'Send the current project update.',
    source: {
      kind: 'conversation' as const,
      label: 'Project update',
      detail: 'A concrete update was agreed.',
      conversationStartTime: '09:30',
    },
  }

  store.applyAnalyzedWorkItems({
    workdayId: 'day-first-update',
    plan: { proposed: [proposal], changes: [] },
    conversations: [
      {
        episodeId: 'first-update-meeting',
        startTime: '09:30',
        endTime: '10:00',
        title: 'Project update',
        description: 'The update was agreed.',
      },
    ],
    analysisStartedAt: 1_000,
    observedAt: 1_100,
  })
  store.applyAnalyzedWorkItems({
    workdayId: 'day-later-update',
    plan: { proposed: [proposal], changes: [] },
    conversations: [
      {
        episodeId: 'later-update-meeting',
        startTime: '09:30',
        endTime: '10:00',
        title: 'Project update',
        description: 'A later update was agreed.',
      },
    ],
    analysisStartedAt: 2_000,
    observedAt: 2_100,
  })

  assert.equal(store.listWorkItems().length, 2)
  assert.equal(new Set(store.listWorkItems().map((item) => item.id)).size, 2)
  store.close()
})

test('records analyzed completion as an observation and preserves explicit user lifecycle choices', () => {
  const store = createStore()
  const item = store.createWorkItem('Publish the release', 'Publish the signed build.')
  const analysisStartedAt = item.updatedAt
  const observedAt = analysisStartedAt + 1
  const change = {
    id: item.id,
    title: item.title,
    type: 'completed' as const,
    reason: 'The signed build was published.',
  }

  assert.deepEqual(
    store.applyAnalyzedWorkItems({
      workdayId: 'day-lifecycle-analysis',
      plan: { proposed: [], changes: [change] },
      conversations: [],
      analysisStartedAt,
      observedAt,
    }),
    { created: 0, updated: 0, closed: 0 }
  )
  assert.equal(store.getWorkItem(item.id)?.lifecycle, 'open')
  assert.equal(store.getWorkItem(item.id)?.observations.at(-1)?.kind, 'completion_candidate')
  store.setWorkItemLifecycle(item.id, 'completed')

  const reopened = store.setWorkItemLifecycle(item.id, 'open')
  assert.ok(reopened.updatedAt > observedAt)
  assert.deepEqual(
    store.applyAnalyzedWorkItems({
      workdayId: 'day-lifecycle-analysis',
      plan: { proposed: [], changes: [change] },
      conversations: [],
      analysisStartedAt: observedAt,
      observedAt: reopened.updatedAt + 1,
    }),
    { created: 0, updated: 0, closed: 0 }
  )
  assert.equal(store.getWorkItem(item.id)?.lifecycle, 'open')
  store.close()
})

test('Inbox artifact and worker handoff persist idempotently without completing a human commitment', () => {
  const store = createStore()
  const item = store.createWorkItem('Prepare the discussion', 'Compare the options')
  store.startWorkItemAgentSession(item.id, {
    sessionId: 'briefing-worker',
    provider: 'codex',
    prompt: 'Prepare an agenda',
    message: '',
    startedAt: Date.now(),
  })
  const input = {
    response:
      '## Agenda\nDiscuss the two options.\n\n```remember-task-update\n{"summary":"Prepared the agenda","remaining":"Human discussion","nextStep":"Discuss the options","needsUser":true}\n```',
    durationMs: 500,
    steps: [],
  }
  const finished = store.finishWorkItemAgentSession(item.id, 'briefing-worker', input)
  assert.equal(finished.agentSessions[0]?.response, '## Agenda\nDiscuss the two options.')
  assert.equal(finished.lifecycle, 'open')
  assert.equal(finished.attention, 'waiting_on_user')
  assert.equal(finished.returnPoint.nextMove, 'Discuss the options')
  assert.deepEqual(store.finishWorkItemAgentSession(item.id, 'briefing-worker', input), finished)
  assert.deepEqual(store.getWorkItem(item.id), finished)
  store.close()
})

test('manual meeting title and notes survive processing and reject late edits', () => {
  const store = createStore()
  store.upsertSession({
    id: 'live-notes-day',
    startedAt: 1000,
    endedAt: null,
    activeDurationMs: 0,
    moments: [],
    appActivity: [],
    contextMoments: [],
    memory: null,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  })
  const meeting = store.createManualMeeting('live-notes-day', 'Nieuw gesprek', 2000)
  store.updateManualMeetingDetails(meeting.id, 'Klantmeeting', 'Pilot volgende week')
  assert.throws(() => store.updateManualMeetingDetails(meeting.id, 'x'.repeat(121), ''), /invalid-meeting/)
  const processing = store.finishManualMeeting(meeting.id, 5000)
  assert.equal(processing.title, 'Klantmeeting')
  assert.equal(processing.notes, 'Pilot volgende week')
  assert.equal(processing.status, 'processing')
  assert.throws(() => store.updateManualMeetingDetails(meeting.id, 'Late edit', ''), /not-active/)
  store.close()
})

test('audio search row lookup survives updates, deletion and rows from an older app', () => {
  const path = join(tmpdir(), `remember-audio-search-${randomUUID()}.sqlite`)
  paths.push(path, `${path}-wal`, `${path}-shm`)
  let store = new EvidenceStore(path)
  store.upsertSession({
    id: 'day',
    startedAt: 1000,
    endedAt: null,
    activeDurationMs: 0,
    moments: [],
    appActivity: [],
    contextMoments: [],
    memory: null,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  })
  const moment = {
    id: 'audio',
    sessionId: 'day',
    source: 'microphone' as const,
    startedAt: 2000,
    durationMs: 2000,
    status: 'ready' as const,
    transcript: 'Original searchable phrase',
  }
  store.appendAudioMoment(moment)
  store.updateAudioMoment('day', 'audio', { transcript: 'Replacement searchable phrase' })
  assert.equal(store.search('Original').length, 0)
  assert.equal(store.search('Replacement').length, 1)
  store.close()
  let db = new DatabaseSync(path)
  db.exec(
    "CREATE TRIGGER preserve_audio_lookup BEFORE DELETE ON audio_search_row BEGIN SELECT RAISE(ABORT, 'unnecessary-audio-lookup-rebuild'); END"
  )
  db.close()
  store = new EvidenceStore(path)
  assert.equal(store.search('Replacement').length, 1)
  store.close()
  db = new DatabaseSync(path)
  db.exec('DROP TRIGGER preserve_audio_lookup')
  db.exec(
    "DELETE FROM evidence_fts WHERE kind = 'audio'; INSERT INTO evidence_fts(rowid, kind, evidence_id, workday_id, application, window_title, text) VALUES (100000, 'audio', 'audio', 'day', '', '', 'Replacement searchable phrase')"
  )
  db.close()
  store = new EvidenceStore(path)
  store.updateAudioMoment('day', 'audio', { transcript: 'Repaired stale lookup' })
  assert.equal(store.search('Replacement').length, 0)
  assert.equal(store.search('Repaired').length, 1)
  store.close()
  db = new DatabaseSync(path)
  db.exec('DELETE FROM audio_search_row')
  db.close()
  store = new EvidenceStore(path)
  store.updateAudioMoment('day', 'audio', { transcript: 'Restored lookup phrase' })
  assert.equal(store.search('Replacement').length, 0)
  assert.equal(store.search('Restored').length, 1)
  store.updateAudioMoment('day', 'audio', { status: 'transcribing', transcript: '' })
  assert.equal(store.search('Restored').length, 0)
  store.appendAudioMoment(moment)
  store.deleteSession('day')
  assert.equal(store.search('Original').length, 0)
  store.close()
})

test('interactive evidence reads yield and retain every source when timestamps are equal', async () => {
  const store = createStore()
  const session: DailyReviewSession = {
    id: 'batched-evidence',
    startedAt: 1000,
    endedAt: null,
    activeDurationMs: 0,
    moments: [],
    appActivity: [],
    contextMoments: [],
    memory: null,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  }
  store.upsertSession(session)
  for (let index = 150; index >= 0; index--)
    appendScreenEvidence(store, session.id, `source-${index}`, 2000, `Source ${index}`)
  try {
    let done = false
    const pending = store.readAnalysisEvidence(session.id).then((entries) => {
      done = true
      return entries
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(done, false, 'interactive work must get a turn before the entire archive is read')
    const entries = await pending
    assert.equal(entries.length, 151)
    assert.equal(new Set(entries.map((entry) => entry.evidenceId)).size, 151)
    const moments = await store.readContextMomentsAsync(session.id)
    assert.deepEqual(
      moments.toSorted((a, b) => a.id.localeCompare(b.id)),
      store.readContextMoments(session.id).toSorted((a, b) => a.id.localeCompare(b.id))
    )
  } finally {
    store.close()
  }
})

test('deletion between evidence batches invalidates the read before it can return removed sources', async () => {
  const store = createStore()
  const session: DailyReviewSession = {
    id: 'deleted-during-read',
    startedAt: 1000,
    endedAt: null,
    activeDurationMs: 0,
    moments: [],
    appActivity: [],
    contextMoments: [],
    memory: null,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  }
  store.upsertSession(session)
  for (let index = 0; index < 150; index++) appendScreenEvidence(store, session.id, `source-${index}`, 2000 + index)
  try {
    const pending = store.readAnalysisEvidence(session.id)
    store.deleteSession(session.id)
    await assert.rejects(pending, /analysis-invalidated-by-deletion/)
  } finally {
    store.close()
  }
})
