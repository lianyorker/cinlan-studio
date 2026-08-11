/**
 * ComfyUI 로컬 런타임 클라이언트
 *
 * 시그니처는 컨트랙트다. UI(components/*)는 이 시그니처에만 의존한다.
 * 구현 규칙:
 * - fetch 타임아웃 짧게 (헬스 1.5s) — localhost 부재 시 UI가 빨리 offline 판정해야 함
 * - /system_stats 로 VRAM/디바이스, /object_info 의 UNETLoader 옵션으로 모델 파일 존재 확인
 * - 생성: POST /prompt (API 그래프) → GET /history/{id} 폴링 → /view 이미지 blob
 */

import type {
  LocalGenerateParams,
  LocalGenerateResult,
  LocalProgress,
  LocalState,
} from './types'
import { APPLE_MIN_UNIFIED_GB, BF16_VRAM_GB, LOCAL_RUNTIME_URL, MIN_VRAM_GB, ZIMAGE_FILES } from './types'
import { probeHardwareHint } from './hardware'

type JsonObject = Record<string, unknown>

interface ModelFiles {
  unet: string
  textEncoder: string
  /** mps는 GGUF 전용 로더 사용 */
  unetLoaderClass: 'UNETLoader' | 'UnetLoaderGGUF'
  clipLoaderClass: 'CLIPLoader' | 'CLIPLoaderGGUF'
}

interface DeviceInfo {
  name?: unknown
  type?: unknown
  vram_total?: unknown
}

