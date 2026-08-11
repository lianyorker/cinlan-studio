'use client'

import { useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { useStudio } from '@/lib/studio'

const INSTALL_COMMAND = 'bash ./scripts/local/install.sh'

export function LocalFunnel({ onUseCloud }: { onUseCloud: () => void }) {
  const { t } = useI18n()
  const { localState, refreshLocal } = useStudio()
  const [copied, setCopied] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  async function copyCommand() {
    try {
      let didCopy = false
      if (navigator.clipboard) {
        try {
          await navigator.clipboard.writeText(INSTALL_COMMAND)
          didCopy = true
        } catch {
          // Fall back for non-secure self-hosted origins.
        }
      }
      if (!didCopy) {
        const input = document.createElement('textarea')
        input.value = INSTALL_COMMAND
        input.style.position = 'fixed'
        input.style.opacity = '0'
        document.body.appendChild(input)
        input.select()
        didCopy = document.execCommand('copy')
        input.remove()
        if (!didCopy) throw new Error('Copy failed')
      }
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setCopied(false)
    }
  }

  async function refresh() {
    setRefreshing(true)
    try {
      await refreshLocal()
    } finally {
      setRefreshing(false)
    }
  }

  if (localState.status === 'checking') {
    return (
      <div className="h-full grid place-items-center px-6">
        <div className="flex flex-col items-center gap-3 text-neutral-500">
          <span className="w-6 h-6 rounded-full border-2 border-current border-t-transparent animate-spin" />
          <span className="text-sm font-medium">{t.local.checking}…</span>
        </div>
      </div>
    )
  }

  if (localState.status === 'ready') return null

  const insufficient = localState.status === 'insufficient'
  const modelMissing = localState.status === 'model_missing'
  const unlikely = localState.status === 'offline' && localState.hint === 'unlikely'
  const title = insufficient
    ? t.local.insufficientTitle
    : modelMissing
      ? t.local.modelMissingTitle
      : unlikely
        ? t.local.unlikelyTitle
        : t.local.setupTitle
  const description = insufficient
    ? t.local.insufficientDesc
    : modelMissing
      ? t.local.modelMissingDesc
      : unlikely
        ? t.local.unlikelyDesc
        : t.local.setupDesc
  const system = localState.system
  const systemSummary = [system?.gpuName, system?.vramGB != null ? `${system.vramGB} GB` : null]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="h-full overflow-y-auto px-6 py-10 grid place-items-center">
      <div className="w-full max-w-xl rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-6 sm:p-8 shadow-sm fade-up">
        <div className="inline-flex items-center gap-2 rounded-full border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-950/50 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-neutral-600 dark:text-neutral-300">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
          {t.local.badge} · {t.local.free}
        </div>
        <h2 className="mt-5 text-2xl font-bold tracking-tight">{title}</h2>
        <p className="mt-2 text-sm leading-6 text-neutral-500">{description}</p>

        {systemSummary && (
          <div className="mt-4 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950/50 px-4 py-3 font-mono text-xs text-neutral-500">
            {systemSummary}
          </div>
        )}

        {!insufficient && (
          <div className="mt-6">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
              {t.local.installLabel}
            </div>
            <button
              type="button"
              onClick={copyCommand}
              className="group w-full flex items-center gap-3 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-950/60 p-3 text-left hover:border-neutral-300 dark:hover:border-neutral-600 transition"
            >
              <code className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-neutral-600 dark:text-neutral-300">
                {INSTALL_COMMAND}
              </code>
              <span className="shrink-0 rounded-lg bg-neutral-900 dark:bg-white px-2.5 py-1.5 text-[11px] font-semibold text-white dark:text-neutral-900">
                {copied ? t.local.copied : t.local.copy}
              </span>
            </button>
            {/* 다운로드 기대치 관리 — 12GB 앞에서 망설이면 아래 클라우드 버튼이 받는다 */}
            <p className="mt-2 text-xs text-neutral-400">{t.local.installSizeNote}</p>
          </div>
        )}

        <div className="mt-6 flex flex-col-reverse sm:flex-row gap-2">
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            className="flex-1 flex items-center justify-center gap-2 rounded-xl border border-neutral-200 dark:border-neutral-700 px-4 py-3 text-sm font-semibold hover:bg-neutral-50 dark:hover:bg-neutral-800/60 disabled:opacity-50 transition"
          >
            {refreshing && (
              <span className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
            )}
            {t.local.refresh}
          </button>
          <button type="button" onClick={onUseCloud} className="primary-btn flex-1 px-4 py-3">
            {t.local.useCloud}
          </button>
        </div>
        <p className="mt-3 text-center text-xs text-neutral-400">{t.local.cloudBenefit}</p>
      </div>
    </div>
  )
}
