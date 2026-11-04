import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import type { ConversationEpisode, DailyReviewMoment, ManualMeeting } from '@remember/shared'
import {
  conversationAudioChunkPathAt,
  conversationAudioDurationSecondsAt,
  conversationAudioPathAt,
  mergeConversationAudioAt,
  pruneResolvedConversationChunksAt,
  readConversationAudioManifestAt,
  removeConversationAudioForEpisodeAt,
  removeConversationAudioForWorkdayAt,
  removeConversationAudioSinceAt,
  renderConversationAudioAsyncAt,
  renderConversationAudioAt,
  saveConversationAudioChunkAt,
} from './conversationAudio'
import { manualMeetingEpisode } from './manualMeetingLifecycle'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function testRoot() {
  const root = join(tmpdir(), `remember-conversation-audio-${randomUUID()}`)
  mkdirSync(root, { recursive: true })
  roots.push(root)
  return root
}

function wav(samples: number[], sampleRate = 1_000) {
  const result = Buffer.alloc(44 + samples.length * 2)
  result.write('RIFF', 0, 'ascii')
  result.writeUInt32LE(36 + samples.length * 2, 4)
  result.write('WAVEfmt ', 8, 'ascii')
  result.writeUInt32LE(16, 16)
  result.writeUInt16LE(1, 20)
  result.writeUInt16LE(1, 22)
  result.writeUInt32LE(sampleRate, 24)
  result.writeUInt32LE(sampleRate * 2, 28)
  result.writeUInt16LE(2, 32)
  result.writeUInt16LE(16, 34)
  result.write('data', 36, 'ascii')
  result.writeUInt32LE(samples.length * 2, 40)
  samples.forEach((sample, index) => {
    result.writeInt16LE(sample, 44 + index * 2)
  })
  return result
}

function moment(id: string, source: 'microphone' | 'system', startedAt: number, durationMs: number): DailyReviewMoment {
  return { id, sessionId: 'day-1', source, startedAt, durationMs, status: 'ready', transcript: id }
}

function episode(input: Partial<ConversationEpisode> = {}): ConversationEpisode {
  return {
    id: 'episode-1',
    workdayId: 'day-1',
    startedAt: 2_000,
    endedAt: 4_000,
    state: 'final',
    surfaceKey: null,
    provider: null,
    boundaryReason: 'speech-gap',
    segmentIds: ['segment-1'],
    deletedAt: null,
    automaticRevinoteProcessingBlocked: false,
    ...input,
  }
}

function decodedSamples(path: string) {
  const input = readFileSync(path)
  return Array.from({ length: (input.length - 44) / 2 }, (_, index) => input.readInt16LE(44 + index * 2))
}

