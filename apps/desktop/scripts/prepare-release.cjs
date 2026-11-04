const { createReadStream } = require('node:fs')
const { mkdtemp, readFile, rm, stat, writeFile } = require('node:fs/promises')
const { createHash } = require('node:crypto')
const { execFile } = require('node:child_process')
const os = require('node:os')
const path = require('node:path')
const { promisify } = require('node:util')
const { gunzip } = require('node:zlib')
const { verifyPackagedSherpa } = require('./verify-packaged-sherpa.cjs')
const { assertStableVersion, verifyPublicPackage } = require('./verify-public-package.cjs')
const { verifySourceMaps } = require('./release-source-maps.cjs')

const execFileAsync = promisify(execFile)
const gunzipAsync = promisify(gunzip)
const releaseAssets = [
  'Remember-arm64.dmg',
  'Remember-arm64.dmg.blockmap',
  'Remember-arm64.zip',
  'Remember-arm64.zip.blockmap',
  'latest-mac.yml',
]
const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/

async function readReleaseSource(project, expectedCommit) {
  if (expectedCommit !== undefined && !commitPattern.test(expectedCommit))
    throw new Error('prepared-release-source-commit-invalid')
  const { stdout: commit } = await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: project })
  const { stdout: dirty } = await execFileAsync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: project,
  })
  if (dirty.trim()) throw new Error('release-source-tree-dirty')
  if (!commitPattern.test(commit.trim())) throw new Error('release-source-commit-invalid')
  if (expectedCommit !== undefined && commit.trim() !== expectedCommit)
    throw new Error('prepared-release-source-commit-mismatch')
  return { commit: commit.trim(), dirty: false }
}

function assertPublicManifest(manifest) {
  const fields = (value, keys) =>
    value && typeof value === 'object' && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys.sort())
  const hash = (value) => typeof value === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(value)
  const count = (value) => Number.isSafeInteger(value) && value > 0
  if (
    !fields(manifest, ['version', 'source', 'app', 'sourceMapsSha512', 'sourceMapCount', 'assets']) ||
    !fields(manifest.source, ['commit', 'dirty']) ||
    !commitPattern.test(manifest.source.commit) ||
    manifest.source.dirty !== false ||
    !fields(manifest.app, ['version', 'updater', 'contentScan', 'appArchiveSha512', 'teamId', 'codeHash']) ||
    manifest.app.version !== manifest.version ||
    manifest.app.updater !== 'public-latest' ||
    !fields(manifest.app.contentScan, ['files', 'rules']) ||
    !count(manifest.app.contentScan.files) ||
    manifest.app.contentScan.rules !== 'private-paths-emails-keys-tokens-inline-maps' ||
    !hash(manifest.app.appArchiveSha512) ||
    !/^[A-Z0-9]{10}$/.test(manifest.app.teamId) ||
    !/^[a-f0-9]{40}$/.test(manifest.app.codeHash) ||
    !hash(manifest.sourceMapsSha512) ||
    !count(manifest.sourceMapCount) ||
    !fields(manifest.assets, [...releaseAssets]) ||
    !releaseAssets.every(
      (name) =>
        fields(manifest.assets[name], ['size', 'sha512']) &&
        count(manifest.assets[name].size) &&
        hash(manifest.assets[name].sha512)
    )
  )
    throw new Error('prepared-release-public-metadata-invalid')
}

async function hashFile(filePath) {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('base64')
}

async function verifyBlockMap(blockMapPath, artifactPath) {
  const [blockMapStats, artifactStats, compressedBlockMap] = await Promise.all([
    stat(blockMapPath),
    stat(artifactPath),
    readFile(blockMapPath),
  ])
  if (blockMapStats.size === 0) throw new Error(`Release artifact is empty: ${path.basename(blockMapPath)}`)
  if (blockMapStats.mtimeMs < artifactStats.mtimeMs)
    throw new Error(`Release blockmap is older than its artifact: ${path.basename(blockMapPath)}`)
  const blockMap = JSON.parse((await gunzipAsync(compressedBlockMap)).toString('utf8'))
  if (blockMap.version !== '2' || !Array.isArray(blockMap.files) || blockMap.files.length === 0)
    throw new Error(`Release blockmap is invalid: ${path.basename(blockMapPath)}`)
}

async function verifySignedApp(appPath, version, expectedHash) {
  const privacy = verifyPublicPackage(appPath, version)
  await execFileAsync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
  const { stderr } = await execFileAsync('codesign', ['-d', '--verbose=4', appPath])
  const teamId = /^TeamIdentifier=(.+)$/m.exec(stderr)?.[1]
  const codeHash = /^CDHash=(.+)$/m.exec(stderr)?.[1]
  if (!process.env.APPLE_TEAM_ID || teamId !== process.env.APPLE_TEAM_ID)
    throw new Error('release-signing-team-mismatch')
  if (!stderr.includes('Timestamp=') || !codeHash) throw new Error('release-signature-incomplete')
  if (expectedHash && codeHash !== expectedHash) throw new Error('release-archive-app-mismatch')
  await execFileAsync('xcrun', ['stapler', 'validate', appPath])
  return { ...privacy, teamId, codeHash }
}

