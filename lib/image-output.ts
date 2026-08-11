const transparentRequest = /(?:transparent(?:\s+(?:background|backdrop|canvas))?|alpha(?:\s+channel)?|透明(?:背景|底(?:图)?|通道)|无背景|去背景|抠图)/i
const transparentNegation = /(?:不要|无需|不需要|非|not|without)\s*(?:transparent|透明)/i

export function imageRequestsTransparentBackground(prompt: string) {
  const value = String(prompt || '')
  return transparentRequest.test(value) && !transparentNegation.test(value)
}

export function opaqueBackgroundFallbackPrompt(prompt: string) {
  const value = String(prompt || '')
    .replace(/\n*Render the background with real alpha transparency\.[^\n]*/gi, '')
    .replace(/transparent\s+(?:background|backdrop|canvas)/gi, 'plain solid white background')
    .replace(/透明(?:背景|底(?:图)?|通道)|无背景|去背景|抠图/g, '纯白色单色背景')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return [
    value,
    'Alpha transparency is unavailable in this provider pass. Render a perfectly flat solid white background with no checkerboard, grid, texture, gradient, shadow, glow, or background objects so the background can be removed cleanly in post-processing.',
  ].filter(Boolean).join('\n\n')
}
