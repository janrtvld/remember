import path from 'node:path'

const CODEX_TARGET = 'aarch64-apple-darwin'

export function bundledCodexExecutablePath({
  isPackaged,
  appPath,
  resourcesPath,
  platform = process.platform,
  architecture = process.arch,
}: {
  isPackaged: boolean
  appPath: string
  resourcesPath: string
  platform?: NodeJS.Platform
  architecture?: string
}) {
  if (platform !== 'darwin' || architecture !== 'arm64') return null
  if (isPackaged) return path.join(resourcesPath, 'codex')
  return path.join(appPath, 'node_modules', '@openai', 'codex-darwin-arm64', 'vendor', CODEX_TARGET, 'bin', 'codex')
}
