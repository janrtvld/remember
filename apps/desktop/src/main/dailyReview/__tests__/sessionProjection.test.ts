import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import type { ConversationEpisode, DailyReviewSession } from '@remember/shared'
import { conversationAudioChunkPathAt } from '../conversationAudio'
import { EvidenceStore } from '../evidenceStore'
import { CONVERSATION_RECOVERY_RETENTION_MS, projectDailyReviewSessions } from '../sessionProjection'

test('session broadcasts hydrate only recoverable days and preserve current audio, candidates, and active calls', () => {
  const directory = mkdtempSync(join(tmpdir(), 'remember-session-projection-'))
  const store = new EvidenceStore(join(directory, 'evidence.sqlite'))
  const now = Date.UTC(2026, 8, 17, 12)
  const speechReads: string[] = []
  const analysisReads: string[] = []
  try {
    const sessions = [0, 2, 3].map((daysAgo): DailyReviewSession => {
      const startedAt = now - daysAgo * CONVERSATION_RECOVERY_RETENTION_MS - 60_000
      return {
        id: `day-${daysAgo}`,
        startedAt,
        endedAt: startedAt + 30_000,
        activeDurationMs: 30_000,
        moments: [
          {
            id: `chunk-${daysAgo}`,
            sessionId: `day-${daysAgo}`,
            source: 'microphone',
            startedAt,
            durationMs: 30_000,
            status: 'ready',
            transcript: 'Discuss the release.',
          },
        ],
        appActivity: [],
        contextMoments: [],
        memory: null,
        refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
      }
    })
    for (const [index, session] of sessions.entries()) {
      const moment = session.moments[0]
      assert.ok(moment)
      assert.ok(session.endedAt != null)
      store.upsertSession(session)
      store.appendAudioMoment(moment)
      const episode: ConversationEpisode = {
        id: `episode-${session.id}`,
        workdayId: session.id,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        state: index === 2 ? 'provisional' : 'final',
        surfaceKey: 'call:release',
        provider: 'call',
        boundaryReason: 'call-ended',
        segmentIds: [`segment-${session.id}`],
        deletedAt: null,
        automaticRevinoteProcessingBlocked: false,
      }
      store.appendSpeechSegments([
        {
          id: `segment-${session.id}`,
          workdayId: session.id,
          chunkId: moment.id,
          source: 'microphone',
          startedAt: episode.startedAt,
          endedAt: episode.endedAt,
          text: 'Discuss the release.',
          detectedLanguage: 'en',
          acceptedLanguage: 'en',
          rejectionReason: null,
        },
      ])
      store.syncConversationEpisodes(session.id, [episode])
      store.upsertEpisodeAnalysis({
        id: `analysis-${session.id}`,
        episodeId: episode.id,
        workdayId: session.id,
        startedAt: episode.startedAt,
        endedAt: episode.endedAt,
        classification: 'conversation',
        confidence: 'high',
        reason: 'A conversation.',
        title: 'Release planning',
        description: 'Discussed the release.',
        summary: '',
        actionPoints: [],
        sourceHash: 'synthetic',
        provider: 'codex',
        model: 'synthetic',
        promptVersion: 1,
        schemaVersion: 1,
        generatedAt: now,
      })
      const audioPath = conversationAudioChunkPathAt(directory, session.id, moment.id)
      mkdirSync(dirname(audioPath), { recursive: true })
      writeFileSync(audioPath, 'synthetic audio presence')
    }
    const readers = {
      listConversationEpisodes: store.listConversationEpisodes.bind(store),
      listSpeechSegments: (id: string) => {
        speechReads.push(id)
        return store.listSpeechSegments(id)
      },
      listEpisodeAnalyses: (id: string) => {
        analysisReads.push(id)
        return store.listEpisodeAnalyses(id)
      },
    }
    const result = projectDailyReviewSessions(sessions, readers, directory, now)
    assert.deepEqual(speechReads, ['day-0'])
    assert.deepEqual(analysisReads, ['day-0'])
    assert.equal(result[0]?.conversationCandidates?.[0]?.title, 'Release planning')
    assert.equal(result[0]?.conversationCandidates?.[0]?.preview, 'Discuss the release.')
    assert.deepEqual(result[0]?.retainedAudioMomentIds, ['chunk-0'])
    assert.deepEqual(result[0]?.recoverableConversationBlocks?.[0]?.momentIds, ['chunk-0'])
    assert.deepEqual(result[1]?.conversationCandidates, [])
    assert.deepEqual(result[1]?.recoverableConversationBlocks, [])
    assert.deepEqual(result[1]?.retainedAudioMomentIds, [])
    assert.equal(result[2]?.ongoingConversations?.[0]?.episodeId, 'episode-day-3')
    assert.equal(store.listConversationEpisodes('day-2').length, 1)
    assert.equal(
      store.listConversationEpisodes('day-2', { recoverableAfter: now - CONVERSATION_RECOVERY_RETENTION_MS }).length,
      0
    )

    store.decideConversationEpisode('episode-day-0', 'dismissed', now)
    const dismissed = projectDailyReviewSessions(sessions, readers, directory, now)
    assert.deepEqual(dismissed[0]?.conversationCandidates, [])
    assert.equal(dismissed[0]?.recoverableConversationBlocks?.length, 1)
    store.decideConversationEpisode('episode-day-0', 'confirmed', now + 1)
    speechReads.length = 0
    analysisReads.length = 0
    const confirmed = projectDailyReviewSessions(sessions, readers, directory, now)
    assert.deepEqual(speechReads, [])
    assert.deepEqual(analysisReads, [])
    assert.deepEqual(confirmed[0]?.recoverableConversationBlocks, [])
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the renderer copy of a memory omits analysis provenance and stays the same object between broadcasts', () => {
  const memory = {
    summary: 'Release planning',
    analysisProvenance: { version: 1, rawSources: [] },
  } as unknown as NonNullable<DailyReviewSession['memory']>
  const session: DailyReviewSession = {
    id: 'day',
    startedAt: 0,
    endedAt: 1,
    activeDurationMs: 1,
    moments: [],
    appActivity: [],
    contextMoments: [],
    memory,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  }
  const store = { listConversationEpisodes: () => [], listSpeechSegments: () => [], listEpisodeAnalyses: () => [] }
  const [first] = projectDailyReviewSessions([session], store, tmpdir(), 2)
  const [second] = projectDailyReviewSessions([session], store, tmpdir(), 3)

  assert.equal(first.memory?.summary, 'Release planning')
  assert.equal(first.memory?.analysisProvenance, undefined)
  assert.equal(second.memory, first.memory)
  assert.equal(session.memory, memory)
  assert.ok(memory.analysisProvenance)
})

test('the renderer copy of a Day reports removed context evidence without carrying the references', () => {
  const reference = (id: string) => ({ id, timestamp: 1, bundleId: 'com.example.app' })
  const session: DailyReviewSession = {
    id: 'day-with-context',
    startedAt: 0,
    endedAt: 1,
    activeDurationMs: 1,
    moments: [],
    appActivity: [],
    contextMoments: [reference('first'), reference('second')],
    memory: null,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  }
  const store = { listConversationEpisodes: () => [], listSpeechSegments: () => [], listEpisodeAnalyses: () => [] }
  const project = (contextMoments: DailyReviewSession['contextMoments']) =>
    projectDailyReviewSessions([{ ...session, contextMoments }], store, tmpdir(), 2)[0]

  const initial = project(session.contextMoments)
  assert.deepEqual(initial.contextMoments, [])
  assert.equal(initial.contextEvidenceRemovals, 0)
  const appended = project([...session.contextMoments, reference('third')])
  assert.equal(appended.contextEvidenceRemovals, 0)
  assert.equal(appended.contextMoments, initial.contextMoments)
  assert.equal(project([reference('first'), reference('third')]).contextEvidenceRemovals, 1)
  assert.equal(project([reference('first'), reference('third'), reference('fourth')]).contextEvidenceRemovals, 1)
  assert.equal(project([reference('third'), reference('fourth'), reference('fifth')]).contextEvidenceRemovals, 2)
})
