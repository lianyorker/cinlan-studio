'use client'

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { en, type Dict } from './en'
import { ko } from './ko'
import { ja } from './ja'
import { zh } from './zh'

export const LOCALES = { en: 'English', ko: '한국어', ja: '日本語', zh: '中文' } as const
export type Locale = keyof typeof LOCALES

const DICTS: Record<Locale, Dict> = { en, ko: ko as Dict, ja: ja as Dict, zh }
const DEFAULT_LOCALE: Locale = 'zh'

const I18nCtx = createContext<{ locale: Locale; setLocale: (l: Locale) => void; t: Dict }>({
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
  t: zh,
})

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE)

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('lang') as Locale | null
    if (requested && requested in DICTS) {
      localStorage.setItem('locale', requested)
      setLocaleState(requested)
      return
    }
    // Chinese is the default face. Honor a previously chosen locale.
    const saved = localStorage.getItem('locale') as Locale | null
    if (saved && saved in DICTS) setLocaleState(saved)
  }, [])

  function setLocale(l: Locale) {
    setLocaleState(l)
    localStorage.setItem('locale', l)
  }

  return (
    <I18nCtx.Provider value={{ locale, setLocale, t: DICTS[locale] }}>{children}</I18nCtx.Provider>
  )
}

export const useI18n = () => useContext(I18nCtx)
