'use client'

import { createPortal } from 'react-dom'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { IconCheck, IconChevronDown } from './icons'

type MenuPosition = {
  top: number
  left: number
  width: number
  maxHeight: number
}

export function ComposerSelect({
  value,
  options,
  getLabel,
  onChange,
  disabled = false,
  ariaLabel,
}: {
  value: string
  options: string[]
  getLabel: (value: string) => string
  onChange: (value: string) => void
  disabled?: boolean
  ariaLabel: string
}) {
  const [open, setOpen] = useState(false)
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    const closeOnOutside = (event: PointerEvent) => {
      const target = event.target as Node
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', closeOnOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open) {
      setMenuPosition(null)
      return
    }

    const updatePosition = () => {
      const trigger = triggerRef.current
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      const viewportPadding = 12
      const gap = 8
      const preferredHeight = Math.min(options.length * 32 + 8, 288)
      const spaceAbove = rect.top - viewportPadding - gap
      const spaceBelow = window.innerHeight - rect.bottom - viewportPadding - gap
      const openAbove = spaceAbove >= preferredHeight || spaceAbove >= spaceBelow
      const maxHeight = Math.max(0, Math.min(preferredHeight, openAbove ? spaceAbove : spaceBelow))
      const width = Math.max(rect.width, 176)
      const left = Math.min(
        Math.max(viewportPadding, rect.right - width),
        Math.max(viewportPadding, window.innerWidth - viewportPadding - width)
      )
      const top = openAbove
        ? Math.max(viewportPadding, rect.top - gap - maxHeight)
        : rect.bottom + gap

      setMenuPosition({ top, left, width, maxHeight })
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open, options.length])

  function toggle() {
    if (!disabled) setOpen((current) => !current)
  }

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-state={open ? 'open' : 'closed'}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setOpen(true)
          }
        }}
        className="composer-control"
      >
        <span className="max-w-44 truncate">{getLabel(value)}</span>
        <IconChevronDown className={`h-3 w-3 shrink-0 text-neutral-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && menuPosition && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          role="listbox"
          aria-label={ariaLabel}
          data-testid="composer-select-menu"
          className="fixed z-[80] overflow-y-auto rounded-xl border border-neutral-200/90 bg-white p-1 shadow-[0_16px_40px_rgba(0,0,0,0.14)] dark:border-neutral-800 dark:bg-neutral-900"
          style={{ top: menuPosition.top, left: menuPosition.left, width: menuPosition.width, maxHeight: menuPosition.maxHeight }}
        >
          {options.map((option) => {
            const selected = option === value
            return (
              <button
                key={option}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange(option)
                  setOpen(false)
                  requestAnimationFrame(() => triggerRef.current?.focus())
                }}
                className={`flex min-h-8 w-full items-center gap-2 whitespace-nowrap rounded-lg px-2.5 text-left text-xs font-medium transition-colors ${
                  selected
                    ? 'bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-white'
                    : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-white'
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{getLabel(option)}</span>
                {selected && <IconCheck className="h-3.5 w-3.5 shrink-0 text-neutral-500 dark:text-neutral-300" />}
              </button>
            )
          })}
        </div>,
        document.body
      )}
    </div>
  )
}
