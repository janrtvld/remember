import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { exportConversationAudio } from '../conversationAudioExport'

test('exports retained audio without changing the source and confines untrusted titles to a filename', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'remember-audio-export-'))
  try {
    const source = join(directory, 'retained.wav')
    const destination = join(directory, 'download.wav')
    const bytes = Buffer.from('RIFF retained recording')
    await writeFile(source, bytes)
    const saved = await exportConversationAudio({
      source: { file: source },
      name: '../../Meeting\u0000/notes: discussion.exe',
      chooseDestination: async (name, extension) => {
        assert.equal(basename(name), name)
        assert.equal(name.includes('\u0000'), false)
        assert.equal(extension, 'wav')
        assert.equal(name.endsWith('.wav'), true)
        return destination
      },
    })
    assert.equal(saved, true)
    assert.deepEqual(await readFile(destination), bytes)
    assert.deepEqual(await readFile(source), bytes)
    assert.deepEqual((await readdir(directory)).sort(), ['download.wav', 'retained.wav'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('cancelling the save dialog releases remote audio without writing a file', async () => {
  let canceled = false
  const response = new Response(
    new ReadableStream({
      cancel() {
        canceled = true
      },
    }),
    { headers: { 'Content-Type': 'audio/mpeg' } }
  )
  assert.equal(
    await exportConversationAudio({
      source: { response },
      name: 'Conversation',
      chooseDestination: async () => null,
    }),
    false
  )
  assert.equal(canceled, true)
})

test('remote exports preserve the recording format and contents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'remember-audio-export-'))
  try {
    const destination = join(directory, 'download.m4a')
    const bytes = Buffer.from('remote recording bytes')
    assert.equal(
      await exportConversationAudio({
        source: { response: new Response(bytes, { headers: { 'Content-Type': 'audio/mp4; charset=binary' } }) },
        name: 'Recorded meeting',
        chooseDestination: async (name, extension) => {
          assert.equal(name, 'Recorded meeting.m4a')
          assert.equal(extension, 'm4a')
          return destination
        },
      }),
      true
    )
    assert.deepEqual(await readFile(destination), bytes)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a failed download keeps an existing destination intact and removes incomplete audio', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'remember-audio-export-'))
  try {
    const destination = join(directory, 'download.wav')
    await writeFile(destination, 'previous export')
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]))
          controller.error(new Error('connection interrupted'))
        },
      }),
      { headers: { 'Content-Type': 'audio/wav' } }
    )
    await assert.rejects(
      exportConversationAudio({
        source: { response },
        name: 'Conversation',
        chooseDestination: async () => destination,
      }),
      /connection interrupted/
    )
    assert.equal(existsSync(destination), true)
    assert.equal(await readFile(destination, 'utf8'), 'previous export')
    assert.deepEqual(await readdir(directory), ['download.wav'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
