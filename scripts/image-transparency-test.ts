import assert from 'node:assert/strict'
import { hasMeaningfulTransparency, hasSimpleEdgeBackground, removeConnectedBackground } from '../lib/image-transparency'
import { imageRequestsTransparentBackground, opaqueBackgroundFallbackPrompt } from '../lib/image-output'

function image(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data.set(pixel(x, y), (y * width + x) * 4)
  }
  return data
}

function alpha(data: Uint8ClampedArray, width: number, x: number, y: number) {
  return data[(y * width + x) * 4 + 3]
}

const checkerboard = image(9, 9, (x, y) => {
  if (x >= 3 && x <= 5 && y >= 3 && y <= 5) return [220, 30, 30, 255]
  const shade = (x + y) % 2 ? 232 : 255
  return [shade, shade, shade, 255]
})
assert.equal(hasSimpleEdgeBackground(checkerboard, 9, 9), true)
assert.equal(removeConnectedBackground(checkerboard, 9, 9), true)
assert.equal(alpha(checkerboard, 9, 0, 0), 0)
assert.equal(alpha(checkerboard, 9, 8, 8), 0)
assert.equal(alpha(checkerboard, 9, 4, 4), 255)
assert.equal(hasMeaningfulTransparency(checkerboard), true)

const gradient = image(11, 7, (x, y) => {
  if (x >= 4 && x <= 6 && y >= 2 && y <= 4) return [245, 180, 20, 255]
  return [20 + x * 4, 70 + y * 3, 150 + x * 2, 255]
})
assert.equal(removeConnectedBackground(gradient, 11, 7), true)
assert.equal(alpha(gradient, 11, 0, 3), 0)
assert.equal(alpha(gradient, 11, 5, 3), 255)

const existingAlpha = image(4, 4, (x, y) => [10, 20, 30, x === 0 && y === 0 ? 0 : 255])
const snapshot = existingAlpha.slice()
assert.equal(removeConnectedBackground(existingAlpha, 4, 4), false)
assert.deepEqual(existingAlpha, snapshot)

const noisyBorder = image(32, 24, (x, y) => [(x * 47 + y * 19) % 256, (x * 23 + y * 61) % 256, (x * 71 + y * 13) % 256, 255])
assert.equal(hasSimpleEdgeBackground(noisyBorder, 32, 24), false)

assert.equal(imageRequestsTransparentBackground('生成一个透明底图的品牌 Logo'), true)
assert.equal(imageRequestsTransparentBackground('Logo with a transparent background'), true)
assert.equal(imageRequestsTransparentBackground('不要透明背景，使用纯白色'), false)
const fallbackPrompt = opaqueBackgroundFallbackPrompt('生成一个透明背景的品牌 Logo')
assert.match(fallbackPrompt, /纯白色单色背景/)
assert.match(fallbackPrompt, /flat solid white background/)
assert.match(fallbackPrompt, /no checkerboard/)

console.log('Image transparency test passed')
