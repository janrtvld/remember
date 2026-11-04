const { execFile } = require('node:child_process')
const { lstat, open, readdir } = require('node:fs/promises')
const path = require('node:path')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)
const bundleExtensions = new Set(['.app', '.appex', '.bundle', '.framework', '.xpc'])
const machoMagic = new Set([
  0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca,
])

async function isMachO(filePath) {
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(4)
    const { bytesRead } = await handle.read(buffer, 0, 4, 0)
    return bytesRead === 4 && machoMagic.has(buffer.readUInt32BE(0))
  } finally {
    await handle.close()
  }
}

async function collectCode(rootPath) {
  const machoFiles = []
  const bundles = []

  async function walk(currentPath) {
    const entries = await readdir(currentPath, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (bundleExtensions.has(path.extname(entry.name))) bundles.push(entryPath)
        await walk(entryPath)
        continue
      }
      if (!entry.isFile()) continue
      const stats = await lstat(entryPath)
      if (stats.size >= 4 && (await isMachO(entryPath))) machoFiles.push(entryPath)
    }
  }

  await walk(rootPath)
  return { machoFiles, bundles }
}

function deepestFirst(left, right) {
  return right.split(path.sep).length - left.split(path.sep).length
}

async function signPath(filePath, identity, entitlements) {
  const args = ['--force', '--sign', identity, '--options', 'runtime']
  // Apple requires every Developer ID signature submitted for notarization to
  // carry a trusted timestamp. Ad-hoc development signatures cannot use one.
  if (identity !== '-') args.push('--timestamp')
  if (entitlements) args.push('--entitlements', entitlements)
  args.push(filePath)
  await execFileAsync('codesign', args)
}

async function resolveIdentity(identity) {
  if (identity === '-') return identity
  const { stdout } = await execFileAsync('security', ['find-identity', '-v', '-p', 'codesigning'])
  const identityLine = stdout.split('\n').find((line) => line.toUpperCase().includes(identity.toUpperCase()))
  const identityName = identityLine?.match(/"([^"]+)"/)?.[1]
  if (!identityName) throw new Error(`Could not resolve signing identity ${identity}.`)
  return identityName
}

exports.default = async function signMacApp(configuration) {
  const appPath = path.resolve(configuration.app)
  if (!configuration.identity) throw new Error('A macOS signing identity is required.')
  const identity = await resolveIdentity(configuration.identity)

  const { machoFiles, bundles } = await collectCode(appPath)
  const inheritedOptions = configuration.optionsForFile?.(path.join(appPath, 'Contents'))
  const appOptions = configuration.optionsForFile?.(appPath)

  for (const filePath of machoFiles.sort(deepestFirst)) {
    await signPath(filePath, identity, inheritedOptions?.entitlements)
  }

  for (const bundlePath of bundles.sort(deepestFirst)) {
    await signPath(bundlePath, identity, inheritedOptions?.entitlements)
  }

  await signPath(appPath, identity, appOptions?.entitlements)
  await execFileAsync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])

  if (identity !== '-') {
    const { stderr } = await execFileAsync('codesign', ['-dvv', appPath])
    if (!stderr.includes('Timestamp=')) {
      throw new Error('The Developer ID signature does not contain a trusted timestamp.')
    }
  }

  console.log(`[sign] verified ${machoFiles.length} Mach-O files and ${bundles.length + 1} bundles`)
}
