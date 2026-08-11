import type { Model } from '../types'

/** 모델 피커에 노출되는 로컬 모델 항목 — 크레딧 0, 로컬 전용 배지 */
export const LOCAL_MODEL_SLUG = 'z-image-turbo-local'

export const LOCAL_MODEL: Model = {
  slug: LOCAL_MODEL_SLUG,
  name: 'Z-Image Turbo',
  type: 'image',
  creator: 'Tongyi · Local',
  badge: 'local',
  credit_config: { cost: 0, type: 'fixed' },
}

export function isLocalModel(slugOrModel: string | Model): boolean {
  const slug = typeof slugOrModel === 'string' ? slugOrModel : slugOrModel.slug
  return slug === LOCAL_MODEL_SLUG
}
