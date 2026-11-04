import type { DictationBridge, EdgeWidgetBridge, RememberBridge } from '@remember/shared'

declare global {
  interface Window {
    remember: RememberBridge
    rememberWidget?: EdgeWidgetBridge
    rememberDictation?: DictationBridge
  }
}
