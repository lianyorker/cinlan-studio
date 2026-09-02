'use client'

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent } from 'react'
import { useI18n } from '@/lib/i18n'
import { useStudio } from '@/lib/studio'
import { api, ApiError, uploadFile, mediaUrl, thumbUrl } from '@/lib/api'
import { HistoryGrid } from './history-grid'
import { saveLocalGeneration } from '@/lib/local/history'
import { saveStudioHistory } from '@/lib/local/studio-history'
import { gradientFor, creditCost } from '@/lib/catalog'
import { generateLocalImage } from '@/lib/local/client'
import { isLocalModel } from '@/lib/local/model'
import type { LocalProgress } from '@/lib/local/types'
import type { GenStatus, Model, Task, Example } from '@/lib/types'
import type { CreativeAnalysisMode, CreativeJob } from '@/lib/creative-types'
import { imageAspectRatioFromPrompt, imageAspectRatioValue } from '@/lib/image-aspect-ratio'
import { IconArrowUp, IconChevronDown, IconDownload, IconImage, IconVideo, IconMinus, IconPlus } from './icons'
import { LocalFunnel } from './local-funnel'
import { ModelLogo } from './model-visual'
import { ComposerSelect } from './composer-select'
import type { Dict } from '@/lib/i18n/en'
import { CreativeActivity } from './creative-activity'

type Slot = {
  status: 'pending' | 'done' | 'error'
  url?: string
  error?: string
  progress?: string
  seed?: number
  aspectRatio?: number
}

type CloudTask = {
  id: string
  status: GenStatus
  model: string
  prompt: string
  type: 'image' | 'video'
  resultUrls?: string[]
  expectedCount?: number
  slotIndex?: number
  aspectRatio?: number
  error?: string
}

interface FormField {
  type: string
  required?: boolean
  options?: Array<string | number>
  default?: string | number | boolean
}

// form_config field type 鈫?request body key
const BODY_KEY: Record<string, string> = {
  aspect_ratio: 'aspectRatio',
  resolution: 'resolution',
  duration: 'duration',
  quality: 'quality',
  tier: 'tier',
  toggle: 'generateAudio',
}

const POLL_MS = 2500
const MAX_POLLS = 200
const ACTIVITY_RESTORE_MS = 30 * 60 * 1000
const LOCAL_IMAGE_SIZE = { width: 1024, height: 1024 }
const BUILTIN_EXAMPLE_IMAGES = [
  '/inspiration/editorial-still-life.webp',
  '/inspiration/futuristic-tea-room.webp',
  '/inspiration/indigo-botanical-poster.webp',
  '/inspiration/rainy-cinematic-portrait.webp',
]

function compatibleJobStatus(status: CreativeJob['status']): GenStatus {
  if (status === 'CREATED') return 'PENDING'
  if (status === 'ANALYZING' || status === 'READY' || status === 'QUEUED') return 'IN_QUEUE'
  if (status === 'RUNNING' || status === 'VALIDATING') return 'IN_PROGRESS'
  return status
}

function isActiveCreativeJob(job: CreativeJob) {
  return ['CREATED', 'ANALYZING', 'READY', 'QUEUED', 'RUNNING', 'VALIDATING', 'CANCEL_REQUESTED'].includes(job.status)
}

function isRecentCreativeJob(job: CreativeJob) {
  const updatedAt = Date.parse(job.updated_at)
  return Number.isFinite(updatedAt) && Date.now() - updatedAt <= ACTIVITY_RESTORE_MS
}

