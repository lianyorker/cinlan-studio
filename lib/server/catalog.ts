import type { Model } from '@/lib/types'
import { modelCapabilitiesForSlug } from '@/lib/model-capabilities'

const IMAGE_QUALITY_FIELD = {
  type: 'quality',
  options: ['low', 'medium', 'high'],
  default: 'high',
}

const VIDEO_ASPECT_FIELD = {
  type: 'aspect_ratio',
  options: ['16:9', '9:16', '1:1'],
  default: '16:9',
}

const VIDEO_DURATION_FIELD = {
  type: 'duration',
  options: [5, 8, 10, 15],
  default: 8,
}

const REASONING_EFFORT_FIELD = {
  type: 'reasoning_effort',
  options: ['low', 'medium', 'high', 'xhigh'],
  default: 'xhigh',
}

const FALLBACK: Model[] = [
  { slug: 'gpt-image-2', name: 'GPT Image 2', type: 'image', creator: 'OpenAI', form_config: { fields: [IMAGE_QUALITY_FIELD] } },
  { slug: 'grok-imagine-image', name: 'Grok Imagine', type: 'image', creator: 'xAI' },
  { slug: 'grok-imagine-video', name: 'Grok Imagine Video', type: 'video', creator: 'xAI', form_config: { fields: [VIDEO_ASPECT_FIELD, VIDEO_DURATION_FIELD] } },
  { slug: 'gpt-4.1-mini', name: 'GPT-4.1 mini', type: 'text', creator: 'OpenAI' },
]

function classify(id: string): Model['type'] {
  const lower = id.toLowerCase()
  if (/(video|veo|sora|kling|seedance|hailuo|vidu|pixverse)/.test(lower)) return 'video'
  if (/(image|dall-e|imagen|nano-banana|grok-imagine)/.test(lower)) return 'image'
  return 'text'
}

function displayName(id: string) {
  return id
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function creatorFor(slug: string, type: Model['type']) {
  const lower = slug.toLowerCase()
  if (/^(gpt|chatgpt|o[134](?:-|$)|dall-e|sora)/.test(lower)) return 'OpenAI'
  if (/^(grok|xai)/.test(lower)) return 'xAI'
  if (/^(gemini|imagen|veo|nano-banana)/.test(lower)) return 'Google'
  if (/^(seedream|seedance|doubao|jimeng)/.test(lower)) return 'ByteDance'
  if (/^flux/.test(lower)) return 'Black Forest Labs'
  if (/^recraft/.test(lower)) return 'Recraft'
  if (/^(qwen|wan)/.test(lower)) return 'Alibaba'
  if (/^ideogram/.test(lower)) return 'Ideogram'
  if (/^krea/.test(lower)) return 'Krea'
  if (/^(ernie|baidu)/.test(lower)) return 'Baidu'
  if (/^kling/.test(lower)) return 'Kuaishou'
  if (/^(hailuo|minimax)/.test(lower)) return 'MiniMax'
  if (/^vidu/.test(lower)) return 'Shengshu'
  if (/^pixverse/.test(lower)) return 'PixVerse'
  if (/^(ltx|lightricks)/.test(lower)) return 'Lightricks'
  return type === 'video' ? 'Sub2API Provider' : 'Sub2API'
}

function formConfigFor(slug: string, type: Model['type']) {
  const lower = slug.toLowerCase()
  if (type === 'image' && (lower === 'gpt-image-2' || lower === 'mock-sync-image')) {
    return { fields: [IMAGE_QUALITY_FIELD] }
  }
  if (type === 'image' && /^gpt-image-1(?:\.5)?$/.test(lower)) {
    return { fields: [IMAGE_QUALITY_FIELD] }
  }
  if (type === 'text' && (/^gpt-5(?:[.-]|$)/.test(lower) || /^o[134](?:-|$)/.test(lower) || lower.includes('codex'))) {
    return { fields: [REASONING_EFFORT_FIELD] }
  }
  if (type === 'video') {
    return { fields: [VIDEO_ASPECT_FIELD, VIDEO_DURATION_FIELD] }
  }
  return undefined
}

export function normalizeModels(payload: unknown): Model[] {
  const raw = payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)
    ? (payload as { data: Array<{ id?: string; name?: string }> }).data
    : Array.isArray(payload) ? payload as Array<{ id?: string; name?: string }> : []
  const models = raw
    .map((entry) => String(entry.id ?? entry.name ?? '').trim())
    .filter(Boolean)
    .map((slug) => {
      const type = classify(slug)
      return {
        slug,
        name: displayName(slug),
        type,
        creator: creatorFor(slug, type),
        form_config: formConfigFor(slug, type),
        capabilities: modelCapabilitiesForSlug(slug, type),
      } as Model
    })
  const supported = models.filter((model) => model.type !== 'text')
  const text = models.filter((model) => model.type === 'text').slice(0, 12)
  return [...supported, ...text]
}

export function fallbackModels() {
  return FALLBACK.map((model) => ({ ...model, capabilities: modelCapabilitiesForSlug(model.slug, model.type) }))
}
