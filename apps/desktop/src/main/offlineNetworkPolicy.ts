import { isIP } from 'node:net'

export function isRemoteNetworkRequest(value: string) {
  try {
    const url = new URL(value)
    if (!['http:', 'https:', 'ws:', 'wss:', 'ftp:'].includes(url.protocol)) return false
    const hostname = url.hostname.toLowerCase()
    const isLoopbackIpv4 = isIP(hostname) === 4 && hostname.split('.')[0] === '127'
    return hostname !== 'localhost' && hostname !== '[::1]' && !isLoopbackIpv4
  } catch {
    return false
  }
}
