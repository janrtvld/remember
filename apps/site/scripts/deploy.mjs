import { spawnSync } from 'node:child_process'

function cf(args) {
  const result = spawnSync('cf', args, { encoding: 'utf8' })
  process.stdout.write(result.stdout || '')
  process.stderr.write(result.stderr || '')
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status || 1)
  return `${result.stdout}\n${result.stderr}`
}

// The pinned cf CLI reports the uploaded version on stderr, not as JSON.
// Deploy that exact version; listing the latest version would race other builds.
const output = cf(['workers', 'versions', 'create', '--prebuilt'])
const versions = [
  ...output.matchAll(/Worker Version ID: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g),
]
if (versions.length !== 1) throw new Error('Expected exactly one uploaded Worker version')
cf([
  'workers',
  'deployments',
  'create',
  '--worker',
  'remember-site',
  '--strategy',
  'percentage',
  '--versions',
  JSON.stringify([{ version_id: versions[0][1], percentage: 100 }]),
])
