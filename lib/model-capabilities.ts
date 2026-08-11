import type { ModelCapabilities } from './creative-types'

const IMAGE_ASPECT_RATIOS = ['1:1', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '16:9', '9:16', '21:9']

const GENERIC_IMAGE: ModelCapabilities = {
  text_to_image: true,
  image_edit: false,
  multi_image: false,
  mask: false,
  asynchronous: true,
  max_reference_images: 0,
  max_outputs: 1,
  aspect_ratios: [],
  qualities: [],
  resolutions: [],
}

const GPT_IMAGE: ModelCapabilities = {
  text_to_image: true,
  image_edit: true,
  multi_image: true,
  mask: false,
  asynchronous: true,
  max_reference_images: 4,
  max_outputs: 4,
  aspect_ratios: IMAGE_ASPECT_RATIOS,
  qualities: ['low', 'medium', 'high'],
  resolutions: [],
}

export function modelCapabilitiesForSlug(slug: string, type: string): ModelCapabilities | undefined {
  if (type !== 'image') return undefined
  const lower = slug.toLowerCase()
  if (lower === 'gpt-image-2' || /^gpt-image-1(?:\.5)?$/.test(lower) || lower.startsWith('mock-')) return { ...GPT_IMAGE }
  return { ...GENERIC_IMAGE }
}
