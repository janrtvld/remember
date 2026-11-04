export function copyTranscriptionSamples(samples: Float32Array | undefined): Float32Array {
  if (!samples?.length) return new Float32Array(0)
  const copy = new Float32Array(samples.length)
  copy.set(samples)
  return copy
}
