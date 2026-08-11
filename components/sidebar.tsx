'use client'

import type { ReactNode } from 'react'
import { Logo } from './logo'
import { IconHistory, IconImage, IconSettings, IconText, IconVideo } from './icons'
import { LanguageSwitcher } from './language-switcher'
import { useI18n } from '@/lib/i18n'

export type Tab = 'image' | 'text' | 'video' | 'history' | 'settings'
type GenerationFeature = 'image' | 'text' | 'video'
const DEFAULT_FEATURES: Record<GenerationFeature, boolean> = { image: true, text: true, video: true }

export function Sidebar({ tab, onTab, collapsed, mobileOpen, onMobileClose, features = DEFAULT_FEATURES }: { tab: Tab; onTab: (t: Tab) => void; collapsed: boolean; mobileOpen: boolean; onMobileClose: () => void; features?: Record<GenerationFeature, boolean> }) {
  const { t } = useI18n()
  const labels: Record<Tab, string> = { image: t.nav.image, text: t.nav.text, video: t.nav.video, history: t.nav.history, settings: t.nav.settings }
  const primary = ([
    { id: 'image', icon: <IconImage className="h-[18px] w-[18px]" /> },
    { id: 'text', icon: <IconText className="h-[18px] w-[18px]" /> },
    { id: 'video', icon: <IconVideo className="h-[18px] w-[18px]" /> },
  ] satisfies { id: GenerationFeature; icon: ReactNode }[]).filter((item) => features[item.id])
  const secondary: { id: Tab; icon: ReactNode }[] = [
    { id: 'history', icon: <IconHistory className="h-[18px] w-[18px]" /> },
    { id: 'settings', icon: <IconSettings className="h-[18px] w-[18px]" /> },
  ]
  const renderItem = ({ id, icon }: { id: Tab; icon: ReactNode }) => (
    <button key={id} type="button" data-active={tab === id} aria-label={labels[id]} title={collapsed ? labels[id] : undefined} onClick={() => { onTab(id); onMobileClose() }} className={`nav-item group ${collapsed ? 'justify-center px-2' : ''}`}>
      {icon}
      <span className={collapsed ? 'sr-only' : ''}>{labels[id]}</span>
      {collapsed && <span className="pointer-events-none absolute left-[58px] z-50 hidden whitespace-nowrap rounded-lg bg-neutral-900 px-2.5 py-1.5 text-xs font-medium text-white shadow-lg group-hover:block dark:bg-white dark:text-neutral-900">{labels[id]}</span>}
    </button>
  )
  return <>
    {mobileOpen && <button type="button" aria-label={t.top.closeSidebar} onClick={onMobileClose} className="fixed inset-0 z-30 bg-neutral-950/30 backdrop-blur-sm md:hidden" />}
    <aside className={`fixed inset-y-0 left-0 z-40 flex shrink-0 flex-col border-r border-neutral-200/90 bg-[#f3f3f3] shadow-xl shadow-neutral-900/[0.04] transition-[width,transform] duration-200 dark:border-neutral-800/80 dark:bg-neutral-950/95 md:relative md:z-auto md:shadow-none ${collapsed ? 'w-[76px]' : 'w-[248px]'} ${mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}>
      <div className={`flex h-[72px] shrink-0 items-center border-b border-neutral-200/80 dark:border-neutral-800/80 ${collapsed ? 'justify-center px-3' : 'gap-3 px-5'}`}>
        <Logo size={collapsed ? 34 : 38} />
        <div className={collapsed ? 'sr-only' : 'min-w-0 leading-tight'}><div className="truncate text-[15px] font-bold tracking-[-0.02em]">Cinlan Studio</div><div className="truncate text-[11px] text-neutral-500">{t.brand.tagline}</div></div>
      </div>
      <nav className={`flex-1 px-3 py-5 ${collapsed ? 'space-y-2' : 'space-y-1'}`}><div className="space-y-1">{primary.map(renderItem)}</div>{primary.length > 0 && <div className="my-5 h-px bg-neutral-200/80 dark:bg-neutral-800/80" />}<div className="space-y-1">{secondary.map(renderItem)}</div></nav>
      <div className="border-t border-neutral-200/80 px-3 py-3 dark:border-neutral-800/80">
        <LanguageSwitcher collapsed={collapsed} />
        {!collapsed && <div className="mt-2 px-3 text-[11px] leading-5 text-neutral-400">{t.brand.workspaceTagline}</div>}
      </div>
    </aside>
  </>
}
