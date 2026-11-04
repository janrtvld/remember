'use client'

import { Check as CheckIcon, ChevronDown as ChevronDownIcon, Languages as IconTranslate } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState, useTransition } from 'react'
import { changeSiteLocale } from '../app/actions'
import type { SiteLocale } from '../lib/locale-shared'

const locales = [
  { id: 'en' as const, name: 'English' },
  { id: 'nl' as const, name: 'Nederlands' },
]

export function LanguageSwitcher({ locale }: { locale: SiteLocale }) {
  const [pending, startTransition] = useTransition()
  const [failed, setFailed] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const openingIndex = useRef(0)
  const triggerId = useId()
  const menuId = useId()
  const [open, setOpen] = useState(false)
  const selectedLocale = locales.find((option) => option.id === locale) ?? locales[0]
  const closeMenu = useCallback(() => {
    setOpen(false)
    triggerRef.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    if (!open) return
    itemRefs.current[openingIndex.current]?.focus({ preventScroll: true })
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu()
    }
    document.addEventListener('pointerdown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open, closeMenu])

  function openMenu(index: number) {
    openingIndex.current = index
    setOpen(true)
  }

  const changeLocale = (nextLocale: SiteLocale) => {
    if (pending) return
    if (nextLocale === locale) {
      closeMenu()
      return
    }
    setFailed(false)
    startTransition(async () => {
      try {
        await changeSiteLocale(nextLocale)
        if (rootRef.current?.contains(document.activeElement)) closeMenu()
        else setOpen(false)
      } catch {
        setFailed(true)
      }
    })
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        aria-haspopup="menu"
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        onClick={() => (open ? closeMenu() : openMenu(locales.findIndex((option) => option.id === locale)))}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          openMenu(event.key === 'ArrowDown' ? 0 : locales.length - 1)
        }}
        className="relative flex items-center gap-2 rounded-lg border border-slate-200 bg-transparent px-2.5 py-1.5 text-sm text-slate-700 outline-none transition-colors before:absolute before:inset-x-0 before:-inset-y-[5px] hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-slate-500 data-[open=true]:bg-slate-100"
        data-open={open}
      >
        <IconTranslate className="size-4 shrink-0" aria-hidden="true" />
        <span className="font-medium">{selectedLocale.name}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 text-slate-500" aria-hidden="true" />
      </button>

      {failed ? (
        <p role="alert" className="mt-2 text-sm text-danger-700">
          {locale === 'nl' ? 'Taal wijzigen mislukt. Probeer opnieuw.' : 'Could not change language. Try again.'}
        </p>
      ) : null}
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-labelledby={triggerId}
          onKeyDown={(event) => {
            if (event.key === 'Tab') {
              closeMenu()
              return
            }
            const current = itemRefs.current.indexOf(document.activeElement as HTMLButtonElement)
            let next = current
            if (event.key === 'ArrowDown') next = (current + 1) % locales.length
            else if (event.key === 'ArrowUp') next = (current - 1 + locales.length) % locales.length
            else if (event.key === 'Home') next = 0
            else if (event.key === 'End') next = locales.length - 1
            else if (event.key.length === 1) {
              const match = locales.findIndex((option) => option.name.toLowerCase().startsWith(event.key.toLowerCase()))
              if (match < 0) return
              next = match
            } else return
            event.preventDefault()
            itemRefs.current[next]?.focus({ preventScroll: true })
          }}
          className="absolute right-0 bottom-full z-50 mb-1.5 w-48 origin-bottom-right rounded-xl border border-slate-200 bg-white p-1 shadow-md outline-none"
        >
          {locales.map((option, index) => {
            const selected = option.id === locale
            return (
              <button
                key={option.id}
                ref={(element) => {
                  itemRefs.current[index] = element
                }}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                aria-disabled={pending}
                tabIndex={-1}
                onClick={() => void changeLocale(option.id)}
                className="flex font-medium w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm text-slate-700 outline-none transition-colors hover:bg-slate-50 focus-visible:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-slate-500 pointer-coarse:min-h-11"
              >
                <span>{option.name}</span>
                {selected ? <CheckIcon className="size-4 shrink-0 text-slate-400" aria-hidden="true" /> : null}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
