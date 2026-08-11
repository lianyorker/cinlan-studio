'use client'

/* eslint-disable @next/next/no-img-element */
import { useEffect, useState } from 'react'
import { gradientFor } from '@/lib/catalog'
import { thumbUrl } from '@/lib/api'
import type { Model } from '@/lib/types'

function initialsOf(creator: string): string {
  if (!creator) return 'AI'
  return creator.includes(' ')
    ? creator.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()
    : creator.slice(0, 2).toUpperCase()
}

const PROVIDER_LOGOS: Array<[RegExp, string]> = [
  [/\b(?:gpt|chatgpt|openai|dall-e|sora|o[134](?:\b|-))/, '/providers/openai.svg'],
  [/\b(?:grok|xai)\b/, '/providers/xai.svg'],
  [/\b(?:gemini|imagen|veo|nano-banana|google)\b/, '/providers/gemini-color.svg'],
  [/\b(?:seedream|seedance|doubao|jimeng|bytedance)\b/, '/providers/bytedance-color.svg'],
  [/\b(?:flux|black forest)\b/, '/providers/flux.svg'],
  [/\brecraft\b/, '/providers/recraft.svg'],
  [/\b(?:qwen|wan(?:\d|\b)|tongyi|alibaba)\b/, '/providers/qwen-color.svg'],
  [/\bideogram\b/, '/providers/ideogram.svg'],
  [/\bkrea\b/, '/providers/krea.svg'],
  [/\b(?:ernie|baidu)\b/, '/providers/baidu-color.svg'],
  [/\b(?:kling|kuaishou)\b/, '/providers/kling-color.svg'],
  [/\b(?:hailuo|minimax)\b/, '/providers/minimax-color.svg'],
  [/\b(?:vidu|shengshu)\b/, '/providers/vidu-color.svg'],
  [/\bpixverse\b/, '/providers/pixverse-color.svg'],
  [/\b(?:ltx|lightricks)\b/, '/providers/lightricks.svg'],
]

function providerLogo(model: Model) {
  const identity = `${model.slug} ${model.name} ${model.creator}`.toLowerCase()
  return PROVIDER_LOGOS.find(([pattern]) => pattern.test(identity))?.[1]
}

/** Brand-colored initials badge — fallback when no usable provider logo. */
function Badge({ model, size }: { model: Model; size: number }) {
  return (
    <span
      className="inline-flex items-center justify-center rounded font-bold text-white ring-1 ring-black/5"
      style={{ width: size, height: size, backgroundColor: model.creator_color || '#6366F1', fontSize: Math.round(size * 0.4) }}
    >
      {initialsOf(model.creator)}
    </span>
  )
}

/** Small provider logo (official favicon, else brand badge). */
export function ModelLogo({ model, size = 20 }: { model: Model; size?: number }) {
  const [failed, setFailed] = useState(false)
  const source = model.logo_url || providerLogo(model)
  useEffect(() => setFailed(false), [source])
  if (source && !failed) {
    return (
      <img
        src={source}
        alt=""
        onError={() => setFailed(true)}
        data-provider-logo="true"
        className="rounded bg-white object-contain p-0.5 ring-1 ring-black/5"
        style={{ width: size, height: size }}
      />
    )
  }
  return <Badge model={model} size={size} />
}

/** Card visual: example thumbnail (or gradient fallback) + provider logo badge. */
export function ModelThumb({ model, className = '' }: { model: Model; className?: string }) {
  return (
    <div className={`relative overflow-hidden grain bg-gradient-to-br ${gradientFor(model.name)} ${className}`}>
      {model.thumbnail_url && (
        <img
          src={thumbUrl(model.thumbnail_url, 480)}
          alt=""
          loading="lazy"
          decoding="async"
          className="absolute inset-0 w-full h-full object-cover"
        />
      )}
      <div className="absolute top-2 left-2 rounded-md bg-white/90 p-0.5 shadow-sm ring-1 ring-black/5">
        <ModelLogo model={model} size={22} />
      </div>
    </div>
  )
}
