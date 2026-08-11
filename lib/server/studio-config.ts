export type StudioCapability = 'image' | 'text' | 'video'

export interface StudioFeatureFlags {
  image: boolean
  text: boolean
  video: boolean
}

function positiveInteger(value: string | undefined) {
  const number = Number(value || '')
  return Number.isInteger(number) && number > 0 ? number : null
}

export function manualApiKeyLoginEnabled() {
  return process.env.CINLAN_ALLOW_API_KEY_LOGIN === 'true'
}

export function studioCapabilityGroups(): Record<StudioCapability, number | null> {
  return {
    image: positiveInteger(process.env.SUB2API_STUDIO_IMAGE_GROUP_ID)
      ?? positiveInteger(process.env.SUB2API_STUDIO_GROUP_ID),
    text: positiveInteger(process.env.SUB2API_STUDIO_TEXT_GROUP_ID),
    video: positiveInteger(process.env.SUB2API_STUDIO_VIDEO_GROUP_ID),
  }
}

export function studioFeatureFlags(): StudioFeatureFlags {
  const groups = studioCapabilityGroups()
  return {
    image: groups.image !== null,
    text: groups.text !== null,
    video: groups.video !== null,
  }
}

export function studioModelGroupOverrides() {
  const raw = process.env.SUB2API_STUDIO_MODEL_GROUP_MAP?.trim()
  if (!raw) return new Map<string, number>()
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return new Map(Object.entries(parsed).flatMap(([model, value]) => {
      const groupId = Number(value)
      return model.trim() && Number.isInteger(groupId) && groupId > 0
        ? [[model.trim().toLowerCase(), groupId] as const]
        : []
    }))
  } catch {
    return new Map<string, number>()
  }
}

export function studioGroupFor(capability: StudioCapability, model?: string) {
  const override = model ? studioModelGroupOverrides().get(model.trim().toLowerCase()) : undefined
  return override ?? studioCapabilityGroups()[capability]
}

export function studioInstallationId() {
  return (process.env.CINLAN_STUDIO_INSTALLATION_ID?.trim() || 'cinlan-studio')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .slice(0, 32)
}
