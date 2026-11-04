const { createHash } = require('node:crypto')
const { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const { assertStableVersion } = require('./verify-public-package.cjs')

function escrowSourceMaps(project, version) {
  assertStableVersion(version)
  const destination = path.join(project, '.release-source-maps', version)
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true, mode: 0o700 })
  const files = []
  let maps = 0
  function copy(directory, relative) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const source = path.join(directory, entry.name)
      const name = `${relative}/${entry.name}`
      if (entry.isDirectory()) copy(source, name)
      else if (entry.isFile() && /\.(?:map|[cm]?js|css)$/.test(entry.name)) {
        const target = path.join(destination, name)
        mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
        copyFileSync(source, target)
        files.push({ path: name, sha512: createHash('sha512').update(readFileSync(target)).digest('base64') })
        if (entry.name.endsWith('.map')) {
          maps++
          rmSync(source)
        }
      }
    }
  }
  copy(path.join(project, 'out', 'main'), 'out/main')
  copy(path.join(project, 'out', 'preload'), 'out/preload')
  copy(path.join(project, '..', 'web', 'out'), 'web')
  if (maps === 0) throw new Error('release-source-maps-missing')
  files.sort((a, b) => a.path.localeCompare(b.path))
  writeFileSync(path.join(destination, 'manifest.json'), `${JSON.stringify({ version, maps, files }, null, 2)}\n`, {
    mode: 0o600,
  })
  return { version, maps, directory: destination }
}

function verifySourceMaps(project, version) {
  assertStableVersion(version)
  const directory = path.join(project, '.release-source-maps', version)
  const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'))
  if (
    manifest.version !== version ||
    !Number.isSafeInteger(manifest.maps) ||
    manifest.maps < 1 ||
    !Array.isArray(manifest.files)
  )
    throw new Error('release-source-map-manifest-invalid')
  const actualFiles = []
  function inventory(current, prefix = '') {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) throw new Error(`release-source-map-link:${name}`)
      if (entry.isDirectory()) inventory(path.join(current, entry.name), name)
      else if (name !== 'manifest.json') actualFiles.push(name)
    }
  }
  inventory(directory)
  if (
    JSON.stringify(actualFiles.sort()) !== JSON.stringify(manifest.files.map((file) => file.path).sort()) ||
    manifest.files.filter((file) => file.path.endsWith('.map')).length !== manifest.maps
  )
    throw new Error('release-source-map-inventory-mismatch')
  for (const file of manifest.files) {
    const target = path.resolve(directory, file.path)
    if (!target.startsWith(`${directory}${path.sep}`)) throw new Error('release-source-map-path-invalid')
    if (createHash('sha512').update(readFileSync(target)).digest('base64') !== file.sha512)
      throw new Error(`release-source-map-modified:${file.path}`)
  }
  return manifest
}

module.exports = { escrowSourceMaps, verifySourceMaps }
if (require.main === module) {
  const project = path.resolve(__dirname, '..')
  const version = require('../package.json').version
  console.log(escrowSourceMaps(project, version))
}
