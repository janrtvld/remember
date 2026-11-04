import type { RememberBridge } from '@remember/shared'
import { createBrowserBridge, createOnboardingPreviewBridge } from './browserBridge'

let onboardingPreviewBridge: RememberBridge | null = null

export function getRememberBridge(): RememberBridge {
  if (typeof window === 'undefined') throw new Error('The Remember bridge is only available in the renderer.')
  if (process.env.NODE_ENV === 'development' && new URLSearchParams(window.location.search).has('preview-onboarding')) {
    onboardingPreviewBridge ??= createOnboardingPreviewBridge(window.remember ?? createBrowserBridge())
    window.remember = onboardingPreviewBridge
    return onboardingPreviewBridge
  }
  if (window.remember) return window.remember
  if (process.env.NODE_ENV !== 'development') {
    throw new Error('The native Remember bridge is unavailable outside development.')
  }
  window.remember = createBrowserBridge()
  return window.remember
}
