import { mediaTaskDetails, resultError, resultUrls } from '../generation'
import { newRequestId, Sub2ApiError, sub2apiFetch } from '../sub2api'

export interface ProviderReference {
  bytes: Uint8Array
  mime: string
  filename: string
  role: 'input' | 'mask'
}

const RESOLUTION_MAX_EDGE: Record<string, number> = { '1K': 1024, '2K': 2048, '4K': 3840 }

export function sizeForResolution(aspectRatio: string, resolution: string, requested?: { width: number; height: number }) {
  if (requested?.width && requested.height) return `${requested.width}x${requested.height}`
  const maxEdge = RESOLUTION_MAX_EDGE[resolution.toUpperCase()]
  const parts = aspectRatio.split(':').map(Number)
  if (!maxEdge || parts.length !== 2 || !parts.every((value) => Number.isFinite(value) && value > 0)) return undefined
  const [ratioWidth, ratioHeight] = parts
  const round = (value: number) => Math.max(8, Math.round(value / 8) * 8)
  return ratioWidth >= ratioHeight
    ? `${maxEdge}x${round(maxEdge * ratioHeight / ratioWidth)}`
    : `${round(maxEdge * ratioWidth / ratioHeight)}x${maxEdge}`
}

function legacyEditPrompt(prompt: string, referenceCount: number, transparentBackground: boolean) {
  return [
    referenceCount > 1
      ? 'Use every attached image as visual input. Treat the first image as the primary composition and the remaining images as supporting identity, style, subject, or material references.'
      : 'Use the attached image as the primary visual reference.',
    'Follow the user instruction precisely while preserving recognizable identity and key visual elements unless the instruction explicitly asks to replace them.',
    transparentBackground
      ? 'Render the background with real alpha transparency. Never draw a checkerboard, gray-and-white grid, or simulated transparency pattern into the image.'
      : '',
    'Return one coherent, standalone finished image. Do not draw model names, comparison grids, UI chrome, or explanatory labels unless the user explicitly asks for those elements to appear in the image.',
    `User instruction: ${prompt}`,
  ].filter(Boolean).join('\n\n')
}

function editForm(input: {
  model: string
  prompt: string
  count: number
  parameters: Record<string, unknown>
  references: ProviderReference[]
  compiled: boolean
  stream?: boolean
}) {
  const images = input.references.filter((reference) => reference.role === 'input')
  const mask = input.references.find((reference) => reference.role === 'mask')
  const form = new FormData()
  form.append('model', input.model)
  form.append('prompt', input.compiled ? input.prompt : legacyEditPrompt(input.prompt, images.length, String(input.parameters.background || '').toLowerCase() === 'transparent'))
  if (input.count > 1) form.append('n', String(input.count))
  for (const key of ['quality', 'size', 'background', 'output_format', 'output_compression', 'input_fidelity']) {
    if (input.parameters[key] !== undefined && input.parameters[key] !== '') form.append(key, String(input.parameters[key]))
  }
  if (input.stream) {
    form.append('stream', 'true')
    form.append('partial_images', '1')
  }
  for (const reference of images) {
    const copy = new Uint8Array(reference.bytes)
    form.append(images.length > 1 ? 'image[]' : 'image', new Blob([copy], { type: reference.mime }), reference.filename)
  }
  if (mask) {
    const copy = new Uint8Array(mask.bytes)
    form.append('mask', new Blob([copy], { type: mask.mime }), mask.filename)
  }
  return form
}

function retryableGroupError(error: unknown) {
  return error instanceof Sub2ApiError && /image generation is not enabled for this group/i.test(error.message)
}

export function transparentBackgroundUnsupported(error: unknown) {
  return error instanceof Sub2ApiError && /transparent background is not supported|background.*transparent.*not supported/i.test(error.message)
}

export function shouldFallbackToSynchronousImageEndpoint(error: unknown) {
  return (error instanceof Sub2ApiError && [404, 405, 501, 502, 503, 504].includes(error.status))
    || (error instanceof DOMException && error.name === 'TimeoutError')
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
}

