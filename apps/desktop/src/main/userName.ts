import { execFile } from 'node:child_process'
import { userInfo } from 'node:os'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export async function getUserName() {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('/usr/bin/id', ['-F'], { encoding: 'utf8' })
      return firstName(stdout)
    } catch {
      // Fall through to the portable account-name fallback.
    }
  }

  return firstName(userInfo().username)
}

function firstName(name: string) {
  const value = name.trim().split(/\s+/)[0]
  if (!value) return null
  return value.charAt(0).toLocaleUpperCase() + value.slice(1)
}
