'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useI18n } from '@/lib/i18n'
import type { Dict } from '@/lib/i18n/en'
import { useStudio } from '@/lib/studio'
import { ApiError, api, creativeAssetIdFromUrl, thumbUrl, uploadFile } from '@/lib/api'
import { deleteLocalGeneration, listLocalHistory } from '@/lib/local/history'
import { deleteStudioHistory, listStudioHistory, type StudioHistoryRecord } from '@/lib/local/studio-history'
import { copyToClipboard } from '@/lib/clipboard'
import { downloadImageVariant, prepareLayoutPreservingTransparency } from '@/lib/image-download'
import { imageAspectRatioValue } from '@/lib/image-aspect-ratio'
import type { CloudGeneration, GenStatus } from '@/lib/types'
import type { CreativeJob } from '@/lib/creative-types'
import type { BackgroundRemovalQuota } from '@/lib/background-removal-types'
import { IconCheck, IconCopy, IconDownload, IconPlay, IconRetry, IconX } from './icons'
import { MarkdownContent } from './markdown-content'

interface HistoryItem {
  id: string
  jobId?: string
  type: 'cloud' | 'local'
  mediaType: 'image' | 'video' | 'text'
  model: string
  prompt: string | null
  status: GenStatus
  result_url?: string | null
  objectUrl?: string
  textResult?: string
  createdAt: number
  error?: string
  serverBacked?: boolean
  aspectRatio?: number
}

function fromCloud(record: StudioHistoryRecord): HistoryItem {
  return { id: record.id, type: 'cloud', mediaType: record.type, model: record.model, prompt: record.prompt, status: record.status, result_url: record.resultUrl, textResult: record.textResult, createdAt: record.createdAt, error: record.error }
}

function fromApi(record: CloudGeneration): HistoryItem[] {
  const serverBacked = record.id.startsWith('job_')
  const resultUrls = record.result_urls?.length ? record.result_urls : record.result_url ? [record.result_url] : []
  const expectedCount = serverBacked
    ? Math.max(1, record.expected_count ?? resultUrls.length)
    : 1
  return Array.from({ length: expectedCount }, (_, index) => ({
    id: serverBacked ? `${record.id}:output:${index}` : record.id,
    jobId: serverBacked ? record.id : undefined,
    type: 'cloud',
    mediaType: record.type === 'video' ? 'video' : 'image',
    model: record.model,
    prompt: record.prompt,
    status: !resultUrls[index] && record.status === 'COMPLETED' ? 'FAILED' : record.status,
    result_url: resultUrls[index] || null,
    createdAt: new Date(record.created_at).getTime(),
    error: record.error || undefined,
    serverBacked,
    aspectRatio: imageAspectRatioValue(record.aspect_ratio),
  }))
}

function historyKey(item: Pick<HistoryItem, 'id' | 'type'>) {
  return `${item.type}:${item.id}`
}

