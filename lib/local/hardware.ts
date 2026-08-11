/**
 * 브라우저 하드웨어 휴리스틱
 *
 * WebGPU adapter 존재/특성으로 "로컬 구동 가능성"의 기대치만 판정한다.
 * 정식 판정은 ComfyUI /system_stats (lib/local/client.ts).
 */

import type { HardwareHint } from './types'

interface WebGPUAdapterLike {
  isFallbackAdapter?: boolean
}

interface NavigatorWithWebGPU extends Navigator {
  gpu?: {
    requestAdapter(): Promise<WebGPUAdapterLike | null>
  }
}

export async function probeHardwareHint(): Promise<HardwareHint> {
  if (typeof navigator === 'undefined') return 'unknown'

  const gpu = (navigator as NavigatorWithWebGPU).gpu
  if (!gpu) return 'unknown'

  try {
    const adapter = await gpu.requestAdapter()
    if (!adapter || adapter.isFallbackAdapter) return 'unlikely'
    return 'likely'
  } catch {
    return 'unknown'
  }
}