describe('conversation audio', () => {
  it('keeps delayed manual assembly inside its own window when the next recording already exists', () => {
    const root = testRoot()
    const source = moment('two-recordings', 'microphone', 0, 6_000)
    saveConversationAudioChunkAt(
      root,
      'day-1',
      source.id,
      wav([...Array(2_000).fill(111), ...Array(2_000).fill(222), ...Array(2_000).fill(333)])
    )
    const recording = episode({ provider: 'manual' })
    const output = renderConversationAudioAt(root, recording, [source], { compactGaps: true })
    assert(output)
    assert.deepEqual(decodedSamples(output), Array(2_000).fill(222))
    const ranges = readConversationAudioManifestAt(output)?.ranges
    assert.equal(ranges?.[0]?.sourceStartedAt, recording.startedAt)
    assert.equal(ranges?.at(-1)?.sourceEndedAt, recording.endedAt)
  })

  it('streams across mix block boundaries without dropping or repeating samples', () => {
    const root = testRoot()
    const samples = Array.from({ length: 320_017 }, (_, index) => (index % 1000) - 500)
    const source = moment('long', 'microphone', 0, samples.length)
    saveConversationAudioChunkAt(root, 'day-1', source.id, wav(samples))
    const recording = episode({ startedAt: 0, endedAt: samples.length })
    const output = renderConversationAudioAt(root, recording, [source])
    assert.ok(output)
    assert.deepEqual(decodedSamples(output), samples)
    assert.equal(readConversationAudioManifestAt(output)?.ranges[0]?.outputEndSample, samples.length)
    removeConversationAudioForEpisodeAt(root, recording)
    assert.equal(existsSync(output), false)
    assert.equal(existsSync(`${output}.json`), false)
  })

  it('rejects corrupt timestamp mappings', () => {
    const root = testRoot()
    const source = moment('source', 'microphone', 0, 1000)
    saveConversationAudioChunkAt(root, 'day-1', source.id, wav(Array(1000).fill(123)))
    const recording = episode({ startedAt: 0, endedAt: 1000 })
    const output = renderConversationAudioAt(root, recording, [source])
    assert.ok(output)
    const manifest = readConversationAudioManifestAt(output)
    assert.ok(manifest)
    for (const invalid of [
      null,
      { ...manifest, sampleRate: 2000 },
      { ...manifest, ranges: [{ ...manifest.ranges[0], outputStartSample: 1 }] },
      { ...manifest, ranges: [{ ...manifest.ranges[0], outputEndSample: 1001 }] },
      { ...manifest, ranges: [{ ...manifest.ranges[0], sourceEndedAt: 2000 }] },
    ]) {
      writeFileSync(`${output}.json`, JSON.stringify(invalid))
      assert.throws(() => readConversationAudioManifestAt(output), /manifest-invalid/)
    }
  })

  it('rejects a truncated source instead of publishing partial audio', () => {
    const root = testRoot()
    const source = moment('truncated', 'microphone', 0, 1000)
    saveConversationAudioChunkAt(root, 'day-1', source.id, wav(Array(1000).fill(123)).subarray(0, 100))
    const recording = episode({ startedAt: 0, endedAt: 1000 })
    assert.throws(() => renderConversationAudioAt(root, recording, [source]), /invalid-wav/)
    assert.equal(existsSync(conversationAudioPathAt(root, recording)), false)
  })

  it('renders a complete manual recording without requiring a transcript episode', () => {
    const root = testRoot()
    const microphone = moment('manual-mic', 'microphone', 1_000, 4_000)
    saveConversationAudioChunkAt(root, 'day-1', microphone.id, wav(Array(4_000).fill(2_000)))
    const meeting: ManualMeeting = {
      id: 'manual-1',
      workdayId: 'day-1',
      title: '',
      notes: '',
      startedAt: 1_000,
      endedAt: 5_000,
      pausedAt: null,
      pausedMs: 0,
      status: 'processing',
      automaticRevinoteProcessingBlocked: false,
    }
    const manualEpisode = manualMeetingEpisode(meeting, [])

    const output = renderConversationAudioAt(root, manualEpisode, [microphone])

    assert.equal(output, conversationAudioPathAt(root, manualEpisode))
    assert.equal(decodedSamples(output as string).length, 4_000)
  })

  it('compacts a multi-hour pause without allocating its gap and preserves captured silence', () => {
    const root = testRoot()
    const beforePause = moment('before-pause', 'microphone', 1_000, 2_000)
    const afterPause = moment('after-pause', 'microphone', 25_201_000, 2_000)
    saveConversationAudioChunkAt(root, 'day-1', beforePause.id, wav(Array(2_000).fill(0)))
    saveConversationAudioChunkAt(root, 'day-1', afterPause.id, wav(Array(2_000).fill(3_000)))
    const meeting: ManualMeeting = {
      id: 'manual-paused',
      workdayId: 'day-1',
      title: '',
      notes: '',
      startedAt: 1_000,
      endedAt: 25_203_000,
      pausedAt: null,
      pausedMs: 25_198_000,
      status: 'processing',
      automaticRevinoteProcessingBlocked: false,
    }
    const manualEpisode = manualMeetingEpisode(meeting, [])

    const output = renderConversationAudioAt(root, manualEpisode, [beforePause, afterPause], { compactGaps: true })
    const samples = decodedSamples(output as string)

    assert.equal(samples.length, 4_000)
    assert.deepEqual(new Set(samples.slice(0, 2_000)), new Set([0]))
    assert.deepEqual(new Set(samples.slice(2_000)), new Set([3_000]))
    assert.equal(conversationAudioDurationSecondsAt(output as string), 4)
  })

  it('renders one trimmed WAV and averages overlapping microphone and system audio', () => {
    const root = testRoot()
    const microphone = moment('mic-1', 'microphone', 0, 5_000)
    const system = moment('system-1', 'system', 0, 5_000)
    saveConversationAudioChunkAt(root, 'day-1', microphone.id, wav(Array(5_000).fill(2_000)))
    saveConversationAudioChunkAt(root, 'day-1', system.id, wav(Array(5_000).fill(6_000)))

    const output = renderConversationAudioAt(root, episode(), [microphone, system])

    assert.equal(output, conversationAudioPathAt(root, episode()))
    assert.equal(decodedSamples(output as string).length, 5_000)
    assert.deepEqual(new Set(decodedSamples(output as string)), new Set([4_000]))
  })

  it('preserves original timestamps when gaps are compacted and the result is merged again', () => {
    const root = testRoot()
    const first = episode({ startedAt: 0, endedAt: 10_002_000 })
    const moments = [moment('before', 'microphone', 0, 2_000), moment('after', 'microphone', 10_000_000, 2_000)]
    for (const source of moments) saveConversationAudioChunkAt(root, 'day-1', source.id, wav(Array(2_000).fill(1234)))
    const output = renderConversationAudioAt(root, first, moments, { compactGaps: true })
    assert.ok(output)
    const manifest = readConversationAudioManifestAt(output)
    assert.deepEqual(
      manifest?.ranges.map((range) => [range.sourceStartedAt, range.outputStartSample]),
      [
        [0, 0],
        [10_000_000, 2_000],
      ]
    )
    const second = episode({ id: 'second', startedAt: 20_000_000, endedAt: 20_001_000 })
    const source = moment('last', 'microphone', second.startedAt, 1_000)
    saveConversationAudioChunkAt(root, 'day-1', source.id, wav(Array(1_000).fill(5678)))
    renderConversationAudioAt(root, second, [source])
    const merged = mergeConversationAudioAt(root, episode({ id: 'merged', startedAt: 0, endedAt: second.endedAt }), [
      first,
      second,
    ])
    assert.equal(conversationAudioDurationSecondsAt(merged), 5)
    assert.deepEqual(
      readConversationAudioManifestAt(merged)?.ranges.map((range) => range.sourceStartedAt),
      [0, 10_000_000, 20_000_000]
    )
  })

  it('retains raw audio through the history window even after recognition', () => {
    const root = testRoot()
    const source = moment('recognized', 'microphone', 0, 6_000)
    saveConversationAudioChunkAt(root, 'day-1', source.id, wav(Array(6_000).fill(12)))
    const recognized = episode()
    assert.deepEqual(
      pruneResolvedConversationChunksAt(root, 'day-1', [source], [recognized], new Set([recognized.id]), 6_000, 0),
      []
    )
    assert.equal(
      pruneResolvedConversationChunksAt(root, 'day-1', [source], [recognized], new Set([recognized.id]), 6_000, 6_000)
        .length,
      1
    )
  })

  it('keeps chunks for unresolved episodes and removes them once every overlap is resolved', () => {
    const root = testRoot()
    const transport = moment('shared-chunk', 'microphone', 0, 60_000)
    const first = episode({ id: 'episode-1', startedAt: 5_000, endedAt: 20_000 })
    const second = episode({ id: 'episode-2', startedAt: 40_000, endedAt: 55_000 })
    const path = saveConversationAudioChunkAt(root, 'day-1', transport.id, wav(Array(60_000).fill(1)))

    assert.deepEqual(
      pruneResolvedConversationChunksAt(root, 'day-1', [transport], [first, second], new Set([first.id]), 60_000),
      []
    )
    assert.equal(readFileSync(path).length > 44, true)

    assert.deepEqual(
      pruneResolvedConversationChunksAt(
        root,
        'day-1',
        [transport],
        [first, second],
        new Set([first.id, second.id]),
        60_000
      ),
      [conversationAudioChunkPathAt(root, 'day-1', transport.id)]
    )
  })

  it('keeps recoverable non-conversation audio until its recovery window expires', () => {
    const root = testRoot()
    const transport = { ...moment('recoverable', 'microphone', 1_000, 60_000), captureOutcome: 'asr-empty' as const }
    const path = saveConversationAudioChunkAt(root, 'day-1', transport.id, wav(Array(60_000).fill(1)))

    assert.deepEqual(pruneResolvedConversationChunksAt(root, 'day-1', [transport], [], new Set(), 61_000, 0), [])
    assert.equal(readFileSync(path).length > 44, true)
    assert.deepEqual(pruneResolvedConversationChunksAt(root, 'day-1', [transport], [], new Set(), 61_000, 61_000), [
      conversationAudioChunkPathAt(root, 'day-1', transport.id),
    ])
  })

  it('concatenates far-apart episode WAVs without allocating their wall-clock gap', () => {
    const root = testRoot()
    const first = episode({ id: 'episode-1', startedAt: 2_000, endedAt: 4_000 })
    const second = episode({ id: 'episode-2', startedAt: 25_202_000, endedAt: 25_204_000 })
    const merged = episode({
      id: 'merged',
      startedAt: 2_000,
      endedAt: 25_204_000,
      boundaryReason: 'manual-merge',
      segmentIds: [...first.segmentIds, ...second.segmentIds],
    })
    const firstMoment = moment('first', 'microphone', 0, 6_000)
    const secondMoment = moment('second', 'microphone', 25_200_000, 6_000)
    saveConversationAudioChunkAt(root, 'day-1', firstMoment.id, wav(Array(6_000).fill(1_000)))
    saveConversationAudioChunkAt(root, 'day-1', secondMoment.id, wav(Array(6_000).fill(3_000)))
    renderConversationAudioAt(root, first, [firstMoment])
    renderConversationAudioAt(root, second, [secondMoment])

    const output = mergeConversationAudioAt(root, merged, [second, first])
    const samples = decodedSamples(output)

    assert.equal(samples.length, 4_000)
    assert.deepEqual(new Set(samples.slice(0, 2_000)), new Set([1_000]))
    assert.deepEqual(new Set(samples.slice(2_000)), new Set([3_000]))
    assert.equal(conversationAudioDurationSecondsAt(output), 4)
  })
})

