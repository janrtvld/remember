import path from 'node:path'

export function developmentUserDataDirectory(value: string | undefined, isPackaged: boolean): string | null {
  if (isPackaged || value == null || value.trim() === '') return null
  if (!path.isAbsolute(value)) throw new Error('REMEMBER_USER_DATA_DIR must be an absolute path')
  return path.normalize(value)
}
