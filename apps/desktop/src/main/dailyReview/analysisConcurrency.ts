export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  transform: (item: T, index: number) => Promise<R>
) {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  let failed = false
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failed && nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      try {
        results[index] = await transform(items[index] as T, index)
      } catch (error) {
        failed = true
        throw error
      }
    }
  })
  // Promise.all reports the first failure while still observing every running worker's rejection.
  await Promise.all(workers)
  return results
}