const POLL_INTERVAL_MS = 1_000
const MAX_POLL_COUNT = 300

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`
}

async function fetchJson(baseUrl: string, path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(joinUrl(baseUrl, path), init)
  const data: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = getErrorMessage(data) || response.statusText || `HTTP ${response.status}`
    throw new Error(`ComfyUI request failed: ${message}`)
  }
  return data
}

function getLoaderOptions(data: unknown, loaderName: string, inputName: string): string[] {
  const root = asObject(data)
  const loader = asObject(root?.[loaderName]) ?? root
  const input = asObject(loader?.input)
  const required = asObject(input?.required)
  const descriptor = required?.[inputName]

  if (!Array.isArray(descriptor)) return []
  const options = Array.isArray(descriptor[0]) ? descriptor[0] : descriptor
  return options.filter((option): option is string => typeof option === 'string')
}

function findModelFile(options: string[], filename: string): string | null {
  return (
    options.find(
      (option) =>
        option === filename || option.endsWith(`/${filename}`) || option.endsWith(`\\${filename}`)
    ) ?? null
  )
}

function chooseModelFiles(
  options: { unet: string[]; unetGguf: string[]; textEncoder: string[]; clipGguf: string[] },
  backend: string | null,
  vramGB: number | null
): ModelFiles | null {
  const textEncoderBf16 = findModelFile(options.textEncoder, ZIMAGE_FILES.textEncoderBf16)
  const textEncoderFp8 = findModelFile(options.textEncoder, ZIMAGE_FILES.textEncoderFp8)

  // Apple(MPS): int8 커널 부재 + bf16 메모리 압박 → 풀 GGUF (실측 136s/장, 상주 ~10GB)
  if (backend === 'mps') {
    const unetGguf = findModelFile(options.unetGguf, ZIMAGE_FILES.unetGguf)
    if (!unetGguf) return null
    // TE도 GGUF 우선(4GB, 품질 손실 없음 실측) — 없으면 bf16 safetensors 폴백
    const textEncoderGguf = findModelFile(options.clipGguf, ZIMAGE_FILES.textEncoderGguf)
    if (textEncoderGguf) {
      return { unet: unetGguf, textEncoder: textEncoderGguf, unetLoaderClass: 'UnetLoaderGGUF', clipLoaderClass: 'CLIPLoaderGGUF' }
    }
    return textEncoderBf16
      ? { unet: unetGguf, textEncoder: textEncoderBf16, unetLoaderClass: 'UnetLoaderGGUF', clipLoaderClass: 'CLIPLoader' }
      : null
  }

  const preferBf16 = vramGB !== null && vramGB >= BF16_VRAM_GB
  const unetBf16 = findModelFile(options.unet, ZIMAGE_FILES.unetBf16)
  const unetInt8 = findModelFile(options.unet, ZIMAGE_FILES.unetInt8)
  const unet = preferBf16 ? unetBf16 ?? unetInt8 : unetInt8 ?? unetBf16
  if (!unet) return null

  const textEncoder =
    unet === unetInt8
      ? textEncoderFp8 ?? textEncoderBf16
      : textEncoderBf16 ?? textEncoderFp8

  return textEncoder ? { unet, textEncoder, unetLoaderClass: 'UNETLoader', clipLoaderClass: 'CLIPLoader' } : null
}

function getDevices(data: unknown): DeviceInfo[] {
  const devices = asObject(data)?.devices
  if (!Array.isArray(devices)) return []
  return devices.filter((device): device is DeviceInfo => asObject(device) !== null)
}

function normalizeBackend(device: DeviceInfo | undefined): string | null {
  const type = typeof device?.type === 'string' ? device.type.toLowerCase() : ''
  const name = typeof device?.name === 'string' ? device.name.toLowerCase() : ''
  const description = `${type} ${name}`

  if (description.includes('cuda')) return 'cuda'
  if (description.includes('mps')) return 'mps'
  if (description.includes('cpu')) return 'cpu'
  return type || null
}

function selectDevice(data: unknown): DeviceInfo | undefined {
  const devices = getDevices(data)
  return (
    devices.find((device) => normalizeBackend(device) === 'cuda') ??
    devices.find((device) => normalizeBackend(device) === 'mps') ??
    devices[0]
  )
}

function getVramGB(device: DeviceInfo | undefined): number | null {
  if (typeof device?.vram_total !== 'number' || !Number.isFinite(device.vram_total)) return null
  return Math.round((device.vram_total / 2 ** 30) * 10) / 10
}

function getComfyVersion(data: unknown): string | null {
  const root = asObject(data)
  const system = asObject(root?.system)
  const version = system?.comfyui_version ?? root?.comfyui_version
  return typeof version === 'string' ? version : null
}

async function getModelOptions(baseUrl: string): Promise<{
  unet: string[]
  unetGguf: string[]
  textEncoder: string[]
  clipGguf: string[]
}> {
  const [unetInfo, clipInfo, ggufInfo, clipGgufInfo] = await Promise.all([
    fetchJson(baseUrl, '/object_info/UNETLoader'),
    fetchJson(baseUrl, '/object_info/CLIPLoader'),
    // ComfyUI-GGUF 커스텀 노드가 없으면 404 — 빈 목록으로 처리
    fetchJson(baseUrl, '/object_info/UnetLoaderGGUF').catch(() => null),
    fetchJson(baseUrl, '/object_info/CLIPLoaderGGUF').catch(() => null),
  ])
  return {
    unet: getLoaderOptions(unetInfo, 'UNETLoader', 'unet_name'),
    unetGguf: getLoaderOptions(ggufInfo, 'UnetLoaderGGUF', 'unet_name'),
    textEncoder: getLoaderOptions(clipInfo, 'CLIPLoader', 'clip_name'),
    clipGguf: getLoaderOptions(clipGgufInfo, 'CLIPLoaderGGUF', 'clip_name'),
  }
}

function randomUint32(): number {
  const values = new Uint32Array(1)
  globalThis.crypto.getRandomValues(values)
  return values[0]
}

function createClientId(): string {
  return typeof globalThis.crypto.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${randomUint32().toString(36)}`
}