function modelKey(model: string) {
  return model.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

export function HistoryGrid({
  modelType,
  currentCloudTasks,
  localInProgress,
  refreshToken,
  empty,
  onContinueEdit,
  onRetry,
  onCancel,
}: {
  modelType: 'image' | 'video' | 'all'
  currentCloudTasks?: Array<{ id: string; status: string; model: string; prompt?: string; type?: 'image' | 'video'; resultUrls?: string[]; expectedCount?: number; aspectRatio?: number }>
  localInProgress?: { seed: number; prompt: string; aspectRatio?: number }
  refreshToken: number
  empty?: ReactNode
  onContinueEdit?: (item: { jobId: string; resultUrl: string }) => void
  onRetry?: (jobId: string) => Promise<void>
  onCancel?: (jobId: string) => Promise<void>
}) {
  const { t } = useI18n()
  const { connected } = useStudio()
  const [items, setItems] = useState<HistoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [manage, setManage] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [modal, setModal] = useState<HistoryItem | null>(null)
  const [copied, setCopied] = useState(false)
  const [retryingId, setRetryingId] = useState('')
  const [cancellingId, setCancellingId] = useState('')
  const [measuredRatios, setMeasuredRatios] = useState<Record<string, number>>({})
  const loadedOnce = useRef(false)
  const loadSequence = useRef(0)

  const loadHistory = useCallback(async () => {
    const sequence = ++loadSequence.current
    if (!loadedOnce.current) setLoading(true)
    try {
      const [stored, local, cloud] = await Promise.all([
        listStudioHistory(modelType === 'all' ? undefined : modelType),
        listLocalHistory(),
        connected ? api.generations(modelType === 'all' ? undefined : modelType).catch(() => ({ generations: [], pagination: {} as any })) : Promise.resolve({ generations: [], pagination: {} as any }),
      ])
      const next: HistoryItem[] = stored.filter((item) => modelType === 'all' || item.type === modelType).map(fromCloud)
      if (modelType === 'image' || modelType === 'video' || modelType === 'all') {
        for (const item of local) {
          if (modelType !== 'all' && modelType !== 'image') continue
          next.push({ id: item.id, type: 'local', mediaType: 'image', model: t.local.badge, prompt: item.prompt, status: 'COMPLETED', objectUrl: item.objectUrl, createdAt: item.createdAt, aspectRatio: item.width / item.height })
        }
      }
      for (const item of cloud.generations || []) {
        for (const output of fromApi(item)) {
          if (!next.some((entry) => historyKey(entry) === historyKey(output))) next.push(output)
        }
      }
      next.sort((a, b) => b.createdAt - a.createdAt)
      if (sequence === loadSequence.current) setItems(next)
    } finally {
      if (sequence === loadSequence.current) {
        loadedOnce.current = true
        setLoading(false)
      }
    }
  }, [connected, modelType, t.local.badge])

  useEffect(() => { void loadHistory() }, [loadHistory, refreshToken])

  const visible = useMemo(() => {
    const merged = new Map(items.map((item) => [historyKey(item), item]))
    const now = Date.now()
    for (const task of currentCloudTasks ?? []) {
      if (!['PENDING', 'IN_QUEUE', 'IN_PROGRESS', 'CANCEL_REQUESTED'].includes(task.status)) continue
      const mediaType = task.type ?? (modelType === 'video' ? 'video' : 'image')
      if (modelType !== 'all' && mediaType !== modelType) continue
      const expectedCount = Math.max(1, task.expectedCount ?? task.resultUrls?.length ?? 1)
      for (let index = 0; index < expectedCount; index += 1) {
        const id = `${task.id}:output:${index}`
        const key = historyKey({ id, type: 'cloud' })
        const stored = merged.get(key)
        merged.set(key, {
          ...stored,
          id,
          jobId: task.id,
          type: 'cloud',
          mediaType,
          model: task.model,
          prompt: task.prompt || stored?.prompt || null,
          status: task.status as HistoryItem['status'],
          result_url: task.resultUrls?.[index] || stored?.result_url || null,
          createdAt: stored?.createdAt ?? now,
          serverBacked: stored?.serverBacked || task.id.startsWith('job_'),
          aspectRatio: task.aspectRatio ?? stored?.aspectRatio,
        })
      }
    }
    if (localInProgress && (modelType === 'image' || modelType === 'all')) {
      const current: HistoryItem = { id: 'local-in-progress', type: 'local', mediaType: 'image', model: t.local.badge, prompt: localInProgress.prompt, status: 'IN_PROGRESS', createdAt: now, aspectRatio: localInProgress.aspectRatio }
      merged.set(historyKey(current), current)
    }
    const ordered = Array.from(merged.values())
      .filter((item) => modelType === 'all' || item.mediaType === modelType)
      .sort((a, b) => b.createdAt - a.createdAt)
    const newerAttempts = new Map<string, string>()
    const visibleFailures = new Map<string, string>()
    return ordered.filter((item) => {
      if (item.status === 'CANCELLED') return false
      if (!item.serverBacked) return true
      const signature = `${item.mediaType}\u0000${modelKey(item.model)}\u0000${item.prompt || ''}`
      const attemptId = item.jobId || item.id
      const failed = item.status === 'FAILED' || item.status === 'PARTIAL_SUCCESS' || item.status === 'EXPIRED'
      if (failed) {
        const newerAttempt = newerAttempts.get(signature)
        const visibleFailure = visibleFailures.get(signature)
        if ((newerAttempt && newerAttempt !== attemptId) || (visibleFailure && visibleFailure !== attemptId)) return false
        visibleFailures.set(signature, attemptId)
        return true
      }
      if (!newerAttempts.has(signature)) newerAttempts.set(signature, attemptId)
      return true
    })
  }, [currentCloudTasks, items, localInProgress, modelType, t.local.badge])
  const retry = async (item: HistoryItem) => {
    if (!onRetry || !item.serverBacked || retryingId) return
    const jobId = item.jobId || item.id
    setRetryingId(jobId)
    try {
      await onRetry(jobId)
    } catch {
      // GenerationSurface exposes the request error above the composer.
    } finally {
      setRetryingId('')
    }
  }
  const cancel = async (item: HistoryItem) => {
    if (!onCancel || !item.serverBacked || cancellingId) return
    const jobId = item.jobId || item.id
    setCancellingId(jobId)
    try {
      await onCancel(jobId)
      await loadHistory()
    } catch {
      // GenerationSurface exposes the request error above the composer.
    } finally {
      setCancellingId('')
    }
  }
  const removeOne = async (item: HistoryItem) => {
    const targetId = item.serverBacked ? item.jobId || item.id : item.id
    if (item.type === 'local') await deleteLocalGeneration(item.id)
    else {
      if (item.serverBacked) await api.deleteCreativeJob(targetId)
      await deleteStudioHistory(targetId)
    }
    await loadHistory()
  }
  const toggle = (key: string) => setSelected((prev) => prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key])
  const removeSelected = async () => {
    const targets = new Map<string, HistoryItem>()
    for (const key of selected) {
      const item = visible.find((entry) => historyKey(entry) === key)
      if (!item) continue
      const targetId = item.serverBacked ? item.jobId || item.id : item.id
      targets.set(`${item.type}:${targetId}`, item)
    }
    await Promise.all(Array.from(targets.values()).map(async (item) => {
      if (item.type === 'local') return deleteLocalGeneration(item.id)
      const targetId = item.serverBacked ? item.jobId || item.id : item.id
      if (item.serverBacked) await api.deleteCreativeJob(targetId)
      await deleteStudioHistory(targetId)
    }))
    setSelected([])
    await loadHistory()
  }

  const taskItems = visible.filter(isTaskItem)
  const workItems = visible.filter((item) => !isTaskItem(item))
  const rememberRatio = (item: HistoryItem, width: number, height: number) => {
    if (!width || !height) return
    const ratio = Math.max(0.25, Math.min(4, width / height))
    const key = historyKey(item)
    setMeasuredRatios((current) => Math.abs((current[key] ?? 0) - ratio) < 0.001 ? current : { ...current, [key]: ratio })
  }

  if (loading) {
    return <section data-testid="history-skeleton" className="mx-auto w-full max-w-[1440px] py-12"><div className="mb-5 h-5 w-24 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" /><div className="flex h-48 gap-3 sm:h-56">{[1.2, 1.7, 0.75, 1.1].map((ratio, index) => <div key={index} style={{ flex: ratio }} className="animate-pulse rounded-lg bg-neutral-100 dark:bg-neutral-900" />)}</div></section>
  }

  return (
    <section className="mx-auto w-full max-w-[1440px] py-8">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div><h2 className="text-lg font-semibold">{t.ws.works}</h2><p className="mt-1 text-xs text-neutral-400">{workItems.length ? (t.ws.workCount.includes('{count}') ? t.ws.workCount.replace('{count}', String(workItems.length)) : `${workItems.length} ${t.ws.workCount}`) : t.ws.worksEmpty}</p></div>
        {workItems.length > 0 && <div className="flex items-center gap-2">
          {manage && selected.length > 0 && <button type="button" onClick={() => void removeSelected()} className="rounded-full px-3 py-1.5 text-xs font-medium text-red-600 transition hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950/30">{t.ws.deleteSelected.replace('{count}', String(selected.length))} {!t.ws.deleteSelected.includes('{count}') && `(${selected.length})`}</button>}
          <button type="button" onClick={() => { setManage((v) => !v); setSelected([]) }} className="rounded-full px-3 py-1.5 text-xs font-medium text-neutral-600 transition hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-white">{manage ? t.ws.doneManaging : t.ws.manage}</button>
        </div>}
      </div>
      {!visible.length ? (empty ?? <div className="rounded-lg border border-dashed border-neutral-200 py-16 text-center text-sm text-neutral-400 dark:border-neutral-800">{t.history.empty}</div>) : <>
        {taskItems.length > 0 && <div data-testid="history-task-list" className="mb-5 grid gap-2 md:grid-cols-2">
          {taskItems.map((item) => <HistoryTask key={historyKey(item)} item={item} retrying={retryingId === (item.jobId || item.id)} cancelling={cancellingId === (item.jobId || item.id)} onRetry={onRetry && item.serverBacked ? () => void retry(item) : undefined} onCancel={onCancel && item.serverBacked && isPending(item.status) ? () => void cancel(item) : undefined} onRemove={!isPending(item.status) ? () => void removeOne(item) : undefined} t={t} />)}
        </div>}
        {workItems.length > 0 && <div data-testid="history-gallery" className="history-gallery">
          {workItems.map((item) => {
            const ratio = measuredRatios[historyKey(item)] ?? displayRatio(item)
            return <HistoryCard key={historyKey(item)} item={item} ratio={ratio} manage={manage} selected={selected.includes(historyKey(item))} onToggle={() => toggle(historyKey(item))} onOpen={() => setModal(item)} onRatio={(width, height) => rememberRatio(item, width, height)} />
          })}
        </div>}
      </>}
      {modal && <MediaModal item={modal} copied={copied} onClose={() => { setModal(null); setCopied(false) }} onCopy={async () => { const value = modal.mediaType === 'text' ? modal.textResult || modal.prompt : modal.prompt; if (!value) return; if (!await copyToClipboard(value)) return; setCopied(true); setTimeout(() => setCopied(false), 1500) }} onContinueEdit={onContinueEdit && modal.serverBacked && !isPending(modal.status) && modal.mediaType === 'image' && (modal.objectUrl || modal.result_url) ? () => { onContinueEdit({ jobId: modal.jobId || modal.id, resultUrl: modal.objectUrl || modal.result_url! }); setModal(null) } : undefined} t={t} />}
    </section>
  )
}

