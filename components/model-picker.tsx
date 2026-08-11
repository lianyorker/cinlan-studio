'use client'

import { useI18n } from '@/lib/i18n'
import { creditRate } from '@/lib/catalog'
import { isLocalModel } from '@/lib/local/model'
import { useStudio } from '@/lib/studio'
import { ModelThumb } from './model-visual'
import type { Model } from '@/lib/types'

export function ModelPicker({
  open,
  models,
  current,
  onPick,
  onClose,
}: {
  open: boolean
  models: Model[]
  current: string
  onPick: (m: Model) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const { localState } = useStudio()
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <div className="absolute inset-0 bg-neutral-900/40 dark:bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-3xl max-h-[80vh] overflow-y-auto rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 shadow-2xl fade-up">
        <h2 className="mb-4 text-base font-bold tracking-tight">{t.modelPicker.title}</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {models.map((m) => {
            const soon = m.is_coming_soon
            const r = creditRate(m)
            const active = m.slug === current
            const local = isLocalModel(m)
            const localReady = localState.status === 'ready'
            const localHint =
              localState.status === 'checking'
                ? t.local.checking
                : localReady
                  ? t.local.ready
                  : t.local.setupNeeded
            return (
              <button
                key={m.slug}
                disabled={soon}
                onClick={() => {
                  onPick(m)
                  onClose()
                }}
                className={`text-left rounded-xl border overflow-hidden transition disabled:opacity-50 ${
                  active
                    ? 'border-neutral-900 dark:border-white ring-1 ring-neutral-900 dark:ring-white'
                    : 'border-neutral-200 dark:border-neutral-800 hover:border-neutral-300 dark:hover:border-neutral-700'
                }`}
              >
                <div className="relative">
                  <ModelThumb model={m} className="aspect-[4/3]" />
                  {local && (
                    <span className="absolute top-2 right-2 rounded-md bg-neutral-900/85 dark:bg-white/90 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-white dark:text-neutral-900 shadow-sm backdrop-blur">
                      {t.local.badge}
                    </span>
                  )}
                </div>
                <div className="p-2.5">
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-sm font-semibold truncate">{m.name}</span>
                    {local ? (
                      <span className="shrink-0 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                        {t.local.free}
                      </span>
                    ) : r != null && (
                      <span className="shrink-0 text-[11px] font-mono text-neutral-400">
                        {r.perSecond ? `${r.rate}/s` : `${r.rate}cr`}
                      </span>
                    )}
                  </div>
                  {local ? (
                    <div
                      className={`mt-0.5 flex items-center gap-1.5 text-xs font-medium ${
                        localReady
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-amber-600 dark:text-amber-400'
                      }`}
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-current" />
                      <span className="truncate">{localHint}</span>
                    </div>
                  ) : (
                    <div className="text-xs text-neutral-400 truncate">
                      {t.hub.by} {m.creator}
                    </div>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