export async function requestProviderImage(input: {
  apiKey: string
  model: string
  prompt: string
  count: number
  parameters: Record<string, unknown>
  references: ProviderReference[]
  idempotencyKey: string
  compiled?: boolean
  signal?: AbortSignal
}) {
  const parameters = { ...input.parameters }
  const aspectRatio = String(parameters.aspect_ratio ?? parameters.aspectRatio ?? '')
  const resolution = String(parameters.resolution ?? '')
  if (/^gpt-image-/i.test(input.model)) {
    const requestedWidth = Number(parameters.requested_width || 0)
    const requestedHeight = Number(parameters.requested_height || 0)
    const requested = requestedWidth > 0 && requestedHeight > 0 ? { width: requestedWidth, height: requestedHeight } : undefined
    if (!parameters.size) parameters.size = aspectRatio ? sizeForResolution(aspectRatio, resolution || '1K', requested) : 'auto'
    const outputFormat = String(parameters.output_format || '').toLowerCase()
    const background = String(parameters.background || '').toLowerCase()
    if (!outputFormat && background === 'transparent') parameters.output_format = 'png'
    delete parameters.aspect_ratio
    delete parameters.aspectRatio
  }
  delete parameters.resolution
  delete parameters.requested_width
  delete parameters.requested_height
  delete parameters.analysis_mode
  delete parameters.parent_job_id
  delete parameters.idempotency_key
  delete parameters.count

  async function send(requestParameters: Record<string, unknown>, requestPrompt: string, idempotencyKey: string) {
    const headers = { 'Idempotency-Key': idempotencyKey }
    if (input.references.some((reference) => reference.role === 'input')) {
      try {
        return await sub2apiFetch<unknown>('/v1/images/edits/async', {
          apiKey: input.apiKey,
          method: 'POST',
          headers,
          body: editForm({ ...input, prompt: requestPrompt, parameters: requestParameters, stream: false, compiled: input.compiled ?? false }),
          signal: requestSignal(input.signal, 45_000),
        })
      } catch (error) {
        if (!shouldFallbackToSynchronousImageEndpoint(error)) throw error
        return sub2apiFetch<unknown>('/v1/images/edits', {
          apiKey: input.apiKey,
          method: 'POST',
          headers: { ...headers, Accept: 'text/event-stream' },
          body: editForm({ ...input, prompt: requestPrompt, parameters: requestParameters, stream: true, compiled: input.compiled ?? false }),
          signal: requestSignal(input.signal, 240_000),
        })
      }
    }

    const body = {
      ...requestParameters,
      model: input.model,
      prompt: requestPrompt,
      ...(input.count > 1 ? { n: input.count } : {}),
    }
    try {
      return await sub2apiFetch<unknown>('/v1/images/generations/async', { apiKey: input.apiKey, method: 'POST', headers, body: JSON.stringify(body), signal: requestSignal(input.signal, 45_000) })
    } catch (error) {
      if (!shouldFallbackToSynchronousImageEndpoint(error)) throw error
      return sub2apiFetch<unknown>('/v1/images/generations', { apiKey: input.apiKey, method: 'POST', headers, body: JSON.stringify(body), signal: requestSignal(input.signal, 240_000) })
    }
  }

  let payload: unknown
  try {
    payload = await send(parameters, input.prompt, input.idempotencyKey)
  } catch (error) {
    if (!retryableGroupError(error)) throw error
    await new Promise((resolve) => setTimeout(resolve, 800))
    payload = await send(parameters, input.prompt, input.idempotencyKey)
  }
  const value = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const id = String(value.id ?? value.task_id ?? value.request_id ?? '')
  const urls = resultUrls(payload)
  if (urls.length) return { ...mediaTaskDetails(payload, id || newRequestId('image'), 'image'), status: 'COMPLETED' as const, result_urls: urls }
  if (id) return { ...mediaTaskDetails(payload, id, 'image'), status: 'IN_PROGRESS' as const, result_urls: [] }
  const upstreamError = resultError(payload)
  throw new Sub2ApiError(502, upstreamError || 'Image provider returned neither a task ID nor an image result', 'INVALID_PROVIDER_RESPONSE', payload)
}
