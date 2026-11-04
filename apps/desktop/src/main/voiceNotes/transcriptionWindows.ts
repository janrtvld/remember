export interface TranscriptionWindow {
  startSample: number
  endSample: number
  samples: Float32Array
}

const MAX_WINDOW_SECONDS = 26
const MIN_SPLIT_SECONDS = 20
const ENERGY_FRAME_MS = 20

export function splitTranscriptionSamples(samples: Float32Array, sampleRate: number): TranscriptionWindow[] {
  const maximumWindowSamples = Math.floor(sampleRate * MAX_WINDOW_SECONDS)
  const minimumSplitSamples = Math.floor(sampleRate * MIN_SPLIT_SECONDS)
  const energyFrameSamples = Math.max(1, Math.floor((sampleRate * ENERGY_FRAME_MS) / 1_000))
  const windows: TranscriptionWindow[] = []
  let startSample = 0

  while (samples.length - startSample > maximumWindowSamples) {
    const remainingSamples = samples.length - startSample
    const minimumEndSample =
      startSample +
      Math.min(maximumWindowSamples, Math.max(minimumSplitSamples, remainingSamples - maximumWindowSamples))
    const maximumEndSample = startSample + maximumWindowSamples
    const endSample = lowestEnergySample(samples, minimumEndSample, maximumEndSample, energyFrameSamples)
    windows.push({ startSample, endSample, samples: samples.subarray(startSample, endSample) })
    startSample = endSample
  }

  if (startSample < samples.length) {
    windows.push({ startSample, endSample: samples.length, samples: samples.subarray(startSample) })
  }
  return windows
}

function lowestEnergySample(samples: Float32Array, startSample: number, endSample: number, frameSamples: number) {
  let bestSample = startSample
  let lowestEnergy = Number.POSITIVE_INFINITY
  const halfFrame = Math.floor(frameSamples / 2)

  for (let candidate = startSample; candidate <= endSample; candidate += frameSamples) {
    const frameStart = Math.max(0, candidate - halfFrame)
    const frameEnd = Math.min(samples.length, frameStart + frameSamples)
    let energy = 0
    for (let index = frameStart; index < frameEnd; index += 1) {
      const sample = samples[index] ?? 0
      energy += sample * sample
    }
    const normalizedEnergy = energy / Math.max(1, frameEnd - frameStart)
    if (normalizedEnergy < lowestEnergy) {
      lowestEnergy = normalizedEnergy
      bestSample = candidate
    }
  }

  return Math.max(startSample, Math.min(endSample, bestSample))
}
