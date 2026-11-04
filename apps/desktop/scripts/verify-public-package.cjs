const { createHash } = require('node:crypto')
const {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} = require('node:fs')
const { createRequire } = require('node:module')
const path = require('node:path')

function asarTools() {
  const builderRequire = createRequire(require.resolve('electron-builder'))
  return createRequire(builderRequire.resolve('app-builder-lib'))('@electron/asar')
}

function assertStableVersion(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('stable-version-required')
  return version
}

function assertPublicPath(name) {
  const parts = name.replaceAll('\\', '/').split('/')
  if (
    parts.some((part) =>
      /^(?:personal|private-agent|\.codex|\.claude|\.aws|\.qa|\.remember-dev|\.env(?:\..*)?|auth\.json|credentials\.json|settings\.json|runtime\.json)$/i.test(
        part
      )
    ) ||
    /\.(?:map(?:\.(?:gz|br))?|sqlite3?(?:-wal|-shm)?|db(?:-wal|-shm)?|wav|aiff|pcm|pem|p8|p12)$/i.test(name)
  )
    throw new Error(`public-package-private-file:${name}`)
}

function assertPublicContent(name, buffer) {
  const text = buffer.toString('utf8').replaceAll('\\/', '/').replaceAll('\\n', '\n')
  const rules = [
    ['private-home-path', /\/Users\/jan(?:\/|[\\"'\s]|$)/i],
    ['private-account-email', /\bjan@(?:pionyr\.nl|example\.com)\b/i],
    ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\r\n]{80,}/],
    // Extended OpenAI families use whole-token boundaries to exclude adjacent public prefix constants.
    [
      'provider-token',
      /\b(?:sk-proj-|sk-ant-(?:api|oat|admin)\d+-)[A-Za-z0-9_-]{24,}\b|(?<![A-Za-z0-9_-])sk-(?:(?:svcacct|admin)-[A-Za-z0-9_-]{24,}|[A-Za-z0-9]{48})(?![A-Za-z0-9_-])/,
    ],
    [
      'service-token',
      /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{24,})\b/,
    ],
    ['inline-source-map', /sourceMappingURL=data:application\/json[^\r\n,]*;base64,[A-Za-z0-9+/=]{80,}/],
  ]
  for (const [rule, expression] of rules)
    if (expression.test(text)) throw new Error(`public-package-private-content:${rule}:${name}`)
}

function scanResourceFile(file, name) {
  const descriptor = openSync(file, 'r')
  const buffer = Buffer.alloc(1024 * 1024)
  let previous = Buffer.alloc(0)
  try {
    while (true) {
      const size = readSync(descriptor, buffer, 0, buffer.length, null)
      if (size === 0) break
      const sample = Buffer.concat([previous, buffer.subarray(0, size)])
      assertPublicContent(name, sample)
      previous = Buffer.from(sample.subarray(-16 * 1024))
    }
  } finally {
    closeSync(descriptor)
  }
}

function resourceFiles(directory, prefix = '', root = directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) {
      const target = realpathSync(path.join(directory, entry.name))
      if (!target.startsWith(`${root}${path.sep}`)) throw new Error(`public-package-external-symlink:${name}`)
      return [name]
    }
    return entry.isDirectory() ? resourceFiles(path.join(directory, entry.name), name, root) : [name]
  })
}

function verifyPublicPackage(appPath, version, requireUpdater = true) {
  assertStableVersion(version)
  const resources = path.resolve(appPath, 'Contents', 'Resources')
  const archive = path.join(resources, 'app.asar')
  const asar = asarTools()
  const names = asar.listPackage(archive).map((name) => name.replace(/^\//, ''))
  const resourceNames = resourceFiles(resources)
  for (const name of [...names, ...resourceNames]) assertPublicPath(name)
  let scannedFiles = 0
  for (const name of names) {
    const entry = asar.statFile(archive, name, false)
    if (entry.files || entry.link) continue
    assertPublicContent(name, asar.extractFile(archive, name))
    scannedFiles++
  }
  for (const name of resourceNames) {
    const file = path.join(resources, name)
    if (name === 'app.asar' || !statSync(file).isFile()) continue
    scanResourceFile(file, name)
    scannedFiles++
  }
  const metadata = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'))
  if (metadata.version !== version || metadata.main !== './out/main/index.js')
    throw new Error('public-package-metadata-mismatch')
  if (!names.includes('out/main/index.js')) throw new Error('public-package-main-missing')
  for (const name of [
    'THIRD_PARTY_NOTICES.md',
    'codex-APACHE-2.0.txt',
    'claude-agent-sdk.txt',
    'electron-LICENSE.txt',
    'LICENSES.chromium.html',
  ]) {
    const file = path.join(resources, 'licenses', name)
    if (!existsSync(file) || statSync(file).size === 0) throw new Error(`public-package-license-missing:${name}`)
  }
  const updaterPath = path.join(resources, 'app-update.yml')
  if (requireUpdater || existsSync(updaterPath)) {
    const updater = readFileSync(updaterPath, 'utf8')
    for (const line of ['provider: github', 'owner: janrtvld', 'repo: remember', 'channel: latest'])
      if (!updater.split('\n').includes(line)) throw new Error(`public-package-updater-invalid:${line}`)
    if (/^\s*(?:token|password|authorization|private)\s*:/im.test(updater))
      throw new Error('public-package-updater-credentials')
  }
  return {
    version,
    updater: requireUpdater ? 'public-latest' : 'checked-before-signing',
    contentScan: { files: scannedFiles, rules: 'private-paths-emails-keys-tokens-inline-maps' },
    appArchiveSha512: createHash('sha512').update(readFileSync(archive)).digest('base64'),
  }
}

module.exports = { asarTools, assertStableVersion, assertPublicPath, assertPublicContent, verifyPublicPackage }
module.exports.default = async (context) => {
  verifyPublicPackage(path.join(context.appOutDir, 'Remember.app'), context.packager.appInfo.version, false)
}
