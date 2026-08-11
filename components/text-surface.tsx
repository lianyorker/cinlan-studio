'use client'

import { useEffect, useMemo, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import type { Dict } from '@/lib/i18n/en'
import { api, ApiError } from '@/lib/api'
import { copyToClipboard } from '@/lib/clipboard'
import { saveStudioHistory } from '@/lib/local/studio-history'
import { useStudio } from '@/lib/studio'
import type { Model } from '@/lib/types'
import { IconArrowUp, IconChevronDown, IconCopy, IconSparkle } from './icons'
import { MarkdownContent } from './markdown-content'
import { ModelLogo } from './model-visual'
import { ComposerSelect } from './composer-select'

interface ReasoningField {
  type: string
  options?: string[]
  default?: string
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  const root = value as Record<string, any>
  const choices = Array.isArray(root.choices) ? root.choices : []
  const content = choices[0]?.message?.content ?? choices[0]?.text
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((item) => item?.text || '').join('')
  return root.output_text || root.output || root.text || ''
}

export function TextSurface({ model, onOpenPicker, onNeedConnect }: { model: Model; onOpenPicker: () => void; onNeedConnect: () => void }) {
  const { t } = useI18n()
  const { connected, refreshMe } = useStudio()
  const reasoningField = useMemo(() => {
    const fields = (model.form_config?.fields as ReasoningField[] | undefined) ?? []
    return fields.find((field) => field.type === 'reasoning_effort')
  }, [model.form_config])
  const reasoningOptions = reasoningField?.options ?? []
  const [reasoningEffort, setReasoningEffort] = useState('xhigh')
  const [prompt, setPrompt] = useState('')
  const [result, setResult] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const preferred = reasoningField?.default ?? (reasoningOptions.includes('xhigh') ? 'xhigh' : reasoningOptions[0])
    setReasoningEffort(preferred ?? '')
  }, [model.slug, reasoningField?.default, reasoningOptions.join('|')])

  async function generate() {
    const value = prompt.trim()
    if (!value || busy) return
    if (!connected) return onNeedConnect()
    setBusy(true)
    setError('')
    setCopied(false)
    setPrompt('')
    try {
      const response = await api.generateText({
        model: model.slug,
        prompt: value,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      })
      const text = extractText(response.result) || t.text.noResult
      setResult(text)
      await saveStudioHistory({ id: `text-${Date.now()}`, type: 'text', source: 'cloud', model: model.name, prompt: value, textResult: text, status: 'COMPLETED', createdAt: Date.now() })
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && err.code === 'AUTH_REQUIRED') {
        await refreshMe()
        onNeedConnect()
      } else {
        setError(err instanceof ApiError && err.status === 502 ? t.ws.upstreamUnavailable : err instanceof ApiError ? err.message : t.text.failed)
      }
    } finally {
      setBusy(false)
    }
  }

  async function copyResult() {
    if (!result) return
    const success = await copyToClipboard(result)
    if (!success) return
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1_500)
  }

  return (
    <div className="relative flex h-full min-w-0 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-44 pt-8 sm:px-6 sm:pb-48">
        <div className="mx-auto max-w-4xl">
          <div className="max-w-2xl">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-neutral-400">Cinlan Studio</p>
            <h2 className="mt-2 text-3xl font-semibold">{t.text.title}</h2>
            <p className="mt-2 text-sm leading-6 text-neutral-500">{t.text.subtitle}</p>
          </div>

          <section className="mt-8 min-h-[320px] border-t border-neutral-200 py-6 dark:border-neutral-800">
            <div className="mb-5 flex min-h-8 items-center justify-between gap-3">
              <div className="text-xs font-medium text-neutral-400">{busy ? t.text.generating : result ? model.name : t.text.newText}</div>
              {result && <button type="button" onClick={() => void copyResult()} className="composer-control"><IconCopy className="h-3.5 w-3.5" />{copied ? t.history.copied : t.text.copyResult}</button>}
            </div>
            {busy ? (
              <div role="status" aria-label={t.text.generating} className="space-y-3 animate-pulse">
                {[92, 85, 96, 72, 88, 64].map((width, index) => <div key={index} style={{ width: `${width}%` }} className="h-3 rounded bg-neutral-100 dark:bg-neutral-900" />)}
              </div>
            ) : result ? (
              <article><MarkdownContent value={result} /></article>
            ) : (
              <div className="grid min-h-[250px] place-items-center text-center text-sm text-neutral-400">
                <div><IconSparkle className="mx-auto mb-3 h-6 w-6" /><p>{t.text.empty}</p></div>
              </div>
            )}
          </section>
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 px-3 pb-3 sm:px-4 sm:pb-5">
        {(error || busy) && (
          <div className="pointer-events-auto mx-auto mb-2 flex w-full max-w-5xl justify-center">
            <div
              data-testid="text-notice"
              role={error ? 'alert' : 'status'}
              aria-live="polite"
              className={`flex min-h-8 max-w-full items-center gap-2 rounded-full border px-3 py-1.5 text-xs shadow-sm ${error ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/70 dark:bg-red-950/70 dark:text-red-200' : 'border-neutral-200 bg-white/95 text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900/95 dark:text-neutral-300'}`}
            >
              {busy && <span className="h-3.5 w-3.5 shrink-0 rounded-full border-2 border-current border-t-transparent animate-spin" />}
              <span className="truncate">{error || t.text.generating}</span>
            </div>
          </div>
        )}
        <div className="composer-shell pointer-events-auto mx-auto w-full max-w-5xl">
          <div className="px-4 pt-3">
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value.slice(0, 8000))}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  void generate()
                }
              }}
              rows={3}
              placeholder={t.text.placeholder}
              className="min-h-20 w-full resize-none bg-transparent py-1 text-[15px] leading-6 outline-none placeholder:text-neutral-400"
            />
          </div>
          <div className="flex min-w-0 items-center gap-2 px-3 pb-3 pt-2">
            <div className="min-w-0 flex-1" />
            <div className="flex min-w-0 items-center justify-end gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <button type="button" onClick={onOpenPicker} className="composer-control">
                <ModelLogo model={model} size={16} />
                <span className="max-w-28 truncate sm:max-w-40">{model.name}</span>
                <IconChevronDown className="h-3 w-3 text-neutral-400" />
              </button>
              {reasoningOptions.length > 0 && (
                <div className="relative shrink-0">
                  <ComposerSelect
                    value={reasoningEffort}
                    options={reasoningOptions}
                    disabled={busy}
                    ariaLabel={t.text.reasoning}
                    getLabel={(option) => `${t.text.reasoning} ${reasoningLabel(option, t)}`}
                    onChange={setReasoningEffort}
                  />
                </div>
              )}
            </div>
            <button type="button" onClick={() => void generate()} disabled={busy || !prompt.trim()} title={busy ? t.text.generating : t.ws.generate} aria-label={busy ? t.text.generating : t.ws.generate} className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-neutral-900 text-white transition hover:bg-neutral-700 disabled:cursor-not-allowed disabled:bg-neutral-300 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200 dark:disabled:bg-neutral-700">
              {busy ? <span className="h-4 w-4 rounded-full border-2 border-current border-t-transparent animate-spin" /> : <IconArrowUp className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function reasoningLabel(option: string, t: Dict) {
  const labels: Record<string, string> = { low: t.ws.low, medium: t.ws.medium, high: t.ws.high, xhigh: 'xhigh' }
  return labels[option] ?? option
}
