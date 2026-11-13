let running = false

export function isContextImportRunning() {
  return running
}

export function setContextImportRunning(value: boolean) {
  running = value
}