function getErrorMessage(value: unknown): string | null {
  if (typeof value === 'string') return value

  const object = asObject(value)
  if (!object) return null

  for (const key of ['exception_message', 'message', 'details', 'error']) {
    const candidate = object[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate
    const nested = asObject(candidate)
    if (nested) {
      const nestedMessage = getErrorMessage(nested)
      if (nestedMessage) return nestedMessage
    }
  }
  return null
}

function getExecutionError(entry: JsonObject): string | null {
  const directError = getErrorMessage(entry.error) ?? getErrorMessage(entry.exception_message)
  if (directError) return directError

  const status = asObject(entry.status)
  const messages = status?.messages ?? entry.messages

  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!Array.isArray(message) || message[0] !== 'execution_error') continue
      return getErrorMessage(message[1]) || 'ComfyUI execution failed'
    }
  }

  return status?.status_str === 'error' || entry.status_str === 'error'
    ? getErrorMessage(status ?? entry) || 'ComfyUI execution failed'
    : null
}

function getHistoryEntry(data: unknown, promptId: string): JsonObject | null {
  const history = asObject(data)
  if (!history) return null
  return asObject(history[promptId]) ?? asObject(Object.values(history)[0])
}

function getFirstImage(outputs: JsonObject): JsonObject | null {
  for (const output of Object.values(outputs)) {
    const images = asObject(output)?.images
    if (!Array.isArray(images)) continue
    const image = images.find((candidate) => asObject(candidate) !== null)
    if (image) return image as JsonObject
  }
  return null
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 런타임 상태 종합 판정 (offline/insufficient/model_missing/ready) */
export async function detectLocalRuntime(): Promise<LocalState> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1_500)
  let stats: unknown

  try {
    stats = await fetchJson(LOCAL_RUNTIME_URL, '/system_stats', { signal: controller.signal })
  } catch {
    return {
      status: 'offline',
      hint: await probeHardwareHint(),
      system: null,
      unetFile: null,
    }
  } finally {
    clearTimeout(timeout)
  }

  const device = selectDevice(stats)
  const backend = normalizeBackend(device)
  const vramGB = getVramGB(device)
  const system = {
    gpuName: typeof device?.name === 'string' ? device.name : null,
    vramGB,
    backend,
    comfyVersion: getComfyVersion(stats),
  }

  const insufficient =
    backend === 'cpu' ||
    (backend === 'cuda' && vramGB !== null && vramGB < MIN_VRAM_GB) ||
    // Apple은 GGUF 티어 상주 ~14GB — 24GB 미만 통합메모리는 스왑으로 비실용
    (backend === 'mps' && vramGB !== null && vramGB < APPLE_MIN_UNIFIED_GB)

  if (insufficient) {
    return { status: 'insufficient', hint: 'likely', system, unetFile: null }
  }

  let options: Awaited<ReturnType<typeof getModelOptions>>
  try {
    options = await getModelOptions(LOCAL_RUNTIME_URL)
  } catch {
    return { status: 'model_missing', hint: 'likely', system, unetFile: null }
  }

  const files = chooseModelFiles(options, backend, vramGB)
  if (!files) return { status: 'model_missing', hint: 'likely', system, unetFile: null }

  return { status: 'ready', hint: 'likely', system, unetFile: files.unet }
}

