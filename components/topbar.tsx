'use client'

import { useI18n } from '@/lib/i18n'
import { useStudio } from '@/lib/studio'
import { IconCoins, IconMenu, IconPanelLeft } from './icons'

export function TopBar({ title, collapsed, onToggleSidebar, onOpenMobile, onOpenConnect }: { title: string; collapsed: boolean; onToggleSidebar: () => void; onOpenMobile: () => void; onOpenConnect: () => void }) {
  const { t } = useI18n()
  const { me, connected } = useStudio()
  return <header className="z-10 flex h-[72px] shrink-0 items-center justify-between gap-4 border-b border-neutral-200/90 bg-white px-4 sm:px-6 dark:border-neutral-800/80 dark:bg-neutral-950/95">
    <div className="flex min-w-0 items-center gap-2">
      <button type="button" onClick={onOpenMobile} aria-label={t.top.openSidebar} className="icon-btn md:hidden"><IconMenu className="h-5 w-5" /></button>
      <button type="button" onClick={onToggleSidebar} aria-label={collapsed ? t.top.expandSidebar : t.top.collapseSidebar} title={collapsed ? t.top.expandSidebar : t.top.collapseSidebar} className="icon-btn hidden md:grid">
        <IconPanelLeft className={`h-[18px] w-[18px] transition-transform ${collapsed ? 'rotate-180' : ''}`} />
      </button>
      <h1 className="truncate text-[15px] font-semibold tracking-[-0.01em]">{title}</h1>
    </div>
    <div className="flex items-center gap-2">
      <button onClick={onOpenConnect} className="flex items-center gap-2 rounded-full border border-neutral-200 bg-white px-3 py-2 transition hover:border-neutral-300 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-neutral-700"><IconCoins className="h-4 w-4 text-neutral-500" /><span className="text-sm font-semibold tabular-nums">{connected && me ? (me.credits ?? '—') : '—'}</span><span className="hidden text-xs text-neutral-400 sm:inline">{t.top.credits}</span></button>
      <button onClick={onOpenConnect} aria-label={t.top.account} className="grid h-9 w-9 place-items-center rounded-full bg-neutral-900 text-xs font-bold text-white ring-1 ring-black/5 dark:bg-white dark:text-neutral-900 dark:ring-white/10">{connected && me?.email ? me.email[0].toUpperCase() : 'U'}</button>
    </div>
  </header>
}
