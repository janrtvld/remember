'use client'

import { dropdownDangerItemStyle, dropdownItemStyle } from '@internal/ui/Dropdown'
import {
  type HTMLAttributes,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { twMerge } from 'tailwind-merge'

export type ListContextAction = { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean }

type TriggerProps<Element extends HTMLElement> = Pick<
  HTMLAttributes<Element>,
  | 'aria-haspopup'
  | 'aria-expanded'
  | 'aria-controls'
  | 'onContextMenu'
  | 'onKeyDown'
  | 'onPointerDown'
  | 'onPointerMove'
  | 'onPointerUp'
  | 'onPointerCancel'
  | 'onClickCapture'
> & { ref: Ref<Element> }

export function ListContextMenu<Element extends HTMLElement = HTMLAnchorElement>({
  children,
  label,
  actions,
  onOpen,
}: {
  children: (props: TriggerProps<Element>) => ReactNode
  label: string
  actions: ListContextAction[]
  onOpen?: () => void
}) {
  const id = useId()
  const triggerRef = useRef<Element>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null)
  const suppressClick = useRef(false)
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null)
  const cancelPress = useCallback(() => {
    if (press.current) clearTimeout(press.current.timer)
    press.current = null
  }, [])
  const close = useCallback(() => {
    setPoint(null)
    triggerRef.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => cancelPress, [cancelPress])
  useLayoutEffect(() => {
    if (!point || !menuRef.current) return
    const menu = menuRef.current
    menu.style.left = `${Math.max(8, Math.min(point.x, window.innerWidth - menu.offsetWidth - 8))}px`
    menu.style.top = `${Math.max(8, Math.min(point.y, window.innerHeight - menu.offsetHeight - 8))}px`
    ;(menu.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? menu).focus({ preventScroll: true })
  }, [point])
  useEffect(() => {
    if (!point) return
    const outside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) close()
    }
    const scroll = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) close()
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('scroll', scroll, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('scroll', scroll, true)
      window.removeEventListener('resize', close)
    }
  }, [point, close])

  return (
    <>
      {children({
        ref: triggerRef,
        'aria-haspopup': 'menu',
        'aria-expanded': Boolean(point),
        'aria-controls': point ? id : undefined,
        onContextMenu: (event) => {
          event.preventDefault()
          cancelPress()
          onOpen?.()
          setPoint({ x: event.clientX, y: event.clientY })
        },
        onKeyDown: (event) => {
          if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
          event.preventDefault()
          onOpen?.()
          const bounds = event.currentTarget.getBoundingClientRect()
          setPoint({ x: bounds.left, y: bounds.bottom + 4 })
        },
        onPointerDown: (event) => {
          suppressClick.current = false
          cancelPress()
          if (event.pointerType !== 'touch') return
          const { clientX: x, clientY: y } = event
          press.current = {
            x,
            y,
            timer: setTimeout(() => {
              suppressClick.current = true
              onOpen?.()
              setPoint({ x, y })
            }, 500),
          }
        },
        onPointerMove: (event) => {
          if (press.current && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 8)
            cancelPress()
        },
        onPointerUp: cancelPress,
        onPointerCancel: cancelPress,
        onClickCapture: (event) => {
          if (!suppressClick.current) return
          event.preventDefault()
          event.stopPropagation()
          suppressClick.current = false
        },
      })}
      {point
        ? createPortal(
            <div
              ref={menuRef}
              id={id}
              role="menu"
              aria-label={label}
              tabIndex={-1}
              className="fixed z-50 w-max min-w-52 max-w-[calc(100vw-16px)] rounded-xl bg-white p-1 shadow-raised outline-none"
              style={{ left: point.x, top: point.y }}
              onKeyDown={(event) => {
                if (event.key === 'Escape' || event.key === 'Tab') {
                  event.preventDefault()
                  close()
                  return
                }
                if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
                event.preventDefault()
                const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
                const current = items.indexOf(document.activeElement as HTMLButtonElement)
                const next =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? items.length - 1
                      : current + (event.key === 'ArrowDown' ? 1 : -1)
                items[(next + items.length) % items.length]?.focus()
              }}
            >
              {actions.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  disabled={action.disabled}
                  className={twMerge(
                    action.danger ? dropdownDangerItemStyle : dropdownItemStyle,
                    'h-auto min-h-8 touch-manipulation py-1.5 disabled:cursor-default disabled:opacity-50 [@media(pointer:coarse)]:h-11',
                    action.danger
                      ? 'focus:bg-danger-100 focus:text-danger-700'
                      : 'focus:bg-slate-100 focus:text-slate-900'
                  )}
                  onClick={() => {
                    close()
                    action.onSelect()
                  }}
                >
                  {action.label}
                </button>
              ))}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