export function GenerationSurface({
  model,
  onOpenPicker,
  onNeedConnect,
  onUseCloud,
}: {
  model: Model
  onOpenPicker: () => void
  onNeedConnect: (mode?: 'login' | 'key' | 'reauth') => void
  onUseCloud: () => void
}) {
  const { t } = useI18n()
  const { connected, refreshMe, localState, refreshLocal, creativeCore } = useStudio()
  const isVideo = model.type === 'video'
  const local = isLocalModel(model)

  const fields = useMemo<FormField[]>(
    () => {
      if (local) return []
      const configured = (model.form_config?.fields as FormField[] | undefined) ?? []
      const capabilityOptions: Record<string, Array<string | number> | undefined> = {
        aspect_ratio: model.capabilities?.aspect_ratios,
        quality: model.capabilities?.qualities,
        resolution: model.capabilities?.resolutions,
      }
      return configured.flatMap((field) => {
        if (!isVideo && field.type === 'aspect_ratio') return []
        if (!(field.type in capabilityOptions) || !model.capabilities) return [field]
        const options = capabilityOptions[field.type] ?? []
        if (!options.length) return []
        const fallback = options.includes(field.default as string | number) ? field.default : options[0]
        return [{ ...field, options, default: fallback }]
      })
    },
    [isVideo, local, model]
  )
  const controlFields = fields.filter((f) => f.type !== 'prompt' && f.type !== 'image_upload')
  const needsImage = fields.some((f) => f.type === 'image_upload' && f.required)

  const [prompt, setPrompt] = useState('')
  const [values, setValues] = useState<Record<string, string | number | boolean>>({})
  const [count, setCount] = useState(1)
  const [analysisMode, setAnalysisMode] = useState<CreativeAnalysisMode>('deep')
  const [parentJobId, setParentJobId] = useState<string | null>(null)
  const [activityJobId, setActivityJobId] = useState('')
  const [activityStatus, setActivityStatus] = useState<GenStatus>('PENDING')
  const [slots, setSlots] = useState<Slot[]>([])
  const [error, setError] = useState('')
  const [imageUrls, setImageUrls] = useState<string[]>([])
  const [videoUrl, setVideoUrl] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadingVideo, setUploadingVideo] = useState(false)
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const [currentCloudTasks, setCurrentCloudTasks] = useState<CloudTask[]>([])
  const [localInProgressPrompt, setLocalInProgressPrompt] = useState<string>('')
  const [localInProgressAspectRatio, setLocalInProgressAspectRatio] = useState<number | undefined>(undefined)
  const [refreshToken, setRefreshToken] = useState(0)
  const videoRef = useRef<HTMLInputElement>(null)
  const [exs, setExs] = useState<Example[]>([])
  const localObjectUrls = useRef(new Set<string>())
  const localGenerationId = useRef(0)
  const previousModelSlug = useRef<string | null>(null)
  const pollers = useRef<ReturnType<typeof setInterval>[]>([])
  const uploadCounts = useRef({ image: 0, video: 0 })
  const activityJobIdRef = useRef('')

  const hasVideoField = fields.some((f) => f.type === 'video_upload')
  const needsVideo = fields.some((f) => f.type === 'video_upload' && f.required)
  const hasImageField = fields.some((f) => f.type === 'image_upload')
  const canUploadImages = !local && (isVideo ? hasImageField : model.capabilities?.image_edit === true)
  const maxReferenceImages = isVideo ? 4 : Math.max(0, model.capabilities?.max_reference_images ?? 0)
  const maxOutputs = Math.min(4, Math.max(1, model.capabilities?.max_outputs ?? 1))

  // Real community results for this model (drives the center preview).
  useEffect(() => {
    let alive = true
    setExs([])
    if (local) return () => {
      alive = false
    }
    api
      .examples(model.slug, 6)
      .then(({ examples }) => {
        if (alive) setExs(examples)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [local, model.slug])

  // Reconcile catalog field updates without erasing an in-flight generation for the same model.
  useEffect(() => {
    const modelChanged = previousModelSlug.current !== model.slug
    previousModelSlug.current = model.slug
    const init: Record<string, string | number | boolean> = {}
    for (const f of fields) {
      if (f.type === 'prompt' || f.type === 'image_upload') continue
      init[f.type] = f.default ?? f.options?.[0] ?? ''
    }
    setValues((current) => {
      if (modelChanged) return init
      const next: Record<string, string | number | boolean> = {}
      for (const field of fields) {
        if (field.type === 'prompt' || field.type === 'image_upload') continue
        const currentValue = current[field.type]
        const validCurrent = currentValue !== undefined
          && currentValue !== ''
          && (!field.options?.length || field.options.includes(currentValue as string | number))
        next[field.type] = validCurrent ? currentValue : (field.default ?? field.options?.[0] ?? '')
      }
      return next
    })
    setCount((current) => modelChanged ? 1 : Math.min(maxOutputs, current))
    if (!modelChanged) return
    localGenerationId.current += 1
    pollers.current.forEach(clearInterval)
    pollers.current = []
    for (const url of localObjectUrls.current) URL.revokeObjectURL(url)
    localObjectUrls.current.clear()
    setSlots([])
    setCurrentCloudTasks([])
    setParentJobId(null)
    setActivityJobId('')
    activityJobIdRef.current = ''
    setActivityStatus('PENDING')
    setError('')
    setImageUrls([])
    setVideoUrl('')
  }, [fields, maxOutputs, model.slug])

  useEffect(
    () => () => {
      localGenerationId.current += 1
      for (const url of localObjectUrls.current) URL.revokeObjectURL(url)
      localObjectUrls.current.clear()
    },
    []
  )

  useEffect(() => () => pollers.current.forEach(clearInterval), [])

  useEffect(() => {
    if (!creativeCore.enabled || !connected || local || isVideo) return
    let alive = true
    const resumedPollers: ReturnType<typeof setInterval>[] = []
    let resumeTimer: ReturnType<typeof setTimeout> | undefined
    void api.creativeJobs(false, 1, 24).then(({ jobs }) => {
      if (!alive) return
      const matching = jobs.filter((job) => job.model === model.slug)
      const active = matching.filter(isActiveCreativeJob).slice(0, maxOutputs)
      const restored = active[0] ?? matching.find(isRecentCreativeJob)
      if (!restored) return
      const status = compatibleJobStatus(restored.status)
      activityJobIdRef.current = restored.id
      setActivityJobId(restored.id)
      setActivityStatus(status)
      if (!active.length) return
      const tasks: CloudTask[] = []
      const restoredSlots: Slot[] = []
      const jobsToPoll: Array<{ id: string; expectedCount: number; slotIndex: number; aspectRatio?: number }> = []
      let slotIndex = 0
      for (const job of active) {
        const jobStatus = compatibleJobStatus(job.status)
        const expectedCount = Math.min(maxOutputs, Math.max(1, Number(job.parameters.count || 1)))
        const resultUrls = job.result_urls ?? []
        const aspectRatio = imageAspectRatioValue(job.parameters.aspect_ratio)
        tasks.push({ id: job.id, status: jobStatus, model: model.name, prompt: job.prompt, type: 'image', resultUrls, expectedCount, slotIndex, aspectRatio })
        for (let index = 0; index < expectedCount; index += 1) {
          restoredSlots.push(resultUrls[index]
            ? { status: 'done', url: resultUrls[index], aspectRatio }
            : { status: 'pending', aspectRatio })
        }
        jobsToPoll.push({ id: job.id, expectedCount, slotIndex, aspectRatio })
        slotIndex += expectedCount
      }
      setCurrentCloudTasks(tasks)
      setSlots(restoredSlots)
      resumeTimer = setTimeout(() => {
        if (!alive) return
        for (const job of jobsToPoll) {
          resumedPollers.push(pollCreative(job.id, job.expectedCount, job.slotIndex, job.aspectRatio, tasks.find((task) => task.id === job.id)?.prompt))
        }
      }, 0)
    }).catch(() => {})
    return () => {
      alive = false
      if (resumeTimer) clearTimeout(resumeTimer)
      resumedPollers.forEach(clearInterval)
    }
  }, [connected, creativeCore.enabled, isVideo, local, maxOutputs, model.name, model.slug])

  const cost = creditCost(model, values, count)
  const busy = slots.some((s) => s.status === 'pending')
  const settledCount = slots.filter((slot) => slot.status !== 'pending').length
  const failedCount = slots.filter((slot) => slot.status === 'error').length
  const generationError = error || slots.find((slot) => slot.status === 'error')?.error || ''
  const asksForMultipleImages = /(?:生成|制作|创建|给我).{0,6}(?:[2-9]|[一二三四五六七八九十])\s*(?:张|幅|个画面)/.test(prompt)

  function buildBody(promptOverride = prompt): Record<string, unknown> {
    const body: Record<string, unknown> = { model: model.slug, prompt: promptOverride }
    for (const f of controlFields) {
      const key = BODY_KEY[f.type]
      if (key && values[f.type] !== undefined && values[f.type] !== '') body[key] = values[f.type]
    }
    if (imageUrls.length) {
      if (!isVideo) body.imageUrls = imageUrls
      else if (imageUrls.length > 1 || model.slug === 'seedance-1.5-pro') body.imageUrls = imageUrls
      else if (model.slug === 'vidu-q3') body.image = imageUrls[0]
      else body.imageUrl = imageUrls[0]
    }
    if (videoUrl) body.videoUrl = videoUrl
    if (creativeCore.enabled && !isVideo) {
      body.analysis_mode = analysisMode
      if (parentJobId) body.parent_job_id = parentJobId
    }
    if (!isVideo && !body.aspectRatio) {
      const inferredAspectRatio = imageAspectRatioFromPrompt(promptOverride, model.capabilities?.aspect_ratios)
      if (inferredAspectRatio) body.aspectRatio = inferredAspectRatio
    }
    // model-specific field keys the generic map doesn't cover
    if (model.slug === 'kling-3-mc') {
      delete body.generateAudio
      if (values.select !== undefined) body.characterOrientation = values.select
      if (values.toggle !== undefined) body.keepOriginalSound = values.toggle
    }
    return body
  }

  async function uploadReference(file: File, setBusy: (b: boolean) => void, kind: 'image' | 'video'): Promise<string> {
    if (!connected) {
      onNeedConnect()
      return ''
    }
    uploadCounts.current[kind] += 1
    setBusy(true)
    setError('')
    try {
      return await uploadFile(file)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && err.code === 'AUTH_REQUIRED') {
        await refreshMe()
        onNeedConnect()
        return ''
      }
      setError(err instanceof ApiError ? err.message : 'Upload failed')
      return ''
    } finally {
      uploadCounts.current[kind] = Math.max(0, uploadCounts.current[kind] - 1)
      if (uploadCounts.current[kind] === 0) setBusy(false)
    }
  }

  async function doImageUpload(e: ChangeEvent<HTMLInputElement>) {
    const input = e.target
    const files = Array.from(input.files ?? []).filter((file) => file.type.startsWith('image/')).slice(0, Math.max(0, maxReferenceImages - imageUrls.length))
    if (!files.length) return
    const urls = (await Promise.all(files.map((file) => uploadReference(file, setUploading, 'image')))).filter(Boolean)
    setImageUrls((current) => [...current, ...urls].slice(0, maxReferenceImages))
    input.value = ''
  }

  async function doVideoUpload(e: ChangeEvent<HTMLInputElement>) {
    const input = e.target
    const file = input.files?.[0]
    if (!file) return
    const url = await uploadReference(file, setUploadingVideo, 'video')
    if (url) setVideoUrl(url)
    input.value = ''
  }

  function pasteReference(event: ClipboardEvent<HTMLElement>) {
    if (!canUploadImages) return
    if (event.clipboardData.getData('text/plain').trim()) return
    const itemFiles = Array.from(event.clipboardData.items)
      .filter((entry) => entry.kind === 'file' && entry.type.startsWith('image/'))
      .map((entry) => entry.getAsFile())
      .filter((file): file is File => file !== null)
    const files = (itemFiles.length ? itemFiles : Array.from(event.clipboardData.files).filter((entry) => entry.type.startsWith('image/')))
      .slice(0, Math.max(0, maxReferenceImages - imageUrls.length))
    if (!files.length) return
    event.preventDefault()
    void Promise.all(files.map((file) => uploadReference(file, setUploading, 'image'))).then((urls) => {
      setImageUrls((current) => [...current, ...urls.filter(Boolean)].slice(0, maxReferenceImages))
    })
  }

  async function runOne(index: number, promptOverride: string, temporaryTaskId: string, idempotencyKey: string, requestBody: Record<string, unknown>) {
    const body = { ...requestBody, idempotency_key: `${idempotencyKey}-${index}` }
    const aspectRatio = imageAspectRatioValue(requestBody.aspectRatio ?? requestBody.aspect_ratio)
    setCurrentCloudTasks((prev) => prev.map((task) => task.id === temporaryTaskId ? { ...task, status: 'IN_PROGRESS' } : task))
    try {
      const res = isVideo ? await api.generateVideo(body) : await api.generateImage({ ...body, count: 1 })
      const status = res.status ?? 'IN_PROGRESS'
      const resultUrl = res.result_url ?? res.result_urls?.[0]
      if (creativeCore.enabled && !isVideo) {
        setParentJobId(null)
        if (!activityJobIdRef.current) {
          activityJobIdRef.current = res.id
          setActivityJobId(res.id)
          setActivityStatus(status)
        }
        setCurrentCloudTasks((current) => current.map((task) => task.id === temporaryTaskId
          ? { ...task, id: res.id, status, resultUrls: resultUrl ? [resultUrl] : [], expectedCount: 1, slotIndex: index, aspectRatio }
          : task))
        if ((status === 'COMPLETED' || status === 'PARTIAL_SUCCESS') && resultUrl) {
          setSlot(index, { status: 'done', url: resultUrl, aspectRatio })
          setRefreshToken((current) => current + 1)
          void refreshMe()
          return
        }
        pollCreative(res.id, 1, index, aspectRatio, promptOverride)
        return
      }
      if (status === 'COMPLETED' && resultUrl) {
        setSlot(index, { status: 'done', url: resultUrl, aspectRatio })
        await saveStudioHistory({ id: `${model.slug}-${res.id}-${index}`, type: isVideo ? 'video' : 'image', source: 'cloud', model: model.name, prompt: promptOverride, resultUrl, status: 'COMPLETED', createdAt: Date.now() }).catch(() => {})
        setCurrentCloudTasks((prev) => prev.filter((task) => task.id !== temporaryTaskId))
        setRefreshToken((prev) => prev + 1)
        void refreshMe()
        return
      }
      setCurrentCloudTasks((prev) => prev.map((task) => task.id === temporaryTaskId ? { ...task, id: res.id, status: 'IN_PROGRESS', slotIndex: index, aspectRatio } : task))
      await poll(res.id, index, promptOverride)
    } catch (e) {
      setCurrentCloudTasks((prev) => prev.filter((task) => task.id !== temporaryTaskId))
      handleError(e, index)
    }
  }

  function updateSlotRange(start: number, count: number, create: (index: number) => Slot) {
    setSlots((current) => {
      const next = Array.from({ length: Math.max(current.length, start + count) }, (_, index) => current[index] ?? { status: 'pending' as const })
      for (let index = 0; index < count; index += 1) next[start + index] = create(index)
      return next
    })
  }

  function pollCreative(id: string, expectedCount: number, slotStart = 0, aspectRatio?: number, taskPrompt = '') {
    let polls = 0
    let failures = 0
    let running = false
    let interval: ReturnType<typeof setInterval> | undefined
    const stop = () => {
      if (interval === undefined) return
      clearInterval(interval)
      pollers.current = pollers.current.filter((poller) => poller !== interval)
    }
    const tick = async () => {
      if (running) return
      running = true
      polls += 1
      try {
        if (polls > MAX_POLLS) {
          stop()
          setCurrentCloudTasks((current) => current.filter((task) => task.id !== id))
          updateSlotRange(slotStart, expectedCount, () => ({ status: 'error', error: t.ws.failed, aspectRatio }))
          return
        }
        const task = await api.task(id, isVideo ? 'video' : 'image')
        failures = 0
        const urls = task.result_urls?.length ? task.result_urls : task.result_url ? [task.result_url] : []
        if (activityJobIdRef.current === id) setActivityStatus(task.status)
        setCurrentCloudTasks((current) => {
          const existing = current.find((item) => item.id === id)
          const updated: CloudTask = {
            ...(existing ?? { id, model: model.name, prompt: taskPrompt, type: isVideo ? 'video' : 'image', slotIndex: slotStart, aspectRatio }),
            status: task.status,
            resultUrls: urls,
            expectedCount,
            error: task.error || undefined,
          }
          return existing ? current.map((item) => item.id === id ? updated : item) : [...current, updated]
        })
        const visibleCount = Math.max(expectedCount, urls.length)
        updateSlotRange(slotStart, visibleCount, (index) => urls[index]
          ? { status: 'done', url: urls[index], aspectRatio }
          : { status: 'pending', aspectRatio })
        if (task.status === 'COMPLETED' || task.status === 'PARTIAL_SUCCESS') {
          stop()
          updateSlotRange(slotStart, visibleCount, (index) => urls[index]
            ? { status: 'done', url: urls[index], aspectRatio }
            : { status: 'error', error: t.creative.partial, aspectRatio })
          setRefreshToken((current) => current + 1)
          void refreshMe()
          return
        }
        if (task.status === 'FAILED' || task.status === 'CANCELLED' || task.status === 'EXPIRED') {
          stop()
          const rawMessage = task.error || (task.status === 'CANCELLED' ? t.creative.cancelled : t.ws.failed)
          const message = /no available compatible accounts|no available OpenAI accounts supporting model|pool=0/i.test(rawMessage)
            ? t.ws.noCompatibleAccounts
            : rawMessage
          updateSlotRange(slotStart, expectedCount, () => ({ status: 'error', error: message, aspectRatio }))
          setRefreshToken((current) => current + 1)
          void refreshMe()
        }
      } catch (pollError) {
        failures += 1
        if (failures >= 3) {
          stop()
          setCurrentCloudTasks((current) => current.filter((task) => task.id !== id))
          handleError(pollError, slotStart)
        }
      } finally {
        running = false
      }
    }
    interval = setInterval(() => void tick(), POLL_MS)
    pollers.current.push(interval)
    void tick()
    return interval
  }

  async function retryCreative(jobId: string) {
    setError('')
    pollers.current.forEach(clearInterval)
    pollers.current = []
    try {
      const result = await api.retryCreativeJob(jobId)
      const status = compatibleJobStatus(result.status)
      const expectedCount = Math.min(maxOutputs, Math.max(1, Number(result.parameters.count || 1)))
      const aspectRatio = imageAspectRatioValue(result.parameters.aspect_ratio)
      setParentJobId(null)
      activityJobIdRef.current = result.id
      setActivityJobId(result.id)
      setActivityStatus(status)
      setSlots(Array.from({ length: expectedCount }, () => ({ status: 'pending', aspectRatio })))
      setCurrentCloudTasks([{ id: result.id, status, model: model.name, prompt: result.prompt, type: 'image', resultUrls: result.result_urls, expectedCount, slotIndex: 0, aspectRatio }])
      setRefreshToken((current) => current + 1)
      pollCreative(result.id, expectedCount, 0, aspectRatio, result.prompt)
    } catch (retryError) {
      const rawMessage = retryError instanceof ApiError ? retryError.message : t.ws.failed
      const message = retryError instanceof ApiError && retryError.status === 401
        ? t.connect.needKey
        : retryError instanceof ApiError && retryError.status === 402
          ? t.connect.lowCredits
          : retryError instanceof ApiError && retryError.status === 502
            ? t.ws.upstreamUnavailable
            : /no available compatible accounts|no available OpenAI accounts supporting model|pool=0/i.test(rawMessage)
              ? t.ws.noCompatibleAccounts
              : rawMessage
      setError(message)
      if (retryError instanceof ApiError && retryError.status === 401) void refreshMe().then(() => onNeedConnect())
      throw retryError
    }
  }

  async function runCloudBatch(promptOverride: string, cloudTasks: CloudTask[], idempotencyKey: string, requestBody: Record<string, unknown>) {
    await Promise.all(cloudTasks.map((task, index) => runOne(index, promptOverride, task.id, idempotencyKey, requestBody)))
  }

  async function runLocal(index: number, generationId: number, promptSnapshot: string) {
    const size = LOCAL_IMAGE_SIZE
    setLocalInProgressPrompt(promptSnapshot)
    setLocalInProgressAspectRatio(size.width / size.height)
    try {
      const result = await generateLocalImage(
        { prompt: promptSnapshot, ...size },
        (progress: LocalProgress) => {
          if (localGenerationId.current !== generationId) return
          const progressLabel =
            progress.phase === 'queued'
              ? `${t.local.queued}${progress.position > 0 ? ` #${progress.position}` : ''}`
              : t.local.running
          if (progress.phase !== 'done') {
            setSlot(index, {
              status: 'pending',
              progress: progressLabel,
              aspectRatio: size.width / size.height,
            })
          }
        }
      )
      if (localGenerationId.current !== generationId) {
        URL.revokeObjectURL(result.objectUrl)
        return
      }
      localObjectUrls.current.add(result.objectUrl)
      setSlot(index, {
        status: 'done',
        url: result.objectUrl,
        seed: result.seed,
        aspectRatio: size.width / size.height,
      })
      // 搿滌滑 靸濎劚氍检潉 IndexedDB鞐?氤挫〈 鈥?靸堧瓿犾龚 頉勳棎霃?頌堨姢韱犽Μ 攴鸽Μ霌滌棎 雮姅雼?
      void saveLocalGeneration(
        { id: globalThis.crypto.randomUUID(), prompt: promptSnapshot, width: size.width, height: size.height, seed: result.seed, createdAt: Date.now() },
        result.blob
      )
      setLocalInProgressPrompt('')
      setLocalInProgressAspectRatio(undefined)
      setRefreshToken((prev) => prev + 1)
    } catch (e) {
      if (localGenerationId.current !== generationId) return
      setSlot(index, {
        status: 'error',
        error: e instanceof Error ? e.message : t.ws.failed,
        aspectRatio: size.width / size.height,
      })
      setLocalInProgressPrompt('')
      setLocalInProgressAspectRatio(undefined)
      void refreshLocal()
    }
  }

  function poll(id: string, index: number, promptSnapshot = prompt) {
    return new Promise<void>((resolve) => {
      let n = 0
      let settled = false
      const settle = () => {
        if (settled) return false
        settled = true
        clearInterval(iv)
        pollers.current = pollers.current.filter((poller) => poller !== iv)
        resolve()
        return true
      }
      const iv = setInterval(async () => {
        n += 1
        if (n > MAX_POLLS) {
          settle()
          setCurrentCloudTasks((prev) => prev.filter((task) => task.id !== id))
          setSlot(index, { status: 'error', error: t.ws.failed })
          return
        }
        let task: Task
        try {
          task = await api.task(id, isVideo ? 'video' : 'image')
        } catch (e) {
          settle()
          setCurrentCloudTasks((prev) => prev.filter((task) => task.id !== id))
          handleError(e, index)
          return
        }
        const urls = task.result_urls?.length ? task.result_urls : task.result_url ? [task.result_url] : []
        if (task.status === 'COMPLETED' || task.status === 'PARTIAL_SUCCESS') {
          settle()
          const firstUrl = urls[0]
          setSlot(index, firstUrl ? { status: 'done', url: firstUrl } : { status: 'error', error: t.creative.partial })
          if (firstUrl) await saveStudioHistory({ id: `${model.slug}-${id}-${index}`, type: isVideo ? 'video' : 'image', source: 'cloud', model: model.name, prompt: promptSnapshot, resultUrl: firstUrl, status: 'COMPLETED', createdAt: Date.now() }).catch(() => {})
          setCurrentCloudTasks((prev) => prev.filter((task) => task.id !== id))
          setRefreshToken((prev) => prev + 1)
          void refreshMe()
          return
        }
        if (task.status === 'FAILED' || task.status === 'CANCELLED' || task.status === 'EXPIRED') {
          settle()
          setCurrentCloudTasks((prev) => prev.filter((task) => task.id !== id))
          const message = task.error || (task.status === 'CANCELLED' ? t.creative.cancelled : task.status === 'EXPIRED' ? t.creative.expired : t.ws.failed)
          setSlot(index, { status: 'error', error: message })
          await saveStudioHistory({ id: `${model.slug}-${id}-${index}`, type: isVideo ? 'video' : 'image', source: 'cloud', model: model.name, prompt: promptSnapshot, status: 'FAILED', error: message, createdAt: Date.now() }).catch(() => {})
          void refreshMe()
        }
      }, POLL_MS)
      pollers.current.push(iv)
    })
  }

  function setSlot(index: number, value: Slot) {
    setSlots((prev) => prev.map((s, i) => (i === index ? value : s)))
  }

  function handleError(e: unknown, index: number) {
    if (e instanceof ApiError && e.status === 401 && e.code === 'AUTH_REQUIRED') {
      setSlot(index, { status: 'error', error: t.connect.needKey })
      void refreshMe().then(() => onNeedConnect())
      return
    }
    if (e instanceof ApiError && e.status === 402) {
      setError(t.connect.lowCredits)
      setSlot(index, { status: 'error', error: t.connect.lowCredits })
      return
    }
    if (e instanceof ApiError && e.status === 502) {
      setError(t.ws.upstreamUnavailable)
      setSlot(index, { status: 'error', error: t.ws.upstreamUnavailable })
      return
    }
    const rawMessage = e instanceof ApiError ? e.message : t.ws.failed
    const message = /no available compatible accounts|no available OpenAI accounts supporting model|pool=0/i.test(rawMessage)
      ? t.ws.noCompatibleAccounts
      : rawMessage
    if (/image generation is not enabled for this group/i.test(message)) {
      const reconnectMessage = t.ws.groupImageDisabled
      setError(reconnectMessage)
      setSlot(index, { status: 'error', error: reconnectMessage })
      void refreshMe().finally(() => onNeedConnect('reauth'))
      return
    }
    setError(message)
    setSlot(index, { status: 'error', error: message })
  }

  async function cancelCreativeTask(jobId: string) {
    const task = currentCloudTasks.find((item) => item.id === jobId)
    if (!task || !jobId.startsWith('job_')) return
    try {
      await api.cancelCreativeJob(jobId)
      setCurrentCloudTasks((current) => current.filter((item) => item.id !== jobId))
      setSlot(task.slotIndex ?? 0, { status: 'error', error: t.creative.cancelled, aspectRatio: task.aspectRatio })
      if (activityJobIdRef.current === jobId) {
        const next = currentCloudTasks.find((item) => item.id !== jobId && ['PENDING', 'IN_QUEUE', 'IN_PROGRESS', 'CANCEL_REQUESTED'].includes(item.status))
        activityJobIdRef.current = next?.id ?? ''
        setActivityJobId(next?.id ?? '')
        setActivityStatus(next?.status ?? 'PENDING')
      }
      setRefreshToken((current) => current + 1)
    } catch (cancelError) {
      setError(cancelError instanceof ApiError ? cancelError.message : t.ws.failed)
      throw cancelError
    }
  }

  function generate(promptOverride?: string) {
    const nextPrompt = (promptOverride ?? prompt).trim()
    if (!local && !connected) return onNeedConnect()
    if (!nextPrompt || busy) return
    if (needsImage && !imageUrls.length) { setError(t.ws.referenceImageRequired); return }
    if (needsVideo && !videoUrl) { setError(t.ws.referenceVideoRequired); return }
    const requestBody = buildBody(nextPrompt)
    setError('')
    setPrompt('')
    setActivityJobId('')
    activityJobIdRef.current = ''
    setActivityStatus('PENDING')
    pollers.current.forEach(clearInterval)
    pollers.current = []
    setCurrentCloudTasks([])
    const generationId = local ? localGenerationId.current + 1 : 0
    if (local) {
      localGenerationId.current = generationId
      for (const url of localObjectUrls.current) URL.revokeObjectURL(url)
      localObjectUrls.current.clear()
    }
    const requestedAspectRatio = imageAspectRatioValue(requestBody.aspectRatio ?? requestBody.aspect_ratio)
    setSlots(Array.from({ length: count }, () => ({ status: 'pending', aspectRatio: requestedAspectRatio })))
    const cloudTaskCount = count
    const cloudTasks: CloudTask[] = local ? [] : Array.from({ length: cloudTaskCount }, (_, index) => ({
      id: `pending-${Date.now()}-${index}`,
      status: 'PENDING',
      model: model.name,
      prompt: nextPrompt,
      type: isVideo ? 'video' : 'image',
      resultUrls: [],
      expectedCount: 1,
      slotIndex: index,
      aspectRatio: requestedAspectRatio,
    }))
    if (!local) {
      setCurrentCloudTasks(cloudTasks)
      setImageUrls([])
      setVideoUrl('')
      setParentJobId(null)
      setAttachmentMenuOpen(false)
    }
    if (local) {
      for (let i = 0; i < count; i++) void runLocal(i, generationId, nextPrompt)
    } else {
      void runCloudBatch(nextPrompt, cloudTasks, globalThis.crypto.randomUUID(), requestBody)
    }
  }

  useEffect(() => {
    if (connected) setError((current) => current === t.connect.needKey ? '' : current)
  }, [connected, t.connect.needKey])

  if (local && localState.status !== 'ready') {
    return <LocalFunnel onUseCloud={onUseCloud} />
  }

  const showGenerationNotice = busy || Boolean(generationError)
  const generationNotice = busy
    ? t.ws.generationProgress.replace('{count}', String(slots.length)).replace('{unit}', isVideo ? t.ws.videoCountUnit : t.ws.imageCountUnit).replace('{completed}', String(settledCount))
    : `${generationError}${failedCount > 1 ? ` (${failedCount} ${t.ws.failed})` : ''}`

  return (
    <div className="relative flex h-full w-full min-w-0 flex-col overflow-hidden">
      <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-4 pb-8 pt-8 sm:px-6 sm:pb-10">
        <HistoryGrid
          modelType={isVideo ? 'video' : 'image'}
          currentCloudTasks={currentCloudTasks}
          localInProgress={
            local && slots.some((slot) => slot.status === 'pending')
              ? { seed: 0, prompt: localInProgressPrompt, aspectRatio: localInProgressAspectRatio }
              : undefined
          }
          refreshToken={refreshToken}
          onRetry={creativeCore.enabled && !isVideo && !local && !busy ? retryCreative : undefined}
          onCancel={creativeCore.enabled && !isVideo && !local ? cancelCreativeTask : undefined}
          onRemoved={(jobId) => setCurrentCloudTasks((current) => current.filter((task) => task.id !== jobId))}
          onContinueEdit={model.capabilities?.image_edit ? ({ jobId, resultUrl }) => {
            setImageUrls([resultUrl])
            setParentJobId(jobId)
            setPrompt('')
            setSlots([])
            setError('')
            requestAnimationFrame(() => promptRef.current?.focus())
          } : undefined}
          empty={<EmptyState model={model} exs={exs} fallbackThumbs={BUILTIN_EXAMPLE_IMAGES} onUseExample={(examplePrompt) => generate(examplePrompt)} />}
        />
      </div>

      <div className="composer-dock pointer-events-none relative shrink-0 max-w-full px-3 pb-3 sm:px-4 sm:pb-5">
        {creativeCore.enabled && activityJobId && !isVideo && (
          <CreativeActivity
            jobId={activityJobId}
            status={activityStatus}
            onStatusChange={(status) => {
              setActivityStatus(status)
              setCurrentCloudTasks((current) => current.map((task) => task.id === activityJobId ? { ...task, status } : task))
            }}
          />
        )}
        {showGenerationNotice && (
          <div className="pointer-events-auto mx-auto mb-2 flex w-full max-w-5xl justify-center">
            <div
              data-testid="generation-notice"
              role={generationError && !busy ? 'alert' : 'status'}
              aria-live="polite"
              className={`flex min-h-8 max-w-full items-center gap-2 rounded-full border px-3 py-1.5 text-xs shadow-sm ${generationError && !busy ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/70 dark:bg-red-950/70 dark:text-red-200' : 'border-neutral-200 bg-white/95 text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900/95 dark:text-neutral-300'}`}
            >
              {busy && <span className="h-3.5 w-3.5 shrink-0 rounded-full border-2 border-current border-t-transparent animate-spin" />}
              <span className="truncate">{generationNotice}</span>
            </div>
          </div>
        )}
        <div className="composer-shell pointer-events-auto mx-auto w-full min-w-0 max-w-5xl">
          {canUploadImages && <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={doImageUpload} />}
          {hasVideoField && <input ref={videoRef} type="file" accept="video/*" hidden onChange={doVideoUpload} />}
          <div className="px-4 pt-3">
            <textarea
              ref={promptRef}
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value.slice(0, 2000))}
              onPaste={pasteReference}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  generate()
                }
              }}
              placeholder={t.ws.promptPlaceholder}
              className="min-h-20 w-full resize-none bg-transparent py-1 text-[15px] leading-6 outline-none placeholder:text-neutral-400"
            />
          </div>

          <div className="flex min-w-0 max-w-full items-center gap-2 px-3 pb-3 pt-2">
            <div className="flex shrink-0 items-center gap-1.5">
              {!local && (canUploadImages || hasVideoField) && (
                <div className="relative shrink-0">
                  <button type="button" onClick={() => setAttachmentMenuOpen((open) => !open)} disabled={uploading || uploadingVideo} title={t.ws.addAttachment} aria-label={t.ws.addAttachment} className="grid h-8 w-8 place-items-center rounded-full border border-transparent bg-transparent text-neutral-600 transition hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-50 dark:border-transparent dark:bg-transparent dark:hover:bg-neutral-800 dark:hover:text-white">
                    {uploading || uploadingVideo ? <span className="h-4 w-4 rounded-full border-2 border-current border-t-transparent animate-spin" /> : <IconPlus className="h-4 w-4" />}
                  </button>
                  {attachmentMenuOpen && (
                    <div className="absolute bottom-10 left-0 z-20 min-w-36 rounded-md border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-800 dark:bg-neutral-950">
                      {canUploadImages && <button type="button" onClick={() => { setAttachmentMenuOpen(false); fileRef.current?.click() }} className="flex h-9 w-full items-center gap-2 rounded px-2.5 text-left text-sm transition hover:bg-neutral-100 dark:hover:bg-neutral-900"><IconImage className="h-4 w-4" />{t.ws.uploadImage}</button>}
                      {hasVideoField && <button type="button" onClick={() => { setAttachmentMenuOpen(false); videoRef.current?.click() }} className="flex h-9 w-full items-center gap-2 rounded px-2.5 text-left text-sm transition hover:bg-neutral-100 dark:hover:bg-neutral-900"><IconVideo className="h-4 w-4" />{t.ws.uploadVideo}</button>}
                    </div>
                  )}
                </div>
              )}
              {!local && imageUrls.map((imageUrl, index) => (
                <div key={`${imageUrl.slice(0, 32)}-${index}`} data-testid="reference-image-preview" className="group/img relative grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-md border border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={thumbUrl(imageUrl, 128)} alt={`${t.ws.removeReferenceImage} ${index + 1}`} decoding="async" width={32} height={32} className="h-full w-full object-cover" />
                  <button type="button" onClick={() => setImageUrls((current) => current.filter((_, itemIndex) => itemIndex !== index))} className="absolute inset-0 grid place-items-center bg-black/50 text-white opacity-0 transition group-hover/img:opacity-100 focus:opacity-100" aria-label={`${t.ws.removeReferenceImage} ${index + 1}`}>×</button>
                </div>
              ))}
              {hasVideoField && videoUrl && (
              <div className="group/vid relative grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-md border border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900">
                <video src={videoUrl} className="h-full w-full object-cover" muted playsInline />
                <button type="button" onClick={() => setVideoUrl('')} className="absolute inset-0 grid place-items-center bg-black/50 text-white opacity-0 transition group-hover/vid:opacity-100" aria-label={t.ws.removeReferenceVideo}>×</button>
              </div>
              )}
            </div>

            <div className="flex min-w-0 flex-1 items-center justify-start gap-1 overflow-x-auto [scrollbar-width:none] sm:justify-end [&::-webkit-scrollbar]:hidden">
              <button
              type="button"
              onClick={onOpenPicker}
              className="composer-control"
            >
              <ModelLogo model={model} size={16} />
              <span className="max-w-28 truncate sm:max-w-40">{model.name}</span>
              <IconChevronDown className="h-3 w-3 text-neutral-400" />
            </button>

              {controlFields.map((f, i) =>
              f.type === 'toggle' ? (
                <button
                  key={i}
                  onClick={() => setValues((v) => ({ ...v, toggle: !v.toggle }))}
                  data-active={!!values.toggle}
                   className="composer-control"
                >
                  {values.toggle ? t.ws.audioOn : t.ws.audioOff}
                </button>
              ) : (
                <FieldSelect
                  key={i}
                  field={f}
                  value={values[f.type]}
                  onChange={(val) => setValues((v) => ({ ...v, [f.type]: val }))}
                />
              )
            )}

              {creativeCore.enabled && !isVideo && !local && (
                <ComposerSelect
                  value={analysisMode}
                  options={['standard', 'deep']}
                  ariaLabel={t.creative.analysis}
                  getLabel={(option) => `${t.creative.analysis} · ${option === 'deep' ? t.creative.deep : t.creative.standard}`}
                  onChange={(option) => setAnalysisMode(option as CreativeAnalysisMode)}
                />
              )}

              {!isVideo && <div className="flex h-8 shrink-0 items-center overflow-hidden rounded-full border border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950">
              <button type="button" onClick={() => setCount((c) => Math.max(1, c - 1))} disabled={count === 1 || busy} title={t.ws.decreaseCount} aria-label={t.ws.decreaseCount} className="grid h-full w-7 place-items-center text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-25 dark:hover:bg-neutral-800 dark:hover:text-white"><IconMinus className="h-3 w-3" /></button>
              <span className="min-w-10 px-1 text-center text-xs font-medium tabular-nums">{count} {t.ws.imageCountUnit}</span>
              <button type="button" onClick={() => setCount((c) => Math.min(maxOutputs, c + 1))} disabled={count === maxOutputs || busy} title={t.ws.increaseCount} aria-label={t.ws.increaseCount} className="grid h-full w-7 place-items-center text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-25 dark:hover:bg-neutral-800 dark:hover:text-white"><IconPlus className="h-3 w-3" /></button>
              </div>}
              {!busy && (local || cost != null) && <span className="px-1 text-[11px] font-medium text-neutral-400">{local ? t.local.free : cost}</span>}
            </div>
            <button type="button" onClick={() => generate()} disabled={busy || !prompt.trim()} title={busy ? `${t.ws.generating} ${settledCount}/${slots.length}` : t.ws.generate} aria-label={busy ? t.ws.generating : t.ws.generate} className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-neutral-900 text-white transition hover:bg-neutral-700 disabled:cursor-not-allowed disabled:bg-neutral-300 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200 dark:disabled:bg-neutral-700">
              {busy ? <span className="h-4 w-4 rounded-full border-2 border-current border-t-transparent animate-spin" /> : <IconArrowUp className="h-4 w-4" />}
            </button>
          </div>
          {asksForMultipleImages && !busy && !generationError && slots.length === 0 && (
            <p role="note" className="border-t border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-700 dark:border-amber-950 dark:bg-amber-950/20 dark:text-amber-300">{t.ws.multipleImageHint}</p>
          )}
        </div>
      </div>
    </div>
  )
}

