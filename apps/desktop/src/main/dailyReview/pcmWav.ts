import { closeSync, openSync, readSync, statSync, writeSync } from 'node:fs'

export interface PcmWavInfo {
  sampleRate: number
  sampleCount: number
  dataOffset: number
}

export function readPcmWavInfo(path: string): PcmWavInfo {
  const descriptor = openSync(path, 'r')
  try {
    const size = statSync(path).size
    const header = Buffer.alloc(24)
    if (
      readSync(descriptor, header, 0, 12, 0) !== 12 ||
      header.toString('ascii', 0, 4) !== 'RIFF' ||
      header.toString('ascii', 8, 12) !== 'WAVE'
    ) {
      throw new Error('conversation-audio-invalid-wav')
    }
    let sampleRate = 0
    for (let offset = 12; offset + 8 <= size; ) {
      if (readSync(descriptor, header, 0, 8, offset) !== 8) throw new Error('conversation-audio-invalid-wav')
      const id = header.toString('ascii', 0, 4)
      const length = header.readUInt32LE(4)
      const body = offset + 8
      if (body + length > size) throw new Error('conversation-audio-invalid-wav')
      if (id === 'fmt ') {
        if (
          length < 16 ||
          readSync(descriptor, header, 0, 16, body) !== 16 ||
          header.readUInt16LE(0) !== 1 ||
          header.readUInt16LE(2) !== 1 ||
          header.readUInt16LE(14) !== 16
        ) {
          throw new Error('conversation-audio-unsupported-wav')
        }
        sampleRate = header.readUInt32LE(4)
        if (sampleRate <= 0 || sampleRate > 192_000) throw new Error('conversation-audio-unsupported-wav')
      } else if (id === 'data') {
        if (!sampleRate || length % 2) throw new Error('conversation-audio-invalid-wav')
        return { sampleRate, sampleCount: length / 2, dataOffset: body }
      }
      offset = body + length + (length & 1)
    }
    throw new Error('conversation-audio-invalid-wav')
  } finally {
    closeSync(descriptor)
  }
}

function wavHeader(sampleRate: number, sampleCount: number) {
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 0 || sampleCount * 2 > 0xffffffff - 36) {
    throw new Error('conversation-audio-too-large')
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + sampleCount * 2, 4)
  header.write('WAVEfmt ', 8, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(sampleCount * 2, 40)
  return header
}

function writeAll(descriptor: number, bytes: Buffer) {
  let offset = 0
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset)
    if (written <= 0) throw new Error('conversation-audio-write-failed')
    offset += written
  }
}

export function* writePcmWavBlocks(path: string, sampleRate: number, sampleCount: number, blocks: Iterable<Buffer>) {
  const header = wavHeader(sampleRate, sampleCount)
  const descriptor = openSync(path, 'wx')
  try {
    writeAll(descriptor, header)
    let written = 0
    for (const block of blocks) {
      written += block.length
      if (written > sampleCount * 2) throw new Error('conversation-audio-size-mismatch')
      writeAll(descriptor, block)
      yield
    }
    if (written !== sampleCount * 2) throw new Error('conversation-audio-size-mismatch')
  } finally {
    closeSync(descriptor)
  }
}

export function writePcmWav(path: string, sampleRate: number, sampleCount: number, blocks: Iterable<Buffer>) {
  for (const _ of writePcmWavBlocks(path, sampleRate, sampleCount, blocks)) {
    // Synchronous callers consume the same bounded writer.
  }
}

export function* pcmSampleBlocks(path: string, info: PcmWavInfo, startSample = 0, endSample = info.sampleCount) {
  if (
    !Number.isSafeInteger(startSample) ||
    !Number.isSafeInteger(endSample) ||
    startSample < 0 ||
    endSample < startSample ||
    endSample > info.sampleCount
  ) {
    throw new Error('conversation-audio-invalid-range')
  }
  const descriptor = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(Math.min(160_000, endSample - startSample) * 2)
    for (let sample = startSample; sample < endSample; ) {
      const bytes = Math.min(buffer.length, (endSample - sample) * 2)
      const count = readSync(descriptor, buffer, 0, bytes, info.dataOffset + sample * 2)
      if (count !== bytes) throw new Error('conversation-audio-truncated')
      yield buffer.subarray(0, count)
      sample += count / 2
    }
  } finally {
    closeSync(descriptor)
  }
}

export interface PcmMixSource extends PcmWavInfo {
  path: string
  startedAt: number
  momentId: string
}

export interface PcmMixWindow {
  startedAt: number
  endedAt: number
  sources: PcmMixSource[]
}

export function* mixedPcmBlocks(windows: PcmMixWindow[], sampleRate: number) {
  for (const window of windows) {
    const windowSamples = Math.ceil(((window.endedAt - window.startedAt) * sampleRate) / 1000)
    for (let cursor = 0; cursor < windowSamples; cursor += 160_000) {
      const length = Math.min(160_000, windowSamples - cursor)
      const totals = new Int32Array(length)
      const counts = new Uint16Array(length)
      for (const source of window.sources) {
        const sourceOffset = Math.round(((source.startedAt - window.startedAt) * sampleRate) / 1000)
        const inputStart = Math.max(0, cursor - sourceOffset)
        const outputStart = Math.max(0, sourceOffset - cursor)
        const count = Math.min(source.sampleCount - inputStart, length - outputStart)
        if (count <= 0) continue
        const input = Buffer.alloc(count * 2)
        const descriptor = openSync(source.path, 'r')
        try {
          if (readSync(descriptor, input, 0, input.length, source.dataOffset + inputStart * 2) !== input.length) {
            throw new Error('conversation-audio-truncated')
          }
        } finally {
          closeSync(descriptor)
        }
        for (let index = 0; index < count; index++) {
          totals[outputStart + index] += input.readInt16LE(index * 2)
          counts[outputStart + index]++
        }
      }
      const output = Buffer.alloc(length * 2)
      for (let index = 0; index < length; index++) {
        const count = counts[index] ?? 0
        if (count)
          output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((totals[index] ?? 0) / count))), index * 2)
      }
      yield output
    }
  }
}