async function verifyZip(zipPath, version, codeHash) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'remember-release-zip-'))
  try {
    await execFileAsync('ditto', ['-x', '-k', zipPath, directory])
    await verifySignedApp(path.join(directory, 'Remember.app'), version, codeHash)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}

async function verifyDmg(dmgPath, version, codeHash) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'remember-release-dmg-'))
  let mounted = false
  try {
    await execFileAsync('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', directory, dmgPath])
    mounted = true
    await verifySignedApp(path.join(directory, 'Remember.app'), version, codeHash)
  } finally {
    if (mounted) await execFileAsync('hdiutil', ['detach', directory])
    await rm(directory, { force: true, recursive: true })
  }
}

async function assetRecords(directory) {
  const records = {}
  for (const name of releaseAssets) {
    const file = path.join(directory, name)
    const size = (await stat(file)).size
    if (size === 0) throw new Error(`release-asset-empty:${name}`)
    records[name] = { size, sha512: await hashFile(file) }
  }
  return records
}

async function verifyPreparedAssets(directory, version, project = path.resolve(__dirname, '..')) {
  assertStableVersion(version)
  const manifest = JSON.parse(await readFile(path.join(directory, 'prepared-release.json'), 'utf8'))
  if (
    manifest.version !== version ||
    !manifest.assets ||
    JSON.stringify(Object.keys(manifest.assets)) !== JSON.stringify(releaseAssets)
  )
    throw new Error('prepared-release-version-or-assets-mismatch')
  assertPublicManifest(manifest)
  await readReleaseSource(project, manifest.source.commit)
  const current = await assetRecords(directory)
  for (const name of releaseAssets)
    if (JSON.stringify(current[name]) !== JSON.stringify(manifest.assets[name]))
      throw new Error(`prepared-release-asset-modified:${name}`)
  return manifest
}

async function prepareRelease(verifyOnly = false, expectedCommit) {
  const project = path.resolve(__dirname, '..')
  const source = await readReleaseSource(project, expectedCommit)
  const directory = path.join(project, 'release')
  const version = assertStableVersion(JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8')).version)
  const existing = verifyOnly ? await verifyPreparedAssets(directory, version) : null
  const maps = verifySourceMaps(project, version)
  const mapManifestHash = await hashFile(path.join(project, '.release-source-maps', version, 'manifest.json'))
  if (existing && (existing.sourceMapsSha512 !== mapManifestHash || existing.sourceMapCount !== maps.maps))
    throw new Error('prepared-release-source-maps-modified')
  const appPath = path.join(directory, 'mac-arm64', 'Remember.app')
  const verifiedApp = await verifySignedApp(appPath, version)
  if (existing && JSON.stringify(existing.app) !== JSON.stringify(verifiedApp))
    throw new Error('prepared-release-app-modified')
  await verifyPackagedSherpa(appPath)
  const zipPath = path.join(directory, 'Remember-arm64.zip')
  const dmgPath = path.join(directory, 'Remember-arm64.dmg')
  await verifyBlockMap(`${zipPath}.blockmap`, zipPath)
  await verifyBlockMap(`${dmgPath}.blockmap`, dmgPath)
  await verifyZip(zipPath, version, verifiedApp.codeHash)
  await verifyDmg(dmgPath, version, verifiedApp.codeHash)
  await readReleaseSource(project, source.commit)
  if (verifyOnly) {
    console.log(`[release] prepared ${version} remains signed, stapled and unchanged`)
    return existing
  }
  const [zipStats, dmgStats, zipHash, dmgHash] = await Promise.all([
    stat(zipPath),
    stat(dmgPath),
    hashFile(zipPath),
    hashFile(dmgPath),
  ])
  await writeFile(
    path.join(directory, 'latest-mac.yml'),
    `version: ${version}
files:
  - url: Remember-arm64.zip
    sha512: ${zipHash}
    size: ${zipStats.size}
  - url: Remember-arm64.dmg
    sha512: ${dmgHash}
    size: ${dmgStats.size}
path: Remember-arm64.zip
sha512: ${zipHash}
releaseDate: '${new Date().toISOString()}'
`
  )
  const manifest = {
    version,
    source,
    app: verifiedApp,
    sourceMapsSha512: mapManifestHash,
    sourceMapCount: maps.maps,
    assets: await assetRecords(directory),
  }
  assertPublicManifest(manifest)
  await writeFile(path.join(directory, 'prepared-release.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  })
  console.log(
    `[release] prepared ${version}: signed and stapled app, ZIP, DMG, updater metadata and private source maps verified`
  )
  return manifest
}

module.exports = {
  releaseAssets,
  hashFile,
  verifyBlockMap,
  assetRecords,
  readReleaseSource,
  assertPublicManifest,
  verifyPreparedAssets,
  prepareRelease,
}
if (require.main === module) {
  const [mode, commit, ...extra] = process.argv.slice(2)
  if (
    extra.length ||
    (mode === '--prepare'
      ? !commit || !commitPattern.test(commit)
      : commit || (mode && !['--verify', '--source'].includes(mode)))
  )
    throw new Error('usage: prepare-release.cjs [--verify|--source|--prepare <source-commit>]')
  const operation =
    mode === '--source'
      ? readReleaseSource(path.resolve(__dirname, '..')).then((source) => console.log(source.commit))
      : prepareRelease(mode === '--verify', commit)
  operation.catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
