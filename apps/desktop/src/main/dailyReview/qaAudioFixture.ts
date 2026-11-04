const SAMPLE_RATE = 16_000

export function createQaAudioFixture(durationMs: number) {
  const sampleCount = Math.max(1, Math.round((Math.min(durationMs, 3_000) / 1_000) * SAMPLE_RATE))
  const wav = Buffer.allocUnsafe(44 + sampleCount * 2)
  wav.write('RIFF', 0, 'ascii')
  wav.writeUInt32LE(36 + sampleCount * 2, 4)
  wav.write('WAVE', 8, 'ascii')
  wav.write('fmt ', 12, 'ascii')
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(SAMPLE_RATE, 24)
  wav.writeUInt32LE(SAMPLE_RATE * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36, 'ascii')
  wav.writeUInt32LE(sampleCount * 2, 40)

  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.round(Math.sin((index / SAMPLE_RATE) * Math.PI * 2 * 220) * 600)
    wav.writeInt16LE(sample, 44 + index * 2)
  }
  return wav
}