function FieldSelect({
  field,
  value,
  onChange,
}: {
  field: FormField
  value: string | number | boolean | undefined
  onChange: (v: string | number) => void
}) {
  const { t } = useI18n()
  const opts = field.options ?? []
  if (!opts.length) return null
  const isNum = typeof opts[0] === 'number'
  const cur = value ?? field.default ?? opts[0] ?? ''
  return (
    <ComposerSelect
      value={String(cur)}
      options={opts.map(String)}
      ariaLabel={fieldLabel(field.type, t)}
      getLabel={(option) => fieldOptionLabel(field.type, isNum ? Number(option) : option, t)}
      onChange={(option) => onChange(isNum ? Number(option) : option)}
    />
  )
}

function fieldLabel(type: string, t: Dict) {
  const labels: Record<string, string> = {
    quality: t.ws.quality,
    aspect_ratio: t.ws.ratio,
    resolution: t.ws.resolution,
    duration: t.ws.duration,
    tier: t.ws.mode,
  }
  return labels[type] ?? type
}

function fieldOptionLabel(type: string, value: string | number, t: Dict) {
  const label = fieldLabel(type, t)
  const quality: Record<string, string> = { low: t.ws.low, medium: t.ws.medium, high: t.ws.high }
  const display = type === 'duration' ? `${value}s` : type === 'quality' ? (quality[String(value)] ?? String(value)) : String(value)
  return label ? `${label} · ${display}` : display
}

