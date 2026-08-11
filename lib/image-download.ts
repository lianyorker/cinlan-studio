'use client'

import { hasMeaningfulTransparency, hasSimpleEdgeBackground, removeConnectedBackground } from './image-transparency'

type ImageBackground = 'transparent' | 'white'

function outputName(name: string, background: ImageBackground) {
  const stem = name.replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'cinlan-image'
  return `${stem}-${background}.png`
}

function loadImage(blob: Blob) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Image could not be decoded'))
    }
    image.src = url
  })
}

function pngBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG export failed')), 'image/png')
  })
}

async function sourceCanvas(source: string) {
  const response = await fetch(source)
  if (!response.ok) throw new Error(`Image download failed with HTTP ${response.status}`)
  const image = await loadImage(await response.blob())
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Canvas is unavailable')
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, 0, 0)
  return { canvas, context }
}

function alphaCoverage(data: Uint8ClampedArray) {
  let transparent = 0
  let opaque = 0
  for (let offset = 3; offset < data.length; offset += 4) {
    if (data[offset] < 250) transparent += 1
    else opaque += 1
  }
  const total = transparent + opaque
  return { transparent: transparent / total, opaque: opaque / total }
}

export async function prepareLayoutPreservingTransparency(source: string) {
  const { canvas, context } = await sourceCanvas(source)
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
  if (!hasMeaningfulTransparency(pixels.data)) {
    if (!hasSimpleEdgeBackground(pixels.data, canvas.width, canvas.height)) return null
    if (!removeConnectedBackground(pixels.data, canvas.width, canvas.height)) return null
    const coverage = alphaCoverage(pixels.data)
    if (coverage.transparent < 0.02 || coverage.opaque < 0.001) return null
    context.putImageData(pixels, 0, 0)
  }
  return pngBlob(canvas)
}

export async function downloadImageVariant(source: string, name: string, background: ImageBackground) {
  const { canvas, context } = await sourceCanvas(source)
  if (background === 'transparent' && !hasMeaningfulTransparency(context.getImageData(0, 0, canvas.width, canvas.height).data)) {
    throw new Error('Transparent PNG output does not contain an alpha background')
  }

  let output = canvas
  if (background === 'white') {
    output = document.createElement('canvas')
    output.width = canvas.width
    output.height = canvas.height
    const outputContext = output.getContext('2d')
    if (!outputContext) throw new Error('Canvas is unavailable')
    outputContext.fillStyle = '#ffffff'
    outputContext.fillRect(0, 0, output.width, output.height)
    outputContext.drawImage(canvas, 0, 0)
  }

  const url = URL.createObjectURL(await pngBlob(output))
  const link = document.createElement('a')
  link.href = url
  link.download = outputName(name, background)
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}
