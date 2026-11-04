const { access } = require('node:fs/promises')
const { execFile } = require('node:child_process')
const path = require('node:path')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)

async function verifyPackagedSherpa(appPath) {
  const resourcesPath = path.join(appPath, 'Contents', 'Resources')
  const modulePath = path.join(resourcesPath, 'sherpa', 'node_modules', 'sherpa-onnx-node')
  const nativeDirectory = path.join(resourcesPath, 'sherpa', 'node_modules', 'sherpa-onnx-darwin-arm64')
  const runtimePath = path.join(nativeDirectory, 'libonnxruntime.dylib')
  const executablePath = path.join(appPath, 'Contents', 'MacOS', 'Remember')

  await Promise.all([access(modulePath), access(runtimePath), access(executablePath)])

  const probe = `
    const sherpa = require(process.argv[1])
    if (typeof sherpa.OfflineRecognizer !== 'function' || typeof sherpa.Vad !== 'function') {
      throw new Error('Packaged Sherpa runtime is missing transcription exports.')
    }
  `
  await execFileAsync(executablePath, ['-e', probe, modulePath], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
}

module.exports = { verifyPackagedSherpa }

if (require.main === module) {
  const appPath = process.argv[2]
  if (!appPath) {
    console.error('Usage: node scripts/verify-packaged-sherpa.cjs /path/to/Remember.app')
    process.exit(1)
  }
  verifyPackagedSherpa(path.resolve(appPath))
    .then(() => console.log('[package] verified packaged Sherpa transcription runtime'))
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })
}
