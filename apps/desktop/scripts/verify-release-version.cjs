const { readFileSync } = require('node:fs')
const path = require('node:path')
const { assertStableVersion } = require('./verify-public-package.cjs')

const repository = path.resolve(__dirname, '../../..')
const packages = [
  'package.json',
  'packages/shared/package.json',
  'apps/desktop/package.json',
  'apps/web/package.json',
  'apps/site/package.json',
]
const version = assertStableVersion(require('../package.json').version)
for (const name of packages) {
  const metadata = JSON.parse(readFileSync(path.join(repository, name), 'utf8'))
  if (metadata.version !== version) throw new Error(`release-version-mismatch:${name}`)
}
console.log(`Verified public release version ${version}`)