function MediaTile({ url, kind, className = '' }: { url: string; kind: 'image' | 'video'; className?: string }) {
  return kind === 'video' ? (
    <video src={mediaUrl(url)} className={`w-full h-full object-cover ${className}`} muted loop playsInline autoPlay preload="metadata" />
  ) : (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={thumbUrl(url, 1024)} alt="" loading="lazy" decoding="async" className={`w-full h-full object-cover ${className}`} />
  )
}

function EmptyState({
  model,
  exs,
  fallbackThumbs,
  onUseExample,
}: {
  model: Model
  exs: Example[]
  fallbackThumbs: string[]
  onUseExample: (prompt: string) => void
}) {
  const { t } = useI18n()
  const relevantExamples = exs.filter((item) => item.output_type === model.type)
  const examples = model.type === 'image'
    ? fallbackThumbs.map((fallbackImage, index) => {
        return {
          id: `sample-${index + 1}`,
          prompt: t.ws.exampleFallbacks[index] || t.ws.inspiration,
          image: fallbackImage,
          type: 'image' as const,
        }
      })
    : relevantExamples.map((item) => ({
        id: item.id,
        prompt: item.prompt || t.ws.inspiration,
        image: item.thumbnail || item.output,
        type: item.output_type,
      }))

  return (
    <div className="mx-auto w-full min-w-0 max-w-5xl pb-12 pt-5">
      <div className="flex min-w-0 items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-neutral-400">Cinlan Studio</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-[-0.04em] sm:text-3xl">{model.type === 'video' ? t.ws.createVideo : t.ws.createImage}</h2>
          <p className="mt-2 max-w-xl text-sm leading-6 text-neutral-500">{t.ws.canvasHint}</p>
        </div>
        <div className="hidden rounded-full px-3 py-1.5 text-xs text-neutral-500 sm:block">{t.ws.examplePrompts}</div>
      </div>

      <div className="mt-8">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">{t.ws.inspiration}</h3>
          <span className="text-xs text-neutral-400">{t.ws.clickToGenerate}</span>
        </div>
        <div className="flex w-full max-w-full snap-x gap-4 overflow-x-auto pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {examples.map((example, index) => (
            <button
              key={example.id}
              type="button"
              onClick={() => onUseExample(example.prompt)}
              className="group relative flex w-[246px] shrink-0 snap-start flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white text-left transition hover:-translate-y-0.5 hover:border-neutral-400 hover:shadow-lg hover:shadow-neutral-900/[0.08] dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-neutral-600"
            >
              <div className={`relative aspect-[4/3] overflow-hidden bg-gradient-to-br ${gradientFor(example.prompt + index)}`}>
                {example.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={example.image} alt="" loading="lazy" decoding="async" width={640} height={480} className="h-full w-full object-cover transition duration-500 group-hover:scale-105" />
                ) : <div className="absolute inset-0 grid place-items-center px-6 text-center text-sm font-medium text-white/90">{example.prompt.slice(0, 22)}…</div>}
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/45 to-transparent p-3 pt-10">
                  <span className="rounded-full bg-white/85 px-2 py-1 text-[10px] font-semibold text-neutral-900">{t.ws.useExample}</span>
                </div>
              </div>
              <p className="line-clamp-3 min-h-[70px] px-4 py-3 text-sm leading-5 text-neutral-700 dark:text-neutral-200">{example.prompt}</p>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function ResultTile({ slot, model, hint }: { slot: Slot; model: Model; hint: string }) {
  const { t } = useI18n()
  return (
            <div
      className={`relative ${slot.aspectRatio ? '' : 'aspect-square'} rounded-2xl overflow-hidden border border-neutral-200 dark:border-neutral-800 ${slot.url ? 'bg-neutral-100 dark:bg-neutral-950' : `grain bg-gradient-to-br ${gradientFor(model.name)} opacity-90 dark:opacity-30`}`}
      style={slot.aspectRatio ? { aspectRatio: slot.aspectRatio } : undefined}
    >
      {slot.status === 'done' && slot.url ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={thumbUrl(slot.url, 1024)} alt="" loading="lazy" decoding="async" width={1024} height={1024} className="w-full h-full object-cover" />
          {slot.seed !== undefined && (
            <a
              href={slot.url}
              download={`cinlan-local-${slot.seed}.png`}
              className="absolute right-3 bottom-3 flex items-center gap-2 rounded-xl bg-white/90 dark:bg-neutral-900/90 px-3 py-2 text-xs font-semibold text-neutral-900 dark:text-white shadow-lg ring-1 ring-black/5 dark:ring-white/10 backdrop-blur hover:bg-white dark:hover:bg-neutral-900 transition"
            >
              <IconDownload className="w-4 h-4" />
              {t.local.download}
            </a>
          )}
        </>
      ) : (
        <div className="absolute inset-0 grid place-items-center">
          {slot.status === 'error' ? (
            <span className="px-3 text-xs text-red-600 text-center">{slot.error}</span>
          ) : (
            <div className="flex flex-col items-center gap-2 text-neutral-600/70 dark:text-neutral-400/70">
              <span className="w-5 h-5 rounded-full border-2 border-current border-t-transparent animate-spin" />
              <span className="text-xs">{hint}...</span>
              {slot.progress && (
                <span className="relative block w-24 h-1 overflow-hidden rounded-full bg-neutral-900/10 dark:bg-white/10">
                  <span className="anim-prog absolute inset-y-0 left-0 rounded-full bg-current" />
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

