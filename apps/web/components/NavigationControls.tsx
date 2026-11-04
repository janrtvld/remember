'use client'

import { useI18n } from '@internal/locales'
import { IconButton } from '@internal/ui/IconButton'
import { ChevronLeft as IconChevronLeft, ChevronRight as IconChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'

type NavigationState = {
  canGoBack: boolean
  canGoForward: boolean
}

type BrowserNavigation = EventTarget & NavigationState

const initialNavigationState: NavigationState = {
  canGoBack: false,
  canGoForward: false,
}

export function NavigationControls({ onToggleSidebar }: { isSidebarOpen: boolean; onToggleSidebar: () => void }) {
  const { t } = useI18n()
  const [navigation, setNavigation] = useState(initialNavigationState)

  useEffect(() => {
    const browserNavigation = getBrowserNavigation()
    if (!browserNavigation) return

    let refreshFrame: number | undefined

    const refreshNavigation = () => {
      refreshFrame = undefined
      const nextNavigation = {
        canGoBack: browserNavigation.canGoBack,
        canGoForward: browserNavigation.canGoForward,
      }

      setNavigation((currentNavigation) =>
        currentNavigation.canGoBack === nextNavigation.canGoBack &&
        currentNavigation.canGoForward === nextNavigation.canGoForward
          ? currentNavigation
          : nextNavigation
      )
    }

    const scheduleNavigationRefresh = () => {
      if (refreshFrame !== undefined) return
      refreshFrame = window.requestAnimationFrame(refreshNavigation)
    }

    refreshNavigation()
    browserNavigation.addEventListener('currententrychange', scheduleNavigationRefresh)
    const settledRefresh = window.setTimeout(scheduleNavigationRefresh, 250)
    return () => {
      window.clearTimeout(settledRefresh)
      if (refreshFrame !== undefined) window.cancelAnimationFrame(refreshFrame)
      browserNavigation.removeEventListener('currententrychange', scheduleNavigationRefresh)
    }
  }, [])

  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return

      if (isEditableTarget(event.target)) return

      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'b') {
        event.preventDefault()
        onToggleSidebar()
        return
      }

      const isBackShortcut = (event.metaKey && event.key === '[') || (event.altKey && event.key === 'ArrowLeft')
      if (isBackShortcut) {
        event.preventDefault()
        goBack()
        return
      }

      const isForwardShortcut = (event.metaKey && event.key === ']') || (event.altKey && event.key === 'ArrowRight')
      if (isForwardShortcut) {
        event.preventDefault()
        goForward()
      }
    }

    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [onToggleSidebar])

  return (
    <div className="app-no-drag absolute gap-0.5 top-0 left-0 z-50 mt-[3px] flex h-9 items-center pl-[82px]">
      <IconButton
        onClick={goBack}
        className={`${navigation.canGoBack ? 'text-slate-500' : 'text-slate-300'}`}
        aria-label={t('Ga terug')}
        aria-keyshortcuts="Meta+[ Alt+ArrowLeft"
        title={t('Ga terug (⌘[)')}
        size="compact"
        disabled={!navigation.canGoBack}
      >
        <IconChevronLeft className="size-3.5" aria-hidden="true" />
      </IconButton>
      <IconButton
        onClick={goForward}
        className={`app-no-drag ${navigation.canGoForward ? 'text-slate-500' : 'text-slate-300'}`}
        aria-label={t('Ga vooruit')}
        aria-keyshortcuts="Meta+] Alt+ArrowRight"
        title={t('Ga vooruit (⌘])')}
        size="compact"
        disabled={!navigation.canGoForward}
      >
        <IconChevronRight className="size-3.5" aria-hidden="true" />
      </IconButton>
    </div>
  )
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

function getBrowserNavigation() {
  return (window as Window & { navigation?: BrowserNavigation }).navigation
}

function goBack() {
  if (requestHistoryNavigation(-1)) window.history.back()
}

function goForward() {
  if (requestHistoryNavigation(1)) window.history.forward()
}

function requestHistoryNavigation(delta: -1 | 1) {
  return window.dispatchEvent(
    new CustomEvent('remember:history-navigation', {
      cancelable: true,
      detail: { delta },
    })
  )
}
