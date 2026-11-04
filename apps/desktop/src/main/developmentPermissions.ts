import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const DEVELOPMENT_PERMISSION_TARGETS = [
  { service: 'Accessibility', bundleId: 'com.github.Electron' },
  { service: 'Accessibility', bundleId: 'computer.remember.app.context-capture' },
  { service: 'Microphone', bundleId: 'com.github.Electron' },
  { service: 'Microphone', bundleId: 'computer.remember.app.microphone-audio-capture' },
  { service: 'AudioCapture', bundleId: 'computer.remember.app.system-audio-capture' },
  { service: 'ScreenCapture', bundleId: 'computer.remember.app.system-audio-capture' },
] as const

export async function resetDevelopmentPermissions(
  resetPermission = (service: string, bundleId: string) =>
    execFileAsync('/usr/bin/tccutil', ['reset', service, bundleId]).then(() => undefined)
) {
  const failures: unknown[] = []

  for (const { service, bundleId } of DEVELOPMENT_PERMISSION_TARGETS) {
    try {
      await resetPermission(service, bundleId)
    } catch (error) {
      failures.push(error)
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, `Could not reset ${failures.length} development permission targets`)
  }
}
