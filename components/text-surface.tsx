'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
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
import { appendTextDelta, errorMessageFromPayload, parseJsonData, takeSseFrames, textDeltaFromPayload } from '@/lib/text-stream'

interface ReasoningField {
  type: string
  options?: string[]
  default?: string
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
  const requestSequence = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const preferred = reasoningField?.default ?? (reasoningOptions.includes('xhigh') ? 'xhigh' : reasoningOptions[0])
    setReasoningEffort(preferred ?? '')
  }, [model.slug, reasoningField?.default, reasoningOptions.join('|')])

  useEffect(() => {
    requestSequence.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    setBusy(false)
    setResult('')
    setError('')
    setCopied(false)
    return () => {
      requestSequence.current += 1
      abortRef.current?.abort()
      abortRef.current = null
    }
  }, [model.slug])

  async function generate() {
    const value = prompt.trim()
    if (!value || busy) return
    if (!connected) return onNeedConnect()
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const sequence = ++requestSequence.current
    setBusy(true)
    setError('')
    setResult('')
    setCopied(false)
    setPrompt('')
    let accumulated = ''
    let streamError = ''
    let finalPayload: unknown
    const applyPayload = (payload: unknown) => {
      if (sequence !== requestSequence.current) return
      const message = errorMessageFromPayload(payload)
      if (message) {
        streamError = message
        setError(message)
        return
      }
      const chunk = textDeltaFromPayload(payload)
      if (!chunk) return
      // Providers can mix token deltas with a final full-message snapshot.
      // Merge both forms without duplicating the already rendered prefix.
      const next = appendTextDelta(accumulated, chunk)
      if (next === accumulated) return
      accumulated = next
      setResult(accumulated)
    }
    try {
      const response = await api.generateTextStream({
        model: model.slug,
        prompt: value,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      }, controller.signal)
      if (!response.body) throw new Error('文字服务没有返回可读取的流')
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        while (true) {
          const { value: bytes, done } = await reader.read()
          if (bytes) buffer += decoder.decode(bytes, { stream: !done })
          if (done) buffer += decoder.decode()
          const parsed = takeSseFrames(buffer, done)
          buffer = parsed.remainder
          for (const frame of parsed.frames) {
            if (frame.data === '[DONE]') continue
            const payload = parseJsonData(frame.data)
            finalPayload = payload
            applyPayload(payload)
          }
          if (done) break
        }
      } finally {
        reader.releaseLock()
      }
      if (sequence !== requestSequence.current) return
      if (streamError) return
      if (!accumulated) {
        const fallback = textDeltaFromPayload(finalPayload)
        if (fallback) { accumulated = fallback; setResult(fallback) }
      }
      const text = accumulated || t.text.noResult
      setResult(text)
      await saveStudioHistory({ id: `text-${Date.now()}`, type: 'text', source: 'cloud', model: model.name, prompt: value, textResult: text, status: 'COMPLETED', createdAt: Date.now() })
    } catch (err) {
      if (controller.signal.aborted || sequence !== requestSequence.current) return
      if (err instanceof ApiError && err.status === 401 && err.code === 'AUTH_REQUIRED') {
        await refreshMe()
        if (sequence === requestSequence.current) onNeedConnect()
      } else {
        setError(err instanceof ApiError && err.status === 502 ? t.ws.upstreamUnavailable : err instanceof ApiError ? err.message : t.text.failed)
      }
    } finally {
      if (sequence === requestSequence.current) {
        setBusy(false)
        if (abortRef.current === controller) abortRef.current = null
      }
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
            {result ? (
              <div data-testid="text-result" className="relative">
                <article><MarkdownContent value={result} /></article>
                {busy && <span data-testid="text-streaming-cursor" aria-hidden="true" className="ml-1 inline-block h-5 w-0.5 animate-pulse bg-neutral-400 align-middle" />}
              </div>
            ) : busy ? (
              <div role="status" aria-label={t.text.generating} className="space-y-3 animate-pulse">
                {[92, 85, 96, 72, 88, 64].map((width, index) => <div key={index} style={{ width: `${width}%` }} className="h-3 rounded bg-neutral-100 dark:bg-neutral-900" />)}
              </div>
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
