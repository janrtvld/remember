import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function GET() {
  if (process.env.NODE_ENV !== 'development') return new Response(null, { status: 404 })
  const image = await readFile(join(process.cwd(), 'app/proto/hero/assets/after-hours-studio.png'))
  return new Response(image, {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' },
  })
}
