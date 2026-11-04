export interface MusicClassification {
  windowCount: number
  speechWindowShare: number
  musicDominantWindowShare: number
  averageSpeechConfidence: number
  averageMusicConfidence: number
  averageSingingConfidence: number
}

import type { MediaPlaybackContext } from '@remember/shared'

export type MediaPlaybackSnapshot = MediaPlaybackContext

const MIN_WINDOWS_FOR_DECISION = 3
const MUSIC_DOMINANT_SHARE = 0.6
const MIN_MUSIC_CONFIDENCE = 0.3
const MUSIC_TO_SPEECH_RATIO = 1.5
const VOCAL_MUSIC_CONFIDENCE = 0.45
const SINGING_CONFIDENCE = 0.25
const PLAYBACK_MUSIC_CONFIDENCE = 0.3
const PLAYBACK_MUSIC_TO_SPEECH_RATIO = 0.65
const EXCLUDED_MUSIC_PLAYER_BUNDLE_IDENTIFIERS = new Set(['com.spotify.client', 'com.apple.Music'])

export function isExcludedMusicPlayback(playback?: MediaPlaybackSnapshot) {
  return playback?.isPlaying === true && EXCLUDED_MUSIC_PLAYER_BUNDLE_IDENTIFIERS.has(playback.bundleIdentifier)
}

export function shouldTranscribeMusicClassification(
  classification: MusicClassification,
  playback?: MediaPlaybackSnapshot
) {
  if (isExcludedMusicPlayback(playback)) return false
  if (classification.windowCount < MIN_WINDOWS_FOR_DECISION) return true

  const musicConfidence = Math.max(classification.averageMusicConfidence, classification.averageSingingConfidence)
  const isPersistentlyMusicDominant = classification.musicDominantWindowShare >= MUSIC_DOMINANT_SHARE
  const isClearlyMusic = musicConfidence >= MIN_MUSIC_CONFIDENCE
  const isStrongerThanSpeech = musicConfidence >= classification.averageSpeechConfidence * MUSIC_TO_SPEECH_RATIO
  const isVocalMusic =
    classification.averageMusicConfidence >= VOCAL_MUSIC_CONFIDENCE &&
    classification.averageSingingConfidence >= SINGING_CONFIDENCE
  const isPlaybackBackedMusic =
    playback?.isPlaying === true &&
    musicConfidence >= PLAYBACK_MUSIC_CONFIDENCE &&
    musicConfidence >= classification.averageSpeechConfidence * PLAYBACK_MUSIC_TO_SPEECH_RATIO

  return !(
    isVocalMusic ||
    isPlaybackBackedMusic ||
    (isPersistentlyMusicDominant && isClearlyMusic && isStrongerThanSpeech)
  )
}
