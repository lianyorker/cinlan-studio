export interface ImageSizeIntent {
  width: number
  height: number
  aspectRatio: string
  source: 'dimensions' | 'named'
}

const MIN_DIMENSION = 64
const MAX_DIMENSION = 16384

function greatestCommonDivisor(left: number, right: number) {
  let a = Math.abs(left)
  let b = Math.abs(right)
  while (b) [a, b] = [b, a % b]
  return a || 1
}

function validDimension(value: number) {
  return Number.isInteger(value) && value >= MIN_DIMENSION && value <= MAX_DIMENSION
}

function ratioForDimensions(width: number, height: number) {
  const divisor = greatestCommonDivisor(width, height)
  return `${width / divisor}:${height / divisor}`
}

function nearestSupportedAspectRatio(width: number, height: number, supported?: string[]) {
  const exact = ratioForDimensions(width, height)
  if (!supported?.length) return exact
  const target = width / height
  let closest: { value: string; distance: number } | undefined
  for (const value of supported) {
    const normalized = normalizeImageAspectRatio(value)
    if (!normalized) continue
    const [candidateWidth, candidateHeight] = normalized.split(':').map(Number)
    const distance = Math.abs(Math.log(target / (candidateWidth / candidateHeight)))
    if (!closest || distance < closest.distance) closest = { value: value.trim(), distance }
  }
  return closest?.value
}

export function normalizeImageAspectRatio(value: unknown, supported?: string[]) {
  const match = /^(\d{1,5})\s*[:：比]\s*(\d{1,5})$/.exec(String(value ?? '').trim())
  if (!match) return undefined
  const width = Number(match[1])
  const height = Number(match[2])
  if (!width || !height) return undefined
  const normalized = ratioForDimensions(width, height)
  if (!supported?.length) return normalized
  return supported.find((candidate) => {
    const candidateMatch = /^(\d{1,5})\s*[:：比]\s*(\d{1,5})$/.exec(candidate.trim())
    return candidateMatch && ratioForDimensions(Number(candidateMatch[1]), Number(candidateMatch[2])) === normalized
  })?.trim()
}

function explicitDimensions(prompt: string) {
  for (const match of prompt.matchAll(/(?:^|[^\d])(\d{2,5})\s*(?:px\s*)?[xX×*＊]\s*(\d{2,5})(?:\s*px)?(?!\d)/g)) {
    const width = Number(match[1])
    const height = Number(match[2])
    if (validDimension(width) && validDimension(height)) return { width, height }
  }

  const width = /(?:宽(?:度)?|width)\s*[:：=为]?\s*(\d{2,5})\s*(?:px|像素)?/i.exec(prompt)
  const height = /(?:高(?:度)?|长|height)\s*[:：=为]?\s*(\d{2,5})\s*(?:px|像素)?/i.exec(prompt)
  if (width && height) {
    const parsedWidth = Number(width[1])
    const parsedHeight = Number(height[1])
    if (validDimension(parsedWidth) && validDimension(parsedHeight)) return { width: parsedWidth, height: parsedHeight }
  }
  return undefined
}

function namedAspectRatio(prompt: string) {
  const value = prompt.toLowerCase()
  if (/(超宽|宽屏|横幅|banner|header|封面横图|横版|横向|landscape|widescreen)/i.test(value)) return { width: 16, height: 9 }
  if (/(手机壁纸|竖屏|竖版|竖向|portrait|story|shorts|reels)/i.test(value)) return { width: 9, height: 16 }
  if (/(方形|正方形|square|头像)/i.test(value)) return { width: 1, height: 1 }
  return undefined
}

export function imageSizeIntentFromPrompt(prompt: string, supported?: string[]): ImageSizeIntent | undefined {
  const value = String(prompt || '')
  const dimensions = explicitDimensions(value)
  if (dimensions) {
    return { ...dimensions, aspectRatio: ratioForDimensions(dimensions.width, dimensions.height), source: 'dimensions' }
  }

  for (const match of value.matchAll(/(?:^|[^\d])(\d{1,4})\s*[:：比]\s*(\d{1,4})(?!\d)/g)) {
    const width = Number(match[1])
    const height = Number(match[2])
    if (!width || !height) continue
    const aspectRatio = nearestSupportedAspectRatio(width, height, supported)
    if (aspectRatio) return { width, height, aspectRatio, source: 'named' }
  }

  const named = namedAspectRatio(value)
  if (!named) return undefined
  const aspectRatio = nearestSupportedAspectRatio(named.width, named.height, supported)
  return aspectRatio ? { ...named, aspectRatio, source: 'named' } : undefined
}

export function imageAspectRatioFromPrompt(prompt: string, supported?: string[]) {
  return imageSizeIntentFromPrompt(prompt, supported)?.aspectRatio
}

export function imageAspectRatioValue(value: unknown) {
  const normalized = normalizeImageAspectRatio(value)
  if (!normalized) return undefined
  const [width, height] = normalized.split(':').map(Number)
  return width / height
}