/** Z-Image Turbo 로컬 생성. onProgress는 폴링 중 큐 위치/실행 상태 통지 */
export async function generateLocalImage(
  params: LocalGenerateParams,
  onProgress?: (p: LocalProgress) => void
): Promise<LocalGenerateResult> {
  const startedAt = Date.now()
  const runtimeParams = params as LocalGenerateParams & { baseUrl?: string }
  const baseUrl = runtimeParams.baseUrl || LOCAL_RUNTIME_URL
  const [options, stats] = await Promise.all([
    getModelOptions(baseUrl),
    fetchJson(baseUrl, '/system_stats').catch(() => null),
  ])
  const device = selectDevice(stats)
  const backend = normalizeBackend(device)
  const vramGB = getVramGB(device)
  const files = chooseModelFiles(options, backend, vramGB)
  if (!files) throw new Error('Required Z-Image Turbo model files are missing in ComfyUI')

  const seed = params.seed ?? randomUint32()
  const graph = {
    '1': files.unetLoaderClass === 'UnetLoaderGGUF'
      ? { class_type: 'UnetLoaderGGUF', inputs: { unet_name: files.unet } }
      : { class_type: 'UNETLoader', inputs: { unet_name: files.unet, weight_dtype: 'default' } },
    '2': files.clipLoaderClass === 'CLIPLoaderGGUF'
      ? { class_type: 'CLIPLoaderGGUF', inputs: { clip_name: files.textEncoder, type: 'lumina2' } }
      : { class_type: 'CLIPLoader', inputs: { clip_name: files.textEncoder, type: 'lumina2', device: 'default' } },
    '3': {
      class_type: 'VAELoader',
      inputs: { vae_name: ZIMAGE_FILES.vae },
    },
    '4': {
      class_type: 'CLIPTextEncode',
      inputs: { text: params.prompt, clip: ['2', 0] },
    },
    '5': {
      class_type: 'ConditioningZeroOut',
      inputs: { conditioning: ['4', 0] },
    },
    '6': {
      class_type: 'EmptySD3LatentImage',
      inputs: { width: params.width, height: params.height, batch_size: 1 },
    },
    '7': {
      class_type: 'ModelSamplingAuraFlow',
      inputs: { shift: 3, model: ['1', 0] },
    },
    '8': {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps: params.steps ?? 8,
        cfg: params.cfg ?? 1,
        sampler_name: 'res_multistep',
        scheduler: 'simple',
        denoise: 1,
        model: ['7', 0],
        positive: ['4', 0],
        negative: ['5', 0],
        latent_image: ['6', 0],
      },
    },
    '9': {
      class_type: 'VAEDecode',
      inputs: { samples: ['8', 0], vae: ['3', 0] },
    },
    '10': {
      class_type: 'SaveImage',
      inputs: { images: ['9', 0], filename_prefix: 'cinlan-local' },
    },
  }

  const queued = await fetchJson(baseUrl, '/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: graph, client_id: createClientId() }),
  })
  const queueError = getErrorMessage(asObject(queued)?.error)
  if (queueError) throw new Error(`ComfyUI rejected the prompt: ${queueError}`)

  const promptId = asObject(queued)?.prompt_id
  if (typeof promptId !== 'string' || !promptId) {
    throw new Error('ComfyUI did not return a prompt ID')
  }

  const queueNumber = asObject(queued)?.number
  onProgress?.({ phase: 'queued', position: typeof queueNumber === 'number' ? queueNumber : 0 })

  let runningReported = false
  for (let poll = 0; poll < MAX_POLL_COUNT; poll += 1) {
    await wait(POLL_INTERVAL_MS)
    const history = await fetchJson(baseUrl, `/history/${encodeURIComponent(promptId)}`)
    const entry = getHistoryEntry(history, promptId)
    if (!entry) continue

    const executionError = getExecutionError(entry)
    if (executionError) throw new Error(`ComfyUI generation failed: ${executionError}`)

    const outputs = asObject(entry.outputs)
    if (!outputs || Object.keys(outputs).length === 0) {
      if (!runningReported) {
        runningReported = true
        onProgress?.({ phase: 'running' })
      }
      continue
    }

    const image = getFirstImage(outputs)
    if (!image) throw new Error('ComfyUI completed without an output image')

    const filename = image.filename
    if (typeof filename !== 'string' || !filename) {
      throw new Error('ComfyUI returned an invalid output image')
    }

    const query = new URLSearchParams({ filename })
    if (typeof image.subfolder === 'string') query.set('subfolder', image.subfolder)
    if (typeof image.type === 'string') query.set('type', image.type)

    const response = await fetch(joinUrl(baseUrl, `/view?${query.toString()}`))
    if (!response.ok) {
      throw new Error(`Failed to download ComfyUI output: ${response.statusText}`)
    }
    const blob = await response.blob()
    const objectUrl = URL.createObjectURL(blob)
    onProgress?.({ phase: 'done' })
    return { objectUrl, blob, seed, durationMs: Date.now() - startedAt }
  }

  throw new Error('ComfyUI generation timed out after 5 minutes')
}
