import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import type { ConversationEpisode, DailyReviewMoment } from '@remember/shared'
import {
  mixedPcmBlocks,
  type PcmMixSource,
  type PcmMixWindow,
  type PcmWavInfo,
  pcmSampleBlocks,
  readPcmWavInfo,
  writePcmWavBlocks,
} from './pcmWav'

const AUDIO_DIRECTORY = 'conversation-audio'
const CHUNK_DIRECTORY = 'chunks'
const CONVERSATION_DIRECTORY = 'conversations'
const PADDING_MS = 2_000

function storageKey(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

function workdayDirectory(
  root: string,
  kind: typeof CHUNK_DIRECTORY | typeof CONVERSATION_DIRECTORY,
  workdayId: string
) {
  return join(root, AUDIO_DIRECTORY, kind, storageKey(workdayId))
}

export function conversationAudioChunkPathAt(root: string, workdayId: string, chunkId: string) {
  return join(workdayDirectory(root, CHUNK_DIRECTORY, workdayId), `${storageKey(chunkId)}.wav`)
}

export function conversationAudioPathAt(root: string, episode: ConversationEpisode) {
  return join(
    workdayDirectory(root, CONVERSATION_DIRECTORY, episode.workdayId),
    `${episode.startedAt}-${episode.endedAt}-${storageKey(episode.id)}.wav`
  )
}

export function saveConversationAudioChunkAt(root: string, workdayId: string, chunkId: string, wav: Buffer) {
  const target = conversationAudioChunkPathAt(root, workdayId, chunkId)
  mkdirSync(dirname(target), { recursive: true })
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, wav)
    renameSync(temporary, target)
  } finally {
    rmSync(temporary, { force: true })
  }
  return target
}

export interface ConversationAudioRange {
  sourceStartedAt: number
  sourceEndedAt: number
  outputStartSample: number
  outputEndSample: number
  momentIds: string[]
}

export interface ConversationAudioManifest {
  version: 1
  sampleRate: number
  ranges: ConversationAudioRange[]
}

export function readConversationAudioManifestAt(path: string): ConversationAudioManifest | null {
  if (!existsSync(`${path}.json`)) return null
  const manifest = JSON.parse(readFileSync(`${path}.json`, 'utf8')) as ConversationAudioManifest
  const info = readPcmWavInfo(path)
  if (
    manifest?.version !== 1 ||
    manifest.sampleRate !== info.sampleRate ||
    !Array.isArray(manifest.ranges) ||
    !manifest.ranges.length
  ) {
    throw new Error('conversation-audio-manifest-invalid')
  }
  let outputSample = 0
  for (const range of manifest.ranges) {
    if (
      !range ||
      !Number.isFinite(range.sourceStartedAt) ||
      !Number.isFinite(range.sourceEndedAt) ||
      range.sourceEndedAt <= range.sourceStartedAt ||
      range.outputStartSample !== outputSample ||
      !Number.isSafeInteger(range.outputEndSample) ||
      range.outputEndSample <= outputSample ||
      range.outputEndSample > info.sampleCount ||
      Math.abs(
        ((range.sourceEndedAt - range.sourceStartedAt) * info.sampleRate) / 1000 -
          (range.outputEndSample - range.outputStartSample)
      ) > 1 ||
      !Array.isArray(range.momentIds) ||
      range.momentIds.some((id) => typeof id !== 'string')
    ) {
      throw new Error('conversation-audio-manifest-invalid')
    }
    outputSample = range.outputEndSample
  }
  if (outputSample !== info.sampleCount) throw new Error('conversation-audio-manifest-invalid')
  return manifest
}

function* writeRenderedAudio(
  target: string,
  sampleRate: number,
  ranges: ConversationAudioRange[],
  blocks: Iterable<Buffer>
) {
  mkdirSync(dirname(target), { recursive: true })
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    yield* writePcmWavBlocks(temporary, sampleRate, ranges.at(-1)?.outputEndSample ?? 0, blocks)
    writeFileSync(
      `${temporary}.json`,
      JSON.stringify({ version: 1, sampleRate, ranges } satisfies ConversationAudioManifest)
    )
    renameSync(`${temporary}.json`, `${target}.json`)
    renameSync(temporary, target)
  } finally {
    rmSync(temporary, { force: true })
    rmSync(`${temporary}.json`, { force: true })
  }
  return target
}

