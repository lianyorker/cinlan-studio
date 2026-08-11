'use client'

import { useState } from 'react'
import { LOCALES, useI18n, type Locale } from '@/lib/i18n'
import { IconGlobe, IconCheck, IconChevronDown } from './icons'

export function LanguageSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const { locale, setLocale, t } = useI18n()
  const [open, setOpen] = useState(false)

  return (
    <div className="relative w-full">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={t.top.switchLanguage.replace('{language}', LOCALES[locale])}
        title={collapsed ? LOCALES[locale] : undefined}
        className={`nav-item group w-full ${collapsed ? 'justify-center px-2' : ''}`}
      >
        <IconGlobe className="w-[18px] h-[18px]" />
        <span className={collapsed ? 'sr-only' : 'flex-1 text-left'}>{LOCALES[locale]}</span>
        {!collapsed && <IconChevronDown className="w-4 h-4 opacity-50" />}
        {collapsed && <span className="pointer-events-none absolute left-[58px] z-50 hidden whitespace-nowrap rounded-md bg-neutral-900 px-2.5 py-1.5 text-xs font-medium text-white shadow-lg group-hover:block dark:bg-white dark:text-neutral-900">{LOCALES[locale]}</span>}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className={`absolute bottom-full z-20 mb-2 min-w-40 rounded-md border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-800 dark:bg-neutral-900 ${collapsed ? 'left-12' : 'inset-x-0'}`}>
            {(Object.keys(LOCALES) as Locale[]).map((l) => (
              <button
                key={l}
                onClick={() => {
                  setLocale(l)
                  setOpen(false)
                }}
                className="flex h-9 w-full items-center justify-between rounded px-3 text-sm transition hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                {LOCALES[l]}
                {l === locale && <IconCheck className="w-4 h-4" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
