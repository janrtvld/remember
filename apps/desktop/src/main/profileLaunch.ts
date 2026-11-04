import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'

type ProfileEnvironment = { isPackaged: boolean; uid: number }

/** Explicit profile selection validates a private local directory, never an account or execution grant. */
export function profileLaunchDirectory(argv: readonly string[], environment: ProfileEnvironment): string | null {
  const flags = argv.filter(
    (argument) => argument === '--remember-profile' || argument.startsWith('--remember-profile=')
  )
  if (flags.length === 0) return null
  if (flags.length !== 1 || !flags[0].startsWith('--remember-profile=')) {
    throw new Error('profile-argument-invalid')
  }
  if (!environment.isPackaged) throw new Error('profile-packaged-required')

  const directory = flags[0].slice('--remember-profile='.length)
  if (
    directory.length === 0 ||
    directory.length > 4096 ||
    directory.trim() !== directory ||
    [...directory].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
    !path.isAbsolute(directory) ||
    path.normalize(directory) !== directory ||
    directory === '/' ||
    directory.endsWith('/')
  ) {
    throw new Error('profile-path-invalid')
  }

  const before = lstatSync(directory)
  if (!before.isDirectory() || before.isSymbolicLink() || realpathSync(directory) !== directory) {
    throw new Error('profile-path-unsafe')
  }
  if (before.uid !== environment.uid) throw new Error('profile-owner')
  if ((before.mode & 0o7777) !== 0o700) throw new Error('profile-permissions')

  const after = lstatSync(directory)
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.uid !== before.uid ||
    after.mode !== before.mode ||
    realpathSync(directory) !== directory
  ) {
    throw new Error('profile-changed')
  }
  return directory
}
