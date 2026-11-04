import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { resolvePackagedWebPath } from './packagedWebPath'

const mimeTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.mp3': 'audio/mpeg',
  '.svg': 'image/svg+xml',
  // Next's static export uses these payloads for client-side navigation.
  '.txt': 'text/x-component; charset=utf-8',
  '.woff2': 'font/woff2',
}

export function createPackagedWebServer(root: string) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const target = resolvePackagedWebPath(root, url.pathname)
      if (!target) {
        response.writeHead(403).end()
        return
      }
      const body = await readFile(target)
      response.writeHead(200, {
        'Content-Type': mimeTypes[path.extname(target)] ?? 'application/octet-stream',
        'Cache-Control': path.relative(root, target).startsWith(`_next${path.sep}static${path.sep}`)
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      })
      response.end(body)
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Not found')
    }
  })
}
