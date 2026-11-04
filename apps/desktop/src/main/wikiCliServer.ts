import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { getAgentLearningStatus } from './agentLearning'
import { createContinuityStatusHandler } from './continuityCliProtocol'
import { createConversationReader } from './conversationReadProtocol'
import { getDailyReviewState } from './dailyReview'
import { getEvidenceStore } from './dailyReview/evidenceRepository'
import { createNativeConversationArchive } from './nativeConversationArchive'
import { getSettings } from './settings'
import { createWikiCliRequestHandler } from './wikiCliProtocol'
import {
  createWikiPage,
  deleteWikiPage,
  getWikiOverview,
  getWikiPageHistoryForSpace,
  listWikiPages,
  proposeWikiPageChange,
  saveWikiPage,
} from './wikiSpaceStore'

const MAX_REQUEST_BYTES = 1_000_000
let server: Server | null = null
let activeSocketPath: string | null = null

function socketPath() {
  return join(app.getPath('userData'), 'daily-review', 'remember-agent.sock')
}

const handleRequest = createWikiCliRequestHandler({
  getHistory: (spaceId, slug) => getWikiPageHistoryForSpace({ spaceId, slug }),
  getSpaces: () => getWikiOverview([]).spaces,
  listPages: listWikiPages,
  createPage: createWikiPage,
  savePage: saveWikiPage,
  deletePage: (spaceId, slug) => deleteWikiPage({ spaceId, slug }),
  proposePage: proposeWikiPageChange,
})

export async function startWikiCliServer(): Promise<void> {
  if (server) return
  const path = socketPath()
  mkdirSync(dirname(path), { recursive: true })
  rmSync(path, { force: true })

  const handleContinuity = createContinuityStatusHandler({
    dataDirectory: dirname(path),
    getCaptureState: getDailyReviewState,
    getSettings,
    getLearningStatus: getAgentLearningStatus,
  })
  const readConversations = createConversationReader({
    archive: createNativeConversationArchive(() => {}),
    dates: () =>
      getEvidenceStore()
        .readConversationSessions()
        .map((session) => session.localDay),
  })

  const nextServer = createServer((connection) => {
    let request = Buffer.alloc(0)
    let handled = false
    const respond = async () => {
      if (handled) return
      handled = true
      try {
        const value = JSON.parse(request.toString('utf8')) as unknown
        if (value && typeof value === 'object' && 'action' in value && value.action === 'conversations.read') {
          const { id, query } = value as Record<string, unknown>
          if (typeof id !== 'string' || !id) throw new Error('invalid-request-id')
          if (Object.keys(value).some((key) => !['id', 'action', 'query'].includes(key)))
            throw new Error('invalid-request')
          const result = await readConversations(query, AbortSignal.timeout(30_000))
          if (!connection.destroyed) connection.end(`${JSON.stringify({ id, ok: true, result })}\n`)
          return
        }
        if (value && typeof value === 'object' && 'action' in value && value.action === 'continuity.status') {
          connection.end(`${JSON.stringify(handleContinuity(value))}\n`)
          return
        }
        const response = await handleRequest(value)
        if (!connection.destroyed) connection.end(`${JSON.stringify(response)}\n`)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'invalid-request'
        connection.end(`${JSON.stringify({ id: 'unknown', ok: false, error: message })}\n`)
      }
    }
    connection.on('data', (chunk) => {
      request = Buffer.concat([request, Buffer.from(chunk)])
      if (request.length > MAX_REQUEST_BYTES) {
        handled = true
        connection.end(`${JSON.stringify({ id: 'unknown', ok: false, error: 'request-too-large' })}\n`)
        return
      }
      if (request.includes(0x0a)) void respond()
    })
    connection.on('end', () => void respond())
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      nextServer.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      nextServer.off('error', onError)
      resolve()
    }
    nextServer.once('error', onError)
    nextServer.once('listening', onListening)
    nextServer.listen(path)
  })
  chmodSync(path, 0o600)
  nextServer.on('error', (error) => console.error('[wiki-cli] Local bridge error', error))
  server = nextServer
  activeSocketPath = path
}

export function disposeWikiCliServer(): void {
  const current = server
  const path = activeSocketPath
  server = null
  activeSocketPath = null
  current?.close()
  if (path) rmSync(path, { force: true })
}
