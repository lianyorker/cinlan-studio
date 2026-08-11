function greatestCommonDivisor(left: number, right: number) {
  let a = Math.abs(left)
  let b = Math.abs(right)
  while (b) [a, b] = [b, a % b]
  return a || 1
}

export function normalizeImageAspectRatio(value: unknown, supported?: string[]) {
  const match = /^(\d{1,4})\s*[:：∶比/]\s*(\d{1,4})$/.exec(String(value ?? '').trim())
  if (!match) return undefined
  const width = Number(match[1])
  const height = Number(match[2])
  if (!width || !height) return undefined
  const divisor = greatestCommonDivisor(width, height)
  const normalized = `${width / divisor}:${height / divisor}`
  return supported?.length && !supported.includes(normalized) ? undefined : normalized
}

export function imageAspectRatioFromPrompt(prompt: string, supported?: string[]) {
  const matches = String(prompt).matchAll(/(?:^|[^\d])(\d{1,4})\s*[:：∶比/]\s*(\d{1,4})(?!\d)/g)
  for (const match of matches) {
    const normalized = normalizeImageAspectRatio(`${match[1]}:${match[2]}`, supported)
    if (normalized) return normalized
  }
  return undefined
}

export function imageAspectRatioValue(value: unknown) {
  const normalized = normalizeImageAspectRatio(value)
  if (!normalized) return undefined
  const [width, height] = normalized.split(':').map(Number)
  return width / height
}
