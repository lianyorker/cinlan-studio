import type { Model } from './types'

// Literal class strings so Tailwind's JIT picks them up at build time.
const GRADIENTS = [
  'from-sky-300 to-indigo-400',
  'from-orange-300 to-rose-400',
  'from-yellow-300 to-amber-400',
  'from-fuchsia-400 to-purple-600',
  'from-emerald-300 to-teal-400',
  'from-rose-300 to-pink-400',
  'from-neutral-300 to-neutral-500',
  'from-cyan-300 to-blue-400',
  'from-violet-300 to-indigo-500',
  'from-lime-300 to-green-500',
  'from-blue-300 to-sky-500',
  'from-amber-300 to-orange-500',
  'from-teal-300 to-cyan-500',
  'from-pink-300 to-rose-500',
  'from-purple-300 to-fuchsia-500',
  'from-indigo-300 to-blue-500',
]

/** Deterministic gradient for a model (no thumbnails from the API yet). */
export function gradientFor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return GRADIENTS[h % GRADIENTS.length]
}

export function costOf(m: Model): number | null {
  const c = m.credit_config?.cost
  return typeof c === 'number' ? c : null
}

/** Fill in missing control values with each model's form_config defaults. */
export function resolveValues(m: Model, values: Record<string, unknown> = {}): Record<string, unknown> {
  const out = { ...values }
  const fields = (m.form_config?.fields as Array<{ type: string; default?: unknown; options?: unknown[] }>) ?? []
  for (const f of fields) {
    if (f.type === 'prompt' || f.type === 'image_upload') continue
    if (out[f.type] === undefined) out[f.type] = f.default ?? f.options?.[0]
  }
  return out
}

/**
 * Credit cost for a model given the selected options — mirrors the server
 * calculator (fixed / quality / per_second / tier_per_second). Returns null if
 * it can't be determined (e.g. missing option).
 */
export function creditCost(m: Model, values: Record<string, unknown> = {}, count = 1): number | null {
  const cc = m.credit_config as Record<string, unknown> | null | undefined
  if (!cc) return null
  const v = resolveValues(m, values)
  let cost: number | undefined

  switch (cc.type) {
    case 'fixed':
      cost = cc.cost as number
      break
    case 'quality':
      cost = (cc.costs as Record<string, number>)?.[v.quality as string]
      break
    case 'per_second': {
      const audio = v.toggle === true || v.generateAudio === true
      const rates = cc.rates as Record<string, number> | undefined
      const audioRates = cc.audio_rates as Record<string, number> | undefined
      const rate = (audio ? audioRates?.[v.resolution as string] : undefined) ?? rates?.[v.resolution as string]
      const dur = Number(v.duration)
      if (rate !== undefined && dur > 0) cost = rate * dur
      break
    }
    case 'tier_per_second': {
      const tiers = cc.tiers as Record<string, Record<string, number>> | undefined
      const rate = tiers?.[v.tier as string]?.[v.resolution as string]
      const dur = Number(v.duration)
      if (rate !== undefined && dur > 0) cost = rate * dur
      break
    }
  }
  return typeof cost === 'number' ? cost * count : null
}

/**
 * Credit rate for display. Video (per_second / tier_per_second) returns a
 * per-second rate; image (fixed / quality) returns a flat cost.
 */
export function creditRate(
  m: Model,
  values: Record<string, unknown> = {}
): { rate: number; perSecond: boolean } | null {
  const cc = m.credit_config as Record<string, unknown> | null | undefined
  if (!cc) return null
  const v = resolveValues(m, values)
  switch (cc.type) {
    case 'fixed':
      return typeof cc.cost === 'number' ? { rate: cc.cost, perSecond: false } : null
    case 'quality': {
      const r = (cc.costs as Record<string, number>)?.[v.quality as string]
      return typeof r === 'number' ? { rate: r, perSecond: false } : null
    }
    case 'per_second': {
      const audio = v.toggle === true || v.generateAudio === true
      const audioRates = cc.audio_rates as Record<string, number> | undefined
      const rates = cc.rates as Record<string, number> | undefined
      const r = (audio ? audioRates?.[v.resolution as string] : undefined) ?? rates?.[v.resolution as string]
      return typeof r === 'number' ? { rate: r, perSecond: true } : null
    }
    case 'tier_per_second': {
      const tiers = cc.tiers as Record<string, Record<string, number>> | undefined
      const r = tiers?.[v.tier as string]?.[v.resolution as string]
      return typeof r === 'number' ? { rate: r, perSecond: true } : null
    }
  }
  return null
}