function* renderConversationAudioSteps(
  root: string,
  episode: ConversationEpisode,
  moments: DailyReviewMoment[],
  options: { compactGaps?: boolean } = {}
) {
  const target = conversationAudioPathAt(root, episode)
  if (existsSync(target)) return target
  const paddingMs = episode.provider === 'manual' ? 0 : PADDING_MS

  const candidates = moments
    .filter(
      (moment) =>
        moment.source !== 'revinote' &&
        moment.startedAt < episode.endedAt + paddingMs &&
        moment.startedAt + moment.durationMs > episode.startedAt - paddingMs
    )
    .sort((first, second) => first.startedAt - second.startedAt || first.source.localeCompare(second.source))
  if (candidates.length === 0) return null

  const available: PcmMixSource[] = []
  for (const moment of candidates) {
    const path = conversationAudioChunkPathAt(root, episode.workdayId, moment.id)
    if (existsSync(path)) {
      available.push({ path, ...readPcmWavInfo(path), startedAt: moment.startedAt, momentId: moment.id })
    }
    yield
  }
  if (!available.length) return null
  const sampleRate = available[0]?.sampleRate ?? 16_000
  if (available.some((source) => source.sampleRate !== sampleRate))
    throw new Error('conversation-audio-sample-rate-mismatch')
  const windows: PcmMixWindow[] = []
  for (const source of available) {
    const startedAt = Math.max(episode.startedAt - paddingMs, source.startedAt)
    const endedAt = Math.min(episode.endedAt + paddingMs, source.startedAt + (source.sampleCount * 1000) / sampleRate)
    if (endedAt <= startedAt) continue
    const previous = windows.at(-1)
    if (previous && (!options.compactGaps || startedAt <= previous.endedAt)) {
      previous.endedAt = Math.max(previous.endedAt, endedAt)
      previous.sources.push(source)
    } else {
      windows.push({ startedAt, endedAt, sources: [source] })
    }
  }
  if (!windows.length) return null
  let outputSample = 0
  const ranges = windows.map((window) => {
    const outputStartSample = outputSample
    outputSample += Math.ceil(((window.endedAt - window.startedAt) * sampleRate) / 1000)
    return {
      sourceStartedAt: window.startedAt,
      sourceEndedAt: window.endedAt,
      outputStartSample,
      outputEndSample: outputSample,
      momentIds: window.sources.map((source) => source.momentId),
    }
  })
  return yield* writeRenderedAudio(target, sampleRate, ranges, mixedPcmBlocks(windows, sampleRate))
}

function finishSteps<T>(steps: Generator<void, T>) {
  let step = steps.next()
  while (!step.done) step = steps.next()
  return step.value
}

export function renderConversationAudioAt(
  root: string,
  episode: ConversationEpisode,
  moments: DailyReviewMoment[],
  options: { compactGaps?: boolean } = {}
) {
  return finishSteps(renderConversationAudioSteps(root, episode, moments, options))
}

const activeRenders = new Map<
  string,
  {
    root: string
    episode: ConversationEpisode
    inputs: Set<string>
    cancelled: boolean
    result: Promise<string | null>
  }
>()

export function renderConversationAudioAsyncAt(
  root: string,
  episode: ConversationEpisode,
  moments: DailyReviewMoment[],
  options: { compactGaps?: boolean } = {}
): Promise<string | null> {
  const target = conversationAudioPathAt(root, episode)
  const existing = activeRenders.get(target)
  if (existing) return existing.result
  const job = {
    root,
    episode,
    inputs: new Set(moments.map((moment) => conversationAudioChunkPathAt(root, episode.workdayId, moment.id))),
    cancelled: false,
    result: Promise.resolve<string | null>(null),
  }
  activeRenders.set(target, job)
  job.result = (async () => {
    const steps = renderConversationAudioSteps(root, episode, moments, options)
    try {
      // Register ownership before the first yield; deletion can cancel every pending render.
      await setImmediate()
      while (true) {
        if (job.cancelled) throw new Error('conversation-audio-render-cancelled')
        const step = steps.next()
        if (step.done) return step.value
        await setImmediate()
      }
    } finally {
      try {
        steps.return(null)
      } finally {
        if (activeRenders.get(target) === job) activeRenders.delete(target)
      }
    }
  })()
  return job.result
}

export function conversationAudioDurationSecondsAt(path: string) {
  if (!existsSync(path)) return null
  const info = readPcmWavInfo(path)
  return info.sampleCount / info.sampleRate
}