function HistoryTask({ item, retrying, cancelling, onRetry, onCancel, onRemove, t }: { item: HistoryItem; retrying: boolean; cancelling: boolean; onRetry?: () => void; onCancel?: () => void; onRemove?: () => void; t: Dict }) {
  const pending = isPending(item.status)
  return <div data-history-key={historyKey(item)} data-task-aspect-ratio={item.aspectRatio || undefined} className={`relative flex min-h-16 min-w-0 items-center gap-3 overflow-hidden rounded-lg bg-neutral-50 px-3 py-2.5 dark:bg-neutral-900 ${pending ? 'creative-pending-card' : ''}`}>
    <span className={`h-2 w-2 shrink-0 rounded-full ${pending ? 'animate-pulse bg-neutral-500' : 'bg-red-500'}`} />
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 items-center gap-2">
        <span className={`shrink-0 text-xs font-medium ${pending ? 'text-neutral-700 dark:text-neutral-200' : 'text-red-600 dark:text-red-300'}`}>{pending ? t.history.generating : t.history.failed}</span>
        <span className="truncate text-[11px] text-neutral-400">{item.model}</span>
      </div>
      <p className={`mt-1 truncate text-xs ${pending ? 'text-neutral-500' : 'text-red-600/80 dark:text-red-300/80'}`}>{pending ? item.prompt : item.error || item.prompt || t.history.failed}</p>
    </div>
    <div className="flex shrink-0 items-center gap-1">
      {!pending && onRetry && <button type="button" onClick={onRetry} disabled={retrying} className="inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium text-neutral-600 transition hover:bg-neutral-200 hover:text-neutral-900 disabled:opacity-50 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-white"><IconRetry className={`h-3.5 w-3.5 ${retrying ? 'animate-spin' : ''}`} />{retrying ? t.history.retrying : t.history.retry}</button>}
      {pending && onCancel && <button type="button" data-testid="cancel-creative-job" onClick={onCancel} disabled={cancelling || item.status === 'CANCEL_REQUESTED'} title={cancelling ? t.creative.cancelling : t.creative.cancel} aria-label={cancelling ? t.creative.cancelling : t.creative.cancel} className="grid h-8 w-8 place-items-center rounded-full text-neutral-500 transition hover:bg-neutral-200 hover:text-neutral-900 disabled:opacity-50 dark:hover:bg-neutral-800 dark:hover:text-white"><IconX className="h-3.5 w-3.5" /></button>}
      {!pending && onRemove && <button type="button" onClick={onRemove} title={t.history.delete} aria-label={t.history.delete} className="grid h-8 w-8 place-items-center rounded-full text-neutral-400 transition hover:bg-neutral-200 hover:text-red-600 dark:hover:bg-neutral-800 dark:hover:text-red-300"><IconX className="h-3.5 w-3.5" /></button>}
    </div>
  </div>
}

