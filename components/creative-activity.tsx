'use client'

import { useEffect, useMemo, useState } from 'react'
import { api, creativeEventStreamUrl } from '@/lib/api'
import type { CreativeEvent } from '@/lib/creative-types'
import type { GenStatus } from '@/lib/types'
import { useI18n } from '@/lib/i18n'
import { IconChevronDown, IconX } from './icons'

const TERMINAL = new Set<GenStatus>(['COMPLETED', 'PARTIAL_SUCCESS', 'CANCELLED', 'FAILED', 'EXPIRED'])

export function CreativeActivity({
  jobId,
  status,
  onStatusChange,
}: {
  jobId: string
  status: GenStatus
  onStatusChange: (status: GenStatus) => void
}) {
  const { t } = useI18n()
  const [events, setEvents] = useState<CreativeEvent[]>([])
  const [open, setOpen] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const terminal = TERMINAL.has(status)

  useEffect(() => {
    let alive = true
    setEvents([])
    void api.creativeEvents(jobId).then(({ events: initial }) => {
      if (alive) setEvents(initial)
    }).catch(() => {})
    if (terminal) return () => { alive = false }
    const source = new EventSource(creativeEventStreamUrl(jobId))
    source.addEventListener('creative', (message) => {
      try {
        const event = JSON.parse((message as MessageEvent).data) as CreativeEvent
        if (!alive) return
        setEvents((current) => current.some((item) => item.id === event.id) ? current : [...current, event])
      } catch {}
    })
    return () => {
      alive = false
      source.close()
    }
  }, [jobId, terminal])

  const labelFor = useMemo(() => {
    const labels: Record<string, string> = {
      'creative.activity.created': t.creative.created,
      'creative.activity.analyzing': t.creative.analyzing,
      'creative.activity.planned': t.creative.planned,
      'creative.activity.queued': t.creative.queued,
      'creative.activity.generating': t.creative.generating,
      'creative.activity.poll_retrying': t.creative.pollRetrying,
      'creative.activity.validating': t.creative.validating,
      'creative.activity.retrying': t.creative.retrying,
      'creative.activity.partial': t.creative.partial,
      'creative.activity.completed': t.creative.completed,
      'creative.activity.cancelling': t.creative.cancellingActivity,
      'creative.activity.cancelled': t.creative.cancelled,
      'creative.activity.expired': t.creative.expired,
      'creative.activity.failed': t.creative.failed,
      'creative.activity.background_removal_created': t.creative.created,
      'creative.activity.background_removing': t.creative.generating,
      'creative.activity.background_removal_completed': t.creative.completed,
      'creative.activity.background_removal_failed': t.creative.failed,
    }
    return (event: CreativeEvent) => {
      if (event.message_key === 'creative.activity.queued') {
        const completed = Number(event.payload?.result_count)
        const count = Number(event.payload?.requested_count)
        if (Number.isFinite(completed) && Number.isFinite(count) && count > 1) {
          return t.ws.generationProgress
            .replace('{count}', String(count))
            .replace('{completed}', String(completed))
            .replace('{unit}', t.ws.imageCountUnit)
        }
      }
      return labels[event.message_key] || t.creative.noActivity
    }
  }, [t])

  const latest = events.at(-1)
  async function cancel() {
    if (terminal || cancelling) return
    setCancelling(true)
    try {
      const job = await api.cancelCreativeJob(jobId)
      onStatusChange(job.status as GenStatus)
    } catch {
    } finally {
      setCancelling(false)
    }
  }

  return (
    <div className="pointer-events-auto mx-auto mb-2 flex w-full max-w-5xl justify-center">
      <button
        type="button"
        data-testid="creative-activity"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        className="flex min-h-8 max-w-full items-center gap-2 rounded-full border border-neutral-200 bg-white/95 px-3 py-1.5 text-xs text-neutral-600 shadow-sm transition hover:bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900/95 dark:text-neutral-300 dark:hover:bg-neutral-800"
      >
        {!terminal && <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" />}
        <span className="truncate">{latest ? labelFor(latest) : t.creative.noActivity}</span>
        <IconChevronDown className="h-3 w-3 shrink-0 text-neutral-400" />
      </button>

      {open && (
        <div className="fixed inset-0 z-[90] bg-black/15" onClick={(event) => { if (event.target === event.currentTarget) setOpen(false) }}>
          <aside data-testid="creative-activity-panel" className="absolute bottom-4 right-4 flex max-h-[min(520px,calc(100vh-32px))] w-[min(390px,calc(100vw-32px))] flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-950">
            <header className="flex h-12 shrink-0 items-center justify-between border-b border-neutral-100 px-4 dark:border-neutral-900">
              <h2 className="text-sm font-semibold">{t.creative.activityTitle}</h2>
              <button type="button" onClick={() => setOpen(false)} className="icon-btn" title={t.creative.close} aria-label={t.creative.close}><IconX className="h-4 w-4" /></button>
            </header>
            <ol className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              {(events.length ? events : [{ id: 0, message_key: '', created_at: new Date().toISOString() } as CreativeEvent]).map((event, index) => (
                <li key={event.id} className="relative flex gap-3 pb-4 last:pb-1">
                  {index < Math.max(events.length, 1) - 1 && <span className="absolute left-[5px] top-4 h-[calc(100%-8px)] w-px bg-neutral-200 dark:bg-neutral-800" />}
                  <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${index === Math.max(events.length, 1) - 1 ? 'bg-neutral-900 dark:bg-white' : 'bg-neutral-300 dark:bg-neutral-700'}`} />
                  <div className="min-w-0"><p className="text-sm leading-5 text-neutral-700 dark:text-neutral-200">{event.message_key ? labelFor(event) : t.creative.noActivity}</p><time className="mt-0.5 block text-[11px] text-neutral-400">{new Date(event.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>
                </li>
              ))}
            </ol>
            {!terminal && <footer className="shrink-0 border-t border-neutral-100 p-3 dark:border-neutral-900"><button type="button" onClick={() => void cancel()} disabled={cancelling || status === 'CANCEL_REQUESTED'} className="w-full rounded-md py-2 text-sm font-medium text-neutral-600 transition hover:bg-neutral-100 disabled:opacity-50 dark:text-neutral-300 dark:hover:bg-neutral-900">{cancelling || status === 'CANCEL_REQUESTED' ? t.creative.cancelling : t.creative.cancel}</button></footer>}
          </aside>
        </div>
      )}
    </div>
  )
}
