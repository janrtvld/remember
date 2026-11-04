'use client'

import { localeFromLanguageTag, resolveInterfaceLocale } from '@remember/shared'
import { ArrowUp as IconArrowUp } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

const DRAG_PREVIEW_WIDTH = 430
const DRAG_PREVIEW_HEIGHT = 58

function createDragPreview(image: HTMLImageElement) {
  if (!image.complete || image.naturalWidth === 0) return undefined

  const scale = 2
  const canvas = document.createElement('canvas')
  canvas.width = DRAG_PREVIEW_WIDTH * scale
  canvas.height = DRAG_PREVIEW_HEIGHT * scale

  const context = canvas.getContext('2d')
  if (!context) return undefined
  context.scale(scale, scale)

  const rootStyle = getComputedStyle(document.documentElement)
  const themeColor = (name: string, opacity?: number) => {
    const channels = rootStyle.getPropertyValue(name).trim()
    return `oklch(${channels}${opacity == null ? '' : ` / ${opacity}`})`
  }

  context.shadowColor = themeColor('--contrast', 0.18)
  context.shadowBlur = 12
  context.shadowOffsetY = 3
  context.fillStyle = themeColor('--surface')
  context.beginPath()
  context.roundRect(7, 5, DRAG_PREVIEW_WIDTH - 14, DRAG_PREVIEW_HEIGHT - 14, 12)
  context.fill()

  context.shadowColor = 'transparent'
  context.strokeStyle = themeColor('--contrast', 0.1)
  context.lineWidth = 1
  context.stroke()
  context.drawImage(image, 20, 15, 28, 28)

  context.fillStyle = themeColor('--neutral-800')
  context.font = '500 15px system-ui'
  context.textBaseline = 'middle'
  context.fillText('Remember', 62, DRAG_PREVIEW_HEIGHT / 2)

  return canvas.toDataURL('image/png')
}

export default function PermissionOverlayPage() {
  const logoRef = useRef<HTMLImageElement>(null)
  const [locale, setLocale] = useState<'en' | 'nl'>(() =>
    localeFromLanguageTag(typeof navigator === 'undefined' ? undefined : navigator.language)
  )
  const text = (dutch: string, english: string) => (locale === 'nl' ? dutch : english)

  useEffect(() => {
    if (!('remember' in window)) return

    const checkPermission = async () => {
      await window.remember.getAccessibilityPermissionStatus()
    }
    void window.remember.getSettings().then((settings) => {
      setLocale(resolveInterfaceLocale(settings.interfaceLanguage, navigator.language))
    })
    void checkPermission()
    const timer = window.setInterval(() => void checkPermission(), 800)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <main className="permission-guide-root flex h-screen w-screen items-end p-3">
      <section
        aria-label={text(
          'Sleep Remember naar de lijst met toegankelijkheidsapps',
          'Drag Remember to the list of accessibility apps'
        )}
        className="relative flex w-full flex-col items-center rounded-[22px] border border-black/10 bg-white/95 px-3 pt-4 pb-3 shadow-hard backdrop-blur-xl"
      >
        <IconArrowUp aria-hidden="true" className="size-8 text-sky-500" />
        <h1 className="mt-1 text-center font-medium text-sky-500 text-sm">
          {text('Sleep deze rij omhoog naar de lijst', 'Drag this row up to the list')}
        </h1>
        <div className="mt-3 w-full rounded-[18px] border-2 border-sky-500 border-dashed p-2">
          <div
            draggable
            onDragStart={(event) => {
              event.preventDefault()
              window.remember.startPermissionGuideDrag(logoRef.current ? createDragPreview(logoRef.current) : undefined)
            }}
            className="flex h-12 w-full cursor-grab select-none items-center gap-3 rounded-[13px] border border-black/10 bg-white px-4 shadow-raised active:cursor-grabbing"
          >
            <img ref={logoRef} draggable={false} src="/logo.svg" alt="" className="size-7" />
            <span className="font-medium text-slate-800 text-sm">Remember</span>
          </div>
        </div>
      </section>
    </main>
  )
}