function HistoryCard({ item, ratio, manage, selected, onToggle, onOpen, onRatio }: { item: HistoryItem; ratio: number; manage: boolean; selected: boolean; onToggle: () => void; onOpen: () => void; onRatio: (width: number, height: number) => void }) {
  const image = item.objectUrl || item.result_url || ''
  const style = {
    '--history-ratio': ratio,
    '--history-basis-mobile': `${ratio * 176}px`,
    '--history-basis-tablet': `${ratio * 208}px`,
    '--history-basis-desktop': `${ratio * 228}px`,
    aspectRatio: ratio,
  } as CSSProperties
  return <div data-history-key={historyKey(item)} style={style} className={`history-gallery-item group relative overflow-hidden rounded-lg bg-neutral-100 text-left dark:bg-neutral-900 ${selected ? 'ring-2 ring-neutral-900 ring-offset-2 dark:ring-white dark:ring-offset-neutral-950' : ''}`}>
    <button type="button" onClick={manage ? onToggle : onOpen} className="absolute inset-0 h-full w-full text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-neutral-500">
      {item.mediaType === 'text' ? <div className="h-full overflow-hidden bg-[#f1eee7] p-4 text-sm leading-6 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"><div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-neutral-400">{item.model}</div>{item.textResult || item.prompt}</div> : image ? <img src={item.objectUrl ? image : thumbUrl(image, 480)} alt="" loading="lazy" decoding="async" width={480} height={480} onLoad={(event) => onRatio(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)} className="h-full w-full object-cover" /> : null}
      {item.mediaType === 'video' && image && <span className="absolute inset-0 grid place-items-center bg-black/10"><span className="grid h-10 w-10 place-items-center rounded-full bg-white/90"><IconPlay className="h-4 w-4 text-neutral-900" /></span></span>}
      {!manage && <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/65 to-transparent px-3 pb-3 pt-10 text-[11px] text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">{item.prompt || item.model}</span>}
    </button>
    {manage && <span className={`pointer-events-none absolute left-3 top-3 grid h-5 w-5 place-items-center rounded-full border ${selected ? 'border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900' : 'border-white/80 bg-black/20 text-transparent'}`}><IconCheck className="h-3 w-3" /></span>}
  </div>
}

function hasRenderableContent(item: HistoryItem) {
  if (item.mediaType === 'text') return Boolean(item.textResult || item.prompt)
  return Boolean(item.objectUrl || item.result_url)
}

function isTaskItem(item: HistoryItem) {
  return isPending(item.status) || !hasRenderableContent(item)
}

function displayRatio(item: HistoryItem) {
  if (item.aspectRatio) return item.aspectRatio
  if (item.mediaType === 'video') return 16 / 9
  if (item.mediaType === 'text') return 4 / 3
  return 1
}

function isPending(status: GenStatus) {
  return ['PENDING', 'IN_QUEUE', 'IN_PROGRESS', 'CANCEL_REQUESTED'].includes(status)
}

function MediaModal({ item, copied, onClose, onCopy, onContinueEdit, t }: { item: HistoryItem; copied: boolean; onClose: () => void; onCopy: () => Promise<void>; onContinueEdit?: () => void; t: Dict }) {
  const media = item.objectUrl || item.result_url || ''
  const alive = useRef(true)
  const savedCreativeAssetUrl = useRef('')
  const [downloading, setDownloading] = useState<'transparent' | 'white' | ''>('')
  const [downloadError, setDownloadError] = useState(false)
  const [quotaExhausted, setQuotaExhausted] = useState(false)
  const [sourceRequired, setSourceRequired] = useState(false)
  const [quota, setQuota] = useState<BackgroundRemovalQuota | null>(null)
  const [savingToCreative, setSavingToCreative] = useState(false)
  const [removingBackground, setRemovingBackground] = useState(false)
  const [processedMedia, setProcessedMedia] = useState('')
  const processedMediaRef = useRef('')

  useEffect(() => {
    alive.current = true
    processedMediaRef.current = ''
    setProcessedMedia('')
    if (!media || item.mediaType !== 'image') return () => { alive.current = false }
    void api.backgroundRemovalQuota().then((value) => { if (alive.current) setQuota(value) }).catch(() => {})
    return () => {
      alive.current = false
      if (processedMediaRef.current.startsWith('blob:')) URL.revokeObjectURL(processedMediaRef.current)
      processedMediaRef.current = ''
    }
  }, [item.mediaType, media])

  function rememberProcessedMedia(value: string) {
    if (processedMediaRef.current.startsWith('blob:')) URL.revokeObjectURL(processedMediaRef.current)
    processedMediaRef.current = value
    setProcessedMedia(value)
    return value
  }

  async function waitForBackgroundRemoval(jobId: string) {
    for (let attempt = 0; attempt < 180; attempt += 1) {
      if (!alive.current) throw new Error('Background removal cancelled')
      const job = await api.creativeJob(jobId)
      if (!alive.current) throw new Error('Background removal cancelled')
      if (['COMPLETED', 'PARTIAL_SUCCESS'].includes(job.status)) return job
      if (['FAILED', 'EXPIRED', 'CANCELLED'].includes(job.status)) throw new Error(job.error_message || 'Background removal failed')
      await new Promise((resolve) => setTimeout(resolve, 1_500))
    }
    throw new Error('Background removal timed out')
  }

  async function saveWorkToCreativeCore(source: string) {
    if (savedCreativeAssetUrl.current) return savedCreativeAssetUrl.current
    setSavingToCreative(true)
    try {
      let publicUrl = ''
      if (/^https?:\/\//i.test(source)) {
        publicUrl = (await api.importCreativeAsset(source)).publicUrl
      } else {
        const response = await fetch(source)
        if (!response.ok) throw new Error(`Image download failed with HTTP ${response.status}`)
        const blob = await response.blob()
        if (!blob.type.startsWith('image/')) throw new Error('Creative asset must be an image')
        const extension = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png'
        const safeId = item.id.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'work'
        publicUrl = await uploadFile(new File([blob], `cinlan-${safeId}.${extension}`, { type: blob.type }))
      }
      if (!creativeAssetIdFromUrl(publicUrl)) throw new Error('Creative Core did not return an asset URL')
      savedCreativeAssetUrl.current = publicUrl
      return publicUrl
    } finally {
      if (alive.current) setSavingToCreative(false)
    }
  }

  const downloadImage = async (background: 'transparent' | 'white') => {
    if (!media || downloading) return
    setDownloading(background)
    setDownloadError(false)
    setQuotaExhausted(false)
    setSourceRequired(false)
    try {
      let target = processedMediaRef.current
      if (!target) {
        const preserved = await prepareLayoutPreservingTransparency(media)
        if (!alive.current) return
        if (preserved) target = rememberProcessedMedia(URL.createObjectURL(preserved))
      }
      if (!target) target = media
      let assetId = creativeAssetIdFromUrl(target)
      if (!processedMediaRef.current && !assetId) {
        try {
          target = await saveWorkToCreativeCore(media)
          assetId = creativeAssetIdFromUrl(target)
        } catch {
          if (alive.current) setSourceRequired(true)
          throw new Error('Creative Core asset import failed')
        }
      }
      if (!processedMediaRef.current) {
        if (!assetId) throw new Error('Creative Core asset import failed')
        const submission = await api.removeBackground(assetId, `remove-bg-${assetId}-${globalThis.crypto.randomUUID()}`)
        if (!alive.current) return
        setQuota(submission.quota)
        if (submission.job) {
          setRemovingBackground(true)
          const completed = await waitForBackgroundRemoval(submission.job.id)
          if (!alive.current) return
          target = completed.result_url || completed.result_urls[0] || ''
          if (!target) throw new Error('Background removal returned no image')
        } else if (submission.asset_id) {
          target = `/api/v1/creative/assets/${submission.asset_id}`
        }
        rememberProcessedMedia(target)
      }
      if (!alive.current) return
      await downloadImageVariant(target, `cinlan-${item.id}`, background)
    } catch (error) {
      if (alive.current) {
        if (error instanceof ApiError && error.code === 'BACKGROUND_REMOVAL_QUOTA_EXCEEDED') setQuotaExhausted(true)
        setDownloadError(true)
      }
    } finally {
      if (alive.current) {
        setSavingToCreative(false)
        setRemovingBackground(false)
        setDownloading('')
      }
    }
  }
  return <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div className={`relative flex w-full max-w-3xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl dark:bg-neutral-950 ${item.mediaType === 'text' ? 'h-[min(92dvh,860px)]' : 'max-h-[92dvh]'}`}>
      <button type="button" onClick={onClose} aria-label={t.connect.close} className="absolute right-3 top-3 z-10 grid h-9 w-9 place-items-center rounded-full bg-black/50 text-white"><IconX className="h-4 w-4" /></button>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {item.mediaType === 'text' ? <div className="min-h-full p-7 pr-14"><MarkdownContent value={item.textResult || item.prompt || ''} className="text-sm leading-7" /></div> : item.mediaType === 'video' ? <video src={media} controls autoPlay muted className="max-h-[70vh] w-full object-contain" /> : <div className="grid min-h-64 place-items-center bg-[linear-gradient(45deg,#ececec_25%,transparent_25%),linear-gradient(-45deg,#ececec_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#ececec_75%),linear-gradient(-45deg,transparent_75%,#ececec_75%)] bg-[length:20px_20px] bg-[position:0_0,0_10px,10px_-10px,-10px_0px] dark:bg-[linear-gradient(45deg,#262626_25%,transparent_25%),linear-gradient(-45deg,#262626_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#262626_75%),linear-gradient(-45deg,transparent_75%,#262626_75%)]"><img src={processedMedia || media} alt="" className="max-h-[70vh] w-full object-contain" /></div>}
      </div>
      <div className="shrink-0 space-y-3 border-t border-neutral-200 p-4 dark:border-neutral-800">
        {item.prompt && item.prompt !== item.textResult && <p className="max-h-24 overflow-y-auto overscroll-contain whitespace-pre-wrap break-words pr-2 text-sm leading-6 text-neutral-600 dark:text-neutral-300">{item.prompt}</p>}
        <div className="flex flex-wrap gap-2">
          {onContinueEdit && <button type="button" onClick={onContinueEdit} className="flex flex-1 items-center justify-center rounded-xl bg-neutral-100 py-2.5 text-sm font-medium transition hover:bg-neutral-200 dark:bg-neutral-900 dark:hover:bg-neutral-800">{t.creative.continueEdit}</button>}
          {(item.mediaType === 'text' ? item.textResult || item.prompt : item.prompt) && <button type="button" onClick={onCopy} className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-neutral-100 py-2.5 text-sm font-medium dark:bg-neutral-900">{copied ? <IconCheck className="h-4 w-4" /> : <IconCopy className="h-4 w-4" />}{copied ? t.history.copied : item.mediaType === 'text' ? t.text.copyResult : t.history.copyPrompt}</button>}
          {media && item.mediaType === 'image' && <>
            <button type="button" onClick={() => void downloadImage('transparent')} disabled={Boolean(downloading)} className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-neutral-100 px-3 py-2.5 text-sm font-medium transition hover:bg-neutral-200 disabled:opacity-50 dark:bg-neutral-900 dark:hover:bg-neutral-800"><IconDownload className="h-4 w-4" />{downloading === 'transparent' ? (savingToCreative ? t.history.savingToCreative : removingBackground ? t.history.backgroundRemovalInProgress : t.history.downloading) : t.history.downloadTransparent}</button>
            <button type="button" onClick={() => void downloadImage('white')} disabled={Boolean(downloading)} className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-neutral-900 px-3 py-2.5 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"><IconDownload className="h-4 w-4" />{downloading === 'white' ? (savingToCreative ? t.history.savingToCreative : removingBackground ? t.history.backgroundRemovalInProgress : t.history.downloading) : t.history.downloadWhite}</button>
          </>}
          {media && item.mediaType === 'video' && <a href={media} download={`cinlan-${item.id}`} className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-neutral-900 py-2.5 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"><IconDownload className="h-4 w-4" />{t.history.download}</a>}
        </div>
        {quota && !quotaExhausted && <p className={`text-xs ${quota.remaining > 0 ? 'text-neutral-400' : 'text-red-600 dark:text-red-300'}`}>{quota.remaining > 0 ? t.history.quotaRemaining.replace('{remaining}', String(quota.remaining)).replace('{limit}', String(quota.limit)) : t.history.quotaExhausted}</p>}
        {downloadError && <p role="alert" className="text-xs text-red-600 dark:text-red-300">{quotaExhausted ? t.history.quotaExhausted : sourceRequired ? t.history.backgroundRemovalSourceRequired : t.history.downloadFailed}</p>}
      </div>
    </div>
  </div>
}
