import { type NextRequest, NextResponse } from 'next/server'

export function proxy(request: NextRequest) {
  const url = new URL(request.url)
  if (url.hostname !== 'remember.computer') return NextResponse.next()

  url.hostname = 'www.remember.computer'
  url.protocol = 'https:'
  url.port = ''
  return NextResponse.redirect(url, 308)
}
