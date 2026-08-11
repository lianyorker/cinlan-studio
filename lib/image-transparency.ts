const CONNECT_THRESHOLD_SQUARED = 46 * 46
const EXISTING_ALPHA_RATIO = 0.001
const EDGE_PALETTE_BUCKETS = 8
const EDGE_PALETTE_COVERAGE = 0.82

function colorDistanceSquared(data: Uint8ClampedArray, left: number, right: number) {
  const leftOffset = left * 4
  const rightOffset = right * 4
  const red = data[leftOffset] - data[rightOffset]
  const green = data[leftOffset + 1] - data[rightOffset + 1]
  const blue = data[leftOffset + 2] - data[rightOffset + 2]
  return red * red + green * green + blue * blue
}

export function hasMeaningfulTransparency(data: Uint8ClampedArray) {
  const pixels = data.length / 4
  const required = Math.max(1, Math.ceil(pixels * EXISTING_ALPHA_RATIO))
  let transparent = 0
  for (let offset = 3; offset < data.length; offset += 4) {
    if (data[offset] >= 250) continue
    transparent += 1
    if (transparent >= required) return true
  }
  return false
}

export function hasSimpleEdgeBackground(data: Uint8ClampedArray, width: number, height: number) {
  if (width < 2 || height < 2 || data.length !== width * height * 4) return false
  const colors = new Map<number, number>()
  const perimeter = Math.max(1, (width + height) * 2)
  const step = Math.max(1, Math.floor(perimeter / 768))
  let samples = 0
  const sample = (x: number, y: number) => {
    const offset = (y * width + x) * 4
    if (data[offset + 3] < 250) return
    const key = (data[offset] >> 5) << 6 | (data[offset + 1] >> 5) << 3 | (data[offset + 2] >> 5)
    colors.set(key, (colors.get(key) ?? 0) + 1)
    samples += 1
  }
  for (let x = 0; x < width; x += step) {
    sample(x, 0)
    sample(x, height - 1)
  }
  for (let y = step; y < height - 1; y += step) {
    sample(0, y)
    sample(width - 1, y)
  }
  if (!samples) return false
  const dominant = Array.from(colors.values()).sort((left, right) => right - left).slice(0, EDGE_PALETTE_BUCKETS).reduce((sum, count) => sum + count, 0)
  return dominant / samples >= EDGE_PALETTE_COVERAGE
}

export function removeConnectedBackground(data: Uint8ClampedArray, width: number, height: number) {
  const pixelCount = width * height
  if (!pixelCount || data.length !== pixelCount * 4 || hasMeaningfulTransparency(data)) return false

  const background = new Uint8Array(pixelCount)
  const queue = new Int32Array(pixelCount)
  let head = 0
  let tail = 0
  const enqueue = (index: number) => {
    if (background[index]) return
    background[index] = 1
    queue[tail++] = index
  }

  for (let x = 0; x < width; x += 1) {
    enqueue(x)
    enqueue((height - 1) * width + x)
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueue(y * width)
    enqueue(y * width + width - 1)
  }

  const visit = (from: number, next: number) => {
    if (background[next]) return
    if (colorDistanceSquared(data, from, next) <= CONNECT_THRESHOLD_SQUARED) enqueue(next)
  }
  while (head < tail) {
    const index = queue[head++]
    const x = index % width
    const y = Math.floor(index / width)
    if (x > 0) visit(index, index - 1)
    if (x + 1 < width) visit(index, index + 1)
    if (y > 0) visit(index, index - width)
    if (y + 1 < height) visit(index, index + width)
  }

  for (let index = 0; index < pixelCount; index += 1) {
    if (background[index]) data[index * 4 + 3] = 0
  }

  const featherStart = 24
  const featherEnd = 96
  for (let index = 0; index < pixelCount; index += 1) {
    if (background[index]) continue
    const x = index % width
    const y = Math.floor(index / width)
    let nearest = Number.POSITIVE_INFINITY
    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      const nextY = y + offsetY
      if (nextY < 0 || nextY >= height) continue
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        if (!offsetX && !offsetY) continue
        const nextX = x + offsetX
        if (nextX < 0 || nextX >= width) continue
        const next = nextY * width + nextX
        if (background[next]) nearest = Math.min(nearest, colorDistanceSquared(data, index, next))
      }
    }
    if (!Number.isFinite(nearest)) continue
    const distance = Math.sqrt(nearest)
    const alpha = Math.round(255 * Math.max(0, Math.min(1, (distance - featherStart) / (featherEnd - featherStart))))
    data[index * 4 + 3] = Math.min(data[index * 4 + 3], alpha)
  }
  return true
}