describe('cooperative audio assembly', () => {
  function recordingFixture() {
    const root = testRoot()
    const samples = Array.from({ length: 640_017 }, (_, index) => (index % 1000) - 500)
    const source = moment('long', 'microphone', 0, samples.length)
    saveConversationAudioChunkAt(root, 'day-1', source.id, wav(samples))
    return { root, source, recording: episode({ startedAt: 0, endedAt: samples.length }) }
  }

  it('yields during assembly, deduplicates requests and preserves exact PCM and manifest', async () => {
    const { root, source, recording } = recordingFixture()
    const expected = renderConversationAudioAt(root, { ...recording, id: 'reference' }, [source])!
    const result = renderConversationAudioAsyncAt(root, recording, [source])
    assert.equal(renderConversationAudioAsyncAt(root, recording, [source]), result)
    await setImmediate()
    assert.equal(existsSync(conversationAudioPathAt(root, recording)), false)
    const output = await result
    assert.ok(output)
    assert.deepEqual(readFileSync(output), readFileSync(expected))
    assert.deepEqual(readConversationAudioManifestAt(output), readConversationAudioManifestAt(expected))
  })

  it('pins inputs during pruning and releases them after completion', async () => {
    const { root, source, recording } = recordingFixture()
    const result = renderConversationAudioAsyncAt(root, recording, [source])
    assert.deepEqual(pruneResolvedConversationChunksAt(root, 'day-1', [source], [], new Set(), Infinity), [])
    assert.ok(await result)
    assert.equal(pruneResolvedConversationChunksAt(root, 'day-1', [source], [], new Set(), Infinity).length, 1)
  })

  for (const removal of ['episode', 'recent', 'day'] as const) {
    it(`cancels ${removal} deletion during writing without resurrecting audio or leaving temporary files`, async () => {
      const { root, source, recording } = recordingFixture()
      const result = renderConversationAudioAsyncAt(root, recording, [source])
      const rejected = assert.rejects(result, /conversation-audio-render-cancelled/)
      await setImmediate()
      await setImmediate()
      if (removal === 'episode') removeConversationAudioForEpisodeAt(root, recording)
      if (removal === 'recent') removeConversationAudioSinceAt(root, 'day-1', [source], [], 1)
      if (removal === 'day') removeConversationAudioForWorkdayAt(root, 'day-1')
      await rejected
      assert.equal(existsSync(conversationAudioPathAt(root, recording)), false)
      assert.equal(existsSync(`${conversationAudioPathAt(root, recording)}.json`), false)
      assert.equal(
        readdirSync(root, { recursive: true }).some((name) => String(name).endsWith('.tmp')),
        false
      )
    })
  }
})
