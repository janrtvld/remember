import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, copyFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

type ConversationAudioSource = { file: string } | { response: Response }

function audioExtension(source: ConversationAudioSource) {
  if ('file' in source) return 'wav'
  const contentType = source.response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  const extensions: Record<string, string> = {
    'audio/aac': 'aac',
    'audio/flac': 'flac',
    'audio/mp4': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
    'audio/wave': 'wav',
    'audio/webm': 'webm',
    'audio/x-m4a': 'm4a',
    'audio/x-wav': 'wav',
  }
  return extensions[contentType ?? ''] ?? 'audio'
}

export async function exportConversationAudio(input: {
  source: ConversationAudioSource
  name: string
  chooseDestination: (fileName: string, extension: string) => Promise<string | null>
}) {
  const { source } = input
  let temporaryPath: string | null = null
  try {
    if ('response' in source && (!source.response.ok || !source.response.body)) {
      throw new Error('conversation-audio-not-found')
    }
    const extension = audioExtension(source)
    // Titles are untrusted metadata, never a path or a file extension.
    const name = input.name
      .replace(/[\p{Cc}/\\:*?"<>|]+/gu, '-')
      .replace(/^\.+/, '')
      .trim()
      .slice(0, 120)
    const destination = await input.chooseDestination(`${name || 'Conversation'}.${extension}`, extension)
    if (!destination) return false

    temporaryPath = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`)
    if ('file' in source) {
      await copyFile(source.file, temporaryPath)
      await chmod(temporaryPath, 0o600)
    } else {
      await pipeline(
        Readable.fromWeb(source.response.body as Parameters<typeof Readable.fromWeb>[0]),
        createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 })
      )
    }
    // A failed copy or interrupted download must not replace an existing export.
    await rename(temporaryPath, destination)
    return true
  } finally {
    if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => undefined)
    if ('response' in source && !source.response.body?.locked) {
      await source.response.body?.cancel().catch(() => undefined)
    }
  }
}
