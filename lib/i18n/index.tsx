'use client'

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { en, type Dict } from './en'
import { ko } from './ko'
import { ja } from './ja'
import { zh } from './zh'

export const LOCALES = { en: 'English', ko: '한국어', ja: '日本語', zh: '中文' } as const
export type Locale = keyof typeof LOCALES

const DICTS: Record<Locale, Dict> = { en, ko: ko as Dict, ja: ja as Dict, zh }
Object.assign(zh.history, {
  backgroundRemovalInProgress: '正在移除背景',
  savingToCreative: '正在保存到 Creative Core',
  quotaRemaining: '今日剩余 {remaining}/{limit} 次',
  quotaExhausted: '今日额度已用完，请明日再试',
  backgroundRemovalSourceRequired: '无法自动保存此作品到 Creative Core，请稍后重试。',
})
Object.assign(ja.history, {
  backgroundRemovalInProgress: '背景を削除中',
  savingToCreative: 'Creative Core に保存中',
  quotaRemaining: '本日の残り {remaining}/{limit} 回',
  quotaExhausted: '本日の利用上限に達しました。明日もう一度お試しください。',
  backgroundRemovalSourceRequired: '背景を削除するには、まず Creative Core に作品を保存してください。',
})
Object.assign(ko.history, {
  backgroundRemovalInProgress: '배경 제거 중',
  savingToCreative: 'Creative Core에 저장 중',
  quotaRemaining: '오늘 남은 횟수 {remaining}/{limit}',
  quotaExhausted: '오늘 사용 한도에 도달했습니다. 내일 다시 시도해 주세요.',
  backgroundRemovalSourceRequired: '배경을 제거하려면 먼저 Creative Core에 작품을 저장하세요.',
})
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
