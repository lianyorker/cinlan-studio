import type { ModelCapabilities } from '@/lib/creative-types'
import type { Model } from '@/lib/types'
import { modelCapabilitiesForSlug } from '@/lib/model-capabilities'
import { creativeCoreConfigured } from './config'
import { creativeQuery } from './db'

type CapabilityRow = { model_slug: string; capabilities: unknown }

function validCapabilities(value: unknown): value is ModelCapabilities {
  if (!value || typeof value !== 'object') return false
  const capability = value as Record<string, unknown>
  const booleans = ['text_to_image', 'image_edit', 'multi_image', 'mask', 'asynchronous']
  const arrays = ['aspect_ratios', 'qualities', 'resolutions']
  return booleans.every((key) => typeof capability[key] === 'boolean')
    && arrays.every((key) => Array.isArray(capability[key]) && (capability[key] as unknown[]).every((item) => typeof item === 'string'))
    && Number.isInteger(capability.max_reference_images)
    && Number(capability.max_reference_images) >= 0
    && Number.isInteger(capability.max_outputs)
    && Number(capability.max_outputs) >= 1
}

async function verifiedCapabilities(slugs: string[]) {
  if (!creativeCoreConfigured() || !slugs.length) return new Map<string, ModelCapabilities>()
  const result = await creativeQuery<CapabilityRow>(
    `SELECT model_slug, capabilities
       FROM model_capabilities
      WHERE model_slug = ANY($1::text[]) AND verified_at IS NOT NULL`,
    [slugs]
  )
  return new Map(result.rows.filter((row) => validCapabilities(row.capabilities)).map((row) => [row.model_slug, row.capabilities as ModelCapabilities]))
}

export async function resolveModelCapabilities(slug: string, type: string) {
  const configured = await verifiedCapabilities([slug])
  return configured.get(slug) ?? modelCapabilitiesForSlug(slug, type)
}

export async function applyVerifiedCapabilities(models: Model[]) {
  if (!creativeCoreConfigured() || !models.length) return models
  try {
    const configured = await verifiedCapabilities(models.map((model) => model.slug))
    return models.map((model) => configured.has(model.slug) ? { ...model, capabilities: configured.get(model.slug) } : model)
  } catch (error) {
    console.error('[creative-core] model capability lookup failed', { message: error instanceof Error ? error.message : String(error) })
    return models
  }
}