export function mergeConversationAudioAt(
  root: string,
  mergedEpisode: ConversationEpisode,
  sourceEpisodes: ConversationEpisode[]
) {
  if (sourceEpisodes.length < 2) throw new Error('conversation-merge-needs-two-sources')
  const sources = sourceEpisodes
    .slice()
    .sort((first, second) => first.startedAt - second.startedAt)
    .map((episode) => {
      const path = conversationAudioPathAt(root, episode)
      if (!existsSync(path)) throw new Error('conversation-audio-missing-source')
      return { episode, path, ...readPcmWavInfo(path), manifest: readConversationAudioManifestAt(path) }
    })
  const sampleRate = sources[0]?.sampleRate ?? 16_000
  if (sources.some((source) => source.sampleRate !== sampleRate))
    throw new Error('conversation-audio-sample-rate-mismatch')
  let outputSample = 0
  const clips: Array<{ path: string; info: PcmWavInfo; startSample: number; endSample: number }> = []
  const ranges: ConversationAudioRange[] = []
  for (const source of sources) {
    const fallbackLength = Math.min(
      source.sampleCount,
      Math.round(((source.episode.endedAt - source.episode.startedAt) * sampleRate) / 1000)
    )
    const fallbackStart = Math.max(0, Math.floor((source.sampleCount - fallbackLength) / 2))
    const sourceRanges = source.manifest?.ranges ?? [
      {
        sourceStartedAt: source.episode.startedAt,
        sourceEndedAt: source.episode.startedAt + (fallbackLength * 1000) / sampleRate,
        outputStartSample: fallbackStart,
        outputEndSample: fallbackStart + fallbackLength,
        momentIds: [],
      },
    ]
    for (const range of sourceRanges) {
      const startedAt = Math.max(source.episode.startedAt, range.sourceStartedAt)
      const endedAt = Math.min(source.episode.endedAt, range.sourceEndedAt)
      if (endedAt <= startedAt) continue
      const startSample =
        range.outputStartSample + Math.round(((startedAt - range.sourceStartedAt) * sampleRate) / 1000)
      const endSample = Math.min(
        range.outputEndSample,
        startSample + Math.round(((endedAt - startedAt) * sampleRate) / 1000)
      )
      clips.push({ path: source.path, info: source, startSample, endSample })
      ranges.push({
        ...range,
        sourceStartedAt: startedAt,
        sourceEndedAt: endedAt,
        outputStartSample: outputSample,
        outputEndSample: outputSample + endSample - startSample,
      })
      outputSample += endSample - startSample
    }
  }
  if (!outputSample) throw new Error('conversation-audio-empty-merge')
  function* blocks() {
    for (const clip of clips) yield* pcmSampleBlocks(clip.path, clip.info, clip.startSample, clip.endSample)
  }
  return finishSteps(writeRenderedAudio(conversationAudioPathAt(root, mergedEpisode), sampleRate, ranges, blocks()))
}

function overlaps(moment: DailyReviewMoment, episode: ConversationEpisode) {
  return moment.startedAt < episode.endedAt && moment.startedAt + moment.durationMs > episode.startedAt
}

export function pruneResolvedConversationChunksAt(
  root: string,
  workdayId: string,
  moments: DailyReviewMoment[],
  episodes: ConversationEpisode[],
  resolvedEpisodeIds: Set<string>,
  coveredThrough: number,
  recoverableAfter = Number.POSITIVE_INFINITY
) {
  const removed: string[] = []
  for (const moment of moments) {
    if (moment.source === 'revinote' || moment.startedAt + moment.durationMs > coveredThrough) continue
    if (moment.startedAt + moment.durationMs > recoverableAfter) {
      continue
    }
    const overlappingEpisodes = episodes.filter((episode) => episode.deletedAt == null && overlaps(moment, episode))
    if (overlappingEpisodes.some((episode) => episode.state !== 'final' || !resolvedEpisodeIds.has(episode.id))) {
      continue
    }
    const path = conversationAudioChunkPathAt(root, workdayId, moment.id)
    if (!existsSync(path) || [...activeRenders.values()].some((job) => job.inputs.has(path))) continue
    rmSync(path, { force: true })
    removed.push(path)
  }
  return removed
}

export function removeConversationAudioForEpisodeAt(root: string, episode: ConversationEpisode) {
  const job = activeRenders.get(conversationAudioPathAt(root, episode))
  if (job) job.cancelled = true
  rmSync(conversationAudioPathAt(root, episode), { force: true })
  rmSync(`${conversationAudioPathAt(root, episode)}.json`, { force: true })
}

export function removeConversationAudioSinceAt(
  root: string,
  workdayId: string,
  moments: DailyReviewMoment[],
  episodes: ConversationEpisode[],
  cutoff: number
) {
  for (const job of activeRenders.values()) {
    if (job.root === root && job.episode.workdayId === workdayId && job.episode.endedAt + PADDING_MS > cutoff) {
      job.cancelled = true
    }
  }
  for (const moment of moments) {
    if (moment.source !== 'revinote' && moment.startedAt + moment.durationMs > cutoff) {
      rmSync(conversationAudioChunkPathAt(root, workdayId, moment.id), { force: true })
    }
  }
  for (const episode of episodes) {
    if (episode.endedAt > cutoff) removeConversationAudioForEpisodeAt(root, episode)
  }
}

export function removeConversationAudioForWorkdayAt(root: string, workdayId: string) {
  for (const job of activeRenders.values()) {
    if (job.root === root && job.episode.workdayId === workdayId) job.cancelled = true
  }
  rmSync(workdayDirectory(root, CHUNK_DIRECTORY, workdayId), { recursive: true, force: true })
  rmSync(workdayDirectory(root, CONVERSATION_DIRECTORY, workdayId), { recursive: true, force: true })
}
