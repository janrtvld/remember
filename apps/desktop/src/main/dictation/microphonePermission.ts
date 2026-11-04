type MicrophonePermissions = {
  getMediaAccessStatus: (mediaType: 'microphone') => string
  askForMediaAccess: (mediaType: 'microphone') => Promise<boolean>
}

export async function ensureMicrophoneAccess(permissions: MicrophonePermissions) {
  const status = permissions.getMediaAccessStatus('microphone')
  if (status === 'granted') return true
  if (status !== 'not-determined') return false
  return permissions.askForMediaAccess('microphone')
}
