'use client'

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

export type Theme = 'light' | 'dark' | 'system'

interface ThemeState {
  theme: Theme
  resolvedTheme: 'light' | 'dark'
  setTheme: (theme: Theme) => void
}

const ThemeCtx = createContext<ThemeState>({ theme: 'light', resolvedTheme: 'light', setTheme: () => {} })

function resolve(theme: Theme) {
  if (theme !== 'system') return theme
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('light')
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('light')

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('theme') as Theme | null
    if (requested === 'light' || requested === 'dark' || requested === 'system') localStorage.setItem('theme', requested)
    const saved = requested ?? (localStorage.getItem('theme') as Theme | null) ?? 'light'
    const next = saved === 'dark' || saved === 'system' ? saved : 'light'
    setThemeState(next)
    setResolvedTheme(resolve(next))
  }, [])

  useEffect(() => {
    const apply = () => {
      const next = resolve(theme)
      document.documentElement.classList.toggle('dark', next === 'dark')
      setResolvedTheme(next)
    }
    apply()
    if (theme !== 'system') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])

  function setTheme(next: Theme) {
    setThemeState(next)
    localStorage.setItem('theme', next)
  }

  return <ThemeCtx.Provider value={{ theme, resolvedTheme, setTheme }}>{children}</ThemeCtx.Provider>
}

export const useTheme = () => useContext(ThemeCtx)

/** Inline, run-before-paint script. Light is the product default. */
export const themeInitScript = `(function(){try{var q=new URLSearchParams(location.search).get('theme');if(q==='light'||q==='dark'||q==='system')localStorage.setItem('theme',q);var t=(q==='light'||q==='dark'||q==='system'?q:localStorage.getItem('theme'))||'light';var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d)}catch(e){}})()`
