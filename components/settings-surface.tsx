'use client'

import { useTheme, type Theme } from '@/lib/theme'
import { useStudio } from '@/lib/studio'
import { useI18n } from '@/lib/i18n'
import { IconMonitor, IconMoon, IconSun } from './icons'

export function SettingsSurface({ onOpenConnect }: { onOpenConnect: () => void }) {
  const { theme, setTheme } = useTheme()
  const { connected, me } = useStudio()
  const { t } = useI18n()
  const choices: { id: Theme; label: string; hint: string; icon: React.ReactNode }[] = [
    { id: 'light', label: t.settings.light, hint: t.settings.lightHint, icon: <IconSun className="h-4 w-4" /> },
    { id: 'dark', label: t.settings.dark, hint: t.settings.darkHint, icon: <IconMoon className="h-4 w-4" /> },
    { id: 'system', label: t.settings.system, hint: t.settings.systemHint, icon: <IconMonitor className="h-4 w-4" /> },
  ]
  return <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6"><p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-neutral-400">Cinlan Studio</p><h2 className="mt-2 text-3xl font-semibold tracking-[-0.05em]">{t.settings.title}</h2><div className="mt-8 space-y-5"><section className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900"><h3 className="text-sm font-semibold">{t.settings.appearance}</h3><p className="mt-1 text-xs text-neutral-400">{t.settings.appearanceHint}</p><div className="mt-4 grid gap-2 sm:grid-cols-3">{choices.map((choice) => <button type="button" key={choice.id} onClick={() => setTheme(choice.id)} className={`flex flex-col gap-3 rounded-xl border p-3 text-left transition ${theme === choice.id ? 'border-neutral-900 bg-neutral-50 dark:border-white dark:bg-neutral-800' : 'border-neutral-200 hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600'}`}><span className="grid h-8 w-8 place-items-center rounded-lg bg-neutral-100 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-100">{choice.icon}</span><span className="text-sm font-medium">{choice.label}</span><span className="text-xs text-neutral-400">{choice.hint}</span></button>)}</div></section><section className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900"><h3 className="text-sm font-semibold">{t.settings.account}</h3><p className="mt-1 text-xs text-neutral-400">{t.settings.accountHint}</p><div className="mt-4 flex items-center justify-between gap-4 rounded-xl bg-neutral-50 px-4 py-3 dark:bg-neutral-950"><div className="min-w-0"><div className="truncate text-sm font-medium">{connected ? (me?.email || t.settings.connected) : t.settings.notConnected}</div><div className="mt-1 text-xs text-neutral-400">{connected && me ? `${t.settings.balance} ${me.credits ?? '?'}` : t.settings.loginToGenerate}</div></div><button type="button" onClick={onOpenConnect} className="shrink-0 rounded-lg bg-neutral-900 px-3 py-2 text-xs font-semibold text-white dark:bg-white dark:text-neutral-900">{connected ? t.settings.manageAccount : t.settings.loginAccount}</button></div></section></div></div>
}