// Offline / pre-backend fallback so the catalog always renders.
export const FALLBACK_IMAGE: Model[] = [
  { slug: 'seedream-5', name: 'Seedream 5', type: 'image', creator: 'ByteDance', credit_config: { cost: 2 } },
  { slug: 'flux-2-pro', name: 'FLUX.2 Pro', type: 'image', creator: 'Black Forest', badge: 'hd', credit_config: { cost: 3 } },
  { slug: 'nano-banana-2', name: 'Nano Banana 2', type: 'image', creator: 'Gemini Team', credit_config: { cost: 2 } },
  { slug: 'grok-image', name: 'Grok Image', type: 'image', creator: 'xAI', credit_config: { cost: 2 } },
  { slug: 'recraft-v4', name: 'Recraft V4', type: 'image', creator: 'Recraft', credit_config: { cost: 2 } },
  { slug: 'qwen-image-2', name: 'Qwen Image 2', type: 'image', creator: 'Alibaba', credit_config: { cost: 2 } },
  { slug: 'gpt-image-2', name: 'GPT Image 2', type: 'image', creator: 'OpenAI', credit_config: { cost: 3 } },
  { slug: 'z-image', name: 'Z-Image', type: 'image', creator: 'Tongyi', credit_config: { cost: 2 } },
  { slug: 'ideogram-3', name: 'Ideogram 3', type: 'image', creator: 'Ideogram', credit_config: { cost: 2 } },
  { slug: 'krea-2-large', name: 'Krea 2 Large', type: 'image', creator: 'Krea', credit_config: { cost: 3 } },
  { slug: 'ernie-image', name: 'Ernie Image', type: 'image', creator: 'Baidu', credit_config: { cost: 2 } },
  { slug: 'wan-2.7', name: 'WAN 2.7', type: 'image', creator: 'Alibaba', credit_config: { cost: 2 } },
]

export const FALLBACK_VIDEO: Model[] = [
  { slug: 'veo-3.1', name: 'Veo 3.1', type: 'video', creator: 'Google DeepMind', credit_config: { cost: 10 } },
  { slug: 'seedance-2.0', name: 'Seedance 2.0', type: 'video', creator: 'ByteDance', credit_config: { cost: 8 } },
  { slug: 'kling-3', name: 'Kling 3.0', type: 'video', creator: 'Kuaishou', credit_config: { cost: 6 } },
  { slug: 'sora-2', name: 'Sora 2', type: 'video', creator: 'OpenAI', credit_config: { cost: 12 } },
  { slug: 'hailuo-02', name: 'Hailuo 02', type: 'video', creator: 'MiniMax', credit_config: { cost: 5 } },
  { slug: 'vidu-q3', name: 'Vidu Q3', type: 'video', creator: 'Shengshu', credit_config: { cost: 3 } },
  { slug: 'pixverse-v6', name: 'PixVerse V6', type: 'video', creator: 'PixVerse', credit_config: { cost: 4 } },
  { slug: 'ltx-2.3', name: 'LTX 2.3', type: 'video', creator: 'Lightricks', credit_config: { cost: 6 } },
]

// Trending placeholders not yet wired to /v1. Real ones (e.g. Motion Control =
// kling-3-mc) are pulled from the live catalog by the studio provider.
export const TRENDING_STUBS: Model[] = [
  { slug: 'face-swap', name: 'Face Swap', type: 'video', creator: 'Kling', credit_config: { cost: 5 }, is_coming_soon: true },
  { slug: 'app-ugc', name: 'Product → UGC', type: 'video', creator: 'Seedance', credit_config: { cost: 8 }, is_coming_soon: true },
  { slug: 'talking-avatar', name: 'Talking Avatar', type: 'video', creator: 'Kling Avatar', credit_config: { cost: 5 }, is_coming_soon: true },
]

// Slugs of live models to surface in the Trending tab (real, generatable).
export const TRENDING_LIVE_SLUGS = ['kling-3-mc']
