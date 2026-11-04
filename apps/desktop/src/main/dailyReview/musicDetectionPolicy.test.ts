import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { shouldTranscribeMusicClassification } from './musicDetectionPolicy'

describe('shouldTranscribeMusicClassification', () => {
  it('skips recorded pop music even when sung vocals are also labeled as speech', () => {
    assert.equal(
      shouldTranscribeMusicClassification({
        windowCount: 78,
        speechWindowShare: 0.2436,
        musicDominantWindowShare: 0.8205,
        averageSpeechConfidence: 0.2348,
        averageMusicConfidence: 0.5109,
        averageSingingConfidence: 0.4306,
      }),
      false
    )
  })

  it('skips the latest recorded song where speech slightly outranks music', () => {
    assert.equal(
      shouldTranscribeMusicClassification({
        windowCount: 78,
        speechWindowShare: 0.641,
        musicDominantWindowShare: 0.3974,
        averageSpeechConfidence: 0.5125,
        averageMusicConfidence: 0.5488,
        averageSingingConfidence: 0.3129,
      }),
      false
    )
  })

  it('uses an active media app to resolve otherwise ambiguous music', () => {
    assert.equal(
      shouldTranscribeMusicClassification(
        {
          windowCount: 60,
          speechWindowShare: 0.55,
          musicDominantWindowShare: 0.45,
          averageSpeechConfidence: 0.5,
          averageMusicConfidence: 0.35,
          averageSingingConfidence: 0.12,
        },
        {
          isPlaying: true,
          bundleIdentifier: 'company.thebrowser.dia',
          applicationName: 'Dia',
        }
      ),
      false
    )
  })

  it('always skips Spotify while it is the active Now Playing source', () => {
    assert.equal(
      shouldTranscribeMusicClassification(
        {
          windowCount: 60,
          speechWindowShare: 0.9,
          musicDominantWindowShare: 0.05,
          averageSpeechConfidence: 0.72,
          averageMusicConfidence: 0.18,
          averageSingingConfidence: 0.03,
        },
        {
          isPlaying: true,
          bundleIdentifier: 'com.spotify.client',
          applicationName: 'Spotify',
        }
      ),
      false
    )
  })

  it('always skips Apple Music while it is the active Now Playing source', () => {
    assert.equal(
      shouldTranscribeMusicClassification(
        {
          windowCount: 1,
          speechWindowShare: 1,
          musicDominantWindowShare: 0,
          averageSpeechConfidence: 0.99,
          averageMusicConfidence: 0,
          averageSingingConfidence: 0,
        },
        {
          isPlaying: true,
          bundleIdentifier: 'com.apple.Music',
          applicationName: 'Music',
        }
      ),
      false
    )
  })

  it('does not exclude Spotify when playback is paused', () => {
    assert.equal(
      shouldTranscribeMusicClassification(
        {
          windowCount: 60,
          speechWindowShare: 0.9,
          musicDominantWindowShare: 0.05,
          averageSpeechConfidence: 0.72,
          averageMusicConfidence: 0.18,
          averageSingingConfidence: 0.03,
        },
        {
          isPlaying: false,
          bundleIdentifier: 'com.spotify.client',
          applicationName: 'Spotify',
        }
      ),
      true
    )
  })

  it('keeps spoken podcast-app media when music evidence is weak', () => {
    assert.equal(
      shouldTranscribeMusicClassification(
        {
          windowCount: 60,
          speechWindowShare: 0.9,
          musicDominantWindowShare: 0.05,
          averageSpeechConfidence: 0.72,
          averageMusicConfidence: 0.18,
          averageSingingConfidence: 0.03,
        },
        {
          isPlaying: true,
          bundleIdentifier: 'com.apple.podcasts',
          applicationName: 'Podcasts',
        }
      ),
      true
    )
  })

  it('transcribes clear speech', () => {
    assert.equal(
      shouldTranscribeMusicClassification({
        windowCount: 20,
        speechWindowShare: 1,
        musicDominantWindowShare: 0,
        averageSpeechConfidence: 0.98,
        averageMusicConfidence: 0.07,
        averageSingingConfidence: 0.01,
      }),
      true
    )
  })

  it('transcribes a recorded system-audio speech moment', () => {
    assert.equal(
      shouldTranscribeMusicClassification({
        windowCount: 74,
        speechWindowShare: 0.2838,
        musicDominantWindowShare: 0.0405,
        averageSpeechConfidence: 0.2822,
        averageMusicConfidence: 0.1779,
        averageSingingConfidence: 0.0339,
      }),
      true
    )
  })

  it('does not decide from a single short analysis window', () => {
    assert.equal(
      shouldTranscribeMusicClassification({
        windowCount: 1,
        speechWindowShare: 0,
        musicDominantWindowShare: 1,
        averageSpeechConfidence: 0,
        averageMusicConfidence: 0.9,
        averageSingingConfidence: 0,
      }),
      true
    )
  })
})
