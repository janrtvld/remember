const INPUT_IDLE_THRESHOLD_SECONDS = 5 * 60

/** Screen observations continue while listening; they do not imply active input. */
export function isPassiveContext(event: { appName: string; inputIdleSeconds?: number }): boolean {
  return (
    event.appName === 'Idle' ||
    (typeof event.inputIdleSeconds === 'number' && event.inputIdleSeconds >= INPUT_IDLE_THRESHOLD_SECONDS)
  )
}
