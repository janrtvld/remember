type AudioDevice = { kind: string; deviceId: string; groupId: string; label: string }
const builtIn = /\b(macbook|imac|mac pro|mac mini|mac studio|studio display|built-in|internal|ingebouwd|interne)\b/i

/** Keep an active track fixed; otherwise prefer the built-in input, then the actual default. */
export function selectSharedMicrophone<T extends AudioDevice>(
  devices: readonly T[],
  activeTrack: { deviceId?: string } | null = null
): { microphone: T | null; defaultSelected: boolean } {
  const audioInputs = devices.filter((device) => device.kind === 'audioinput')
  const inputs = audioInputs.filter((device) => !['default', 'communications'].includes(device.deviceId))
  const defaultDevice = audioInputs.find((device) => device.deviceId === 'default')
  const selected = activeTrack
    ? audioInputs.find((device) => device.deviceId === activeTrack.deviceId)
    : (inputs.find((device) => builtIn.test(device.label)) ??
      inputs.find((device) => device.groupId && device.groupId === defaultDevice?.groupId) ??
      defaultDevice ??
      inputs[0])
  if (activeTrack && !selected) throw new Error('Microphone disconnected')
  return {
    microphone: selected ?? null,
    defaultSelected: Boolean(
      selected &&
        (selected.deviceId === 'default' ||
          (selected.groupId && selected.groupId === defaultDevice?.groupId) ||
          inputs.length === 1)
    ),
  }
}
