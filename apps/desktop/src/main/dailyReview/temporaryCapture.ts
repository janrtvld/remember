export async function consumeTemporaryCaptureFile<T>(
  path: string,
  remove: (path: string) => void,
  operation: () => Promise<T>
) {
  try {
    return await operation()
  } finally {
    remove(path)
  }
}
