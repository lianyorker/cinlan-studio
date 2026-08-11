import { NextResponse } from 'next/server'
import { getStudioSession } from '@/lib/server/session'
import { normalizeModels, fallbackModels } from '@/lib/server/catalog'
import { sub2apiFetch, Sub2ApiError } from '@/lib/server/sub2api'
import { applyVerifiedCapabilities } from '@/lib/server/creative/capabilities'
import { CreativeCoreError } from '@/lib/server/creative/errors'
import { studioFeatureHealth, withStudioCredential } from '@/lib/server/creative/provider-credentials'
import type { StudioCapability } from '@/lib/server/studio-config'
import type { Model } from '@/lib/types'

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, max-age=0' }

export async function GET() {
  const session = await getStudioSession()
  const health = await studioFeatureHealth(session)
  const enabled = (['image', 'text', 'video'] as const).filter((capability) => health.features[capability])
  if (!session) {
    const preview = fallbackModels().filter((model) => enabled.includes(model.type as StudioCapability))
    return NextResponse.json({ models: await applyVerifiedCapabilities(preview), authoritative: false }, { headers: NO_STORE_HEADERS })
  }
  try {
    const failures: Array<Sub2ApiError | CreativeCoreError> = []
    let models: Model[] = []
    if (session.authMode === 'api_key') {
      const capability = enabled[0]
      if (!capability) return NextResponse.json({ models: [], authoritative: true }, { headers: NO_STORE_HEADERS })
      const payload = await withStudioCredential(session, capability, undefined, (credential) => sub2apiFetch<unknown>('/v1/models', { apiKey: credential.apiKey }))
      models = normalizeModels(payload).filter((model) => enabled.includes(model.type as StudioCapability))
    } else {
      const catalogs = await Promise.all(enabled.map(async (capability) => {
        try {
          return await withStudioCredential(session, capability, undefined, async (credential) => {
            const payload = await sub2apiFetch<unknown>('/v1/models', { apiKey: credential.apiKey })
            return normalizeModels(payload).filter((model) => model.type === capability)
          })
        } catch (error) {
          if (error instanceof Sub2ApiError || error instanceof CreativeCoreError) failures.push(error)
          else throw error
          return []
        }
      }))
      models = catalogs.flat()
    }
    const unique = [...new Map(models.map((model) => [model.slug, model])).values()]
    const reconnectRequired = failures.some((error) => error.status === 401 || error.status === 403 || error.code === 'CREDENTIAL_REAUTH_REQUIRED')
    return NextResponse.json({
      models: await applyVerifiedCapabilities(unique),
      authoritative: true,
      degraded: health.degraded || failures.length > 0,
      reconnect_required: reconnectRequired,
      ...(failures.length ? { error: { status: failures[0].status, code: failures[0].code, message: failures[0].message } } : {}),
    }, { headers: NO_STORE_HEADERS })
  } catch (error) {
    const status = error instanceof Sub2ApiError || error instanceof CreativeCoreError ? error.status : 502
    const code = error instanceof Sub2ApiError || error instanceof CreativeCoreError ? error.code : undefined
    const reconnectRequired = status === 401 || status === 403
    console.error('[models] upstream catalog request failed', { status, code: code ?? null })
    return NextResponse.json({
      models: [],
      authoritative: true,
      degraded: true,
      reconnect_required: reconnectRequired,
      error: {
        status,
        code,
        message: reconnectRequired ? '当前 API Key 已失效或无权读取模型目录' : '上游模型目录暂时不可用',
      },
    }, { headers: NO_STORE_HEADERS })
  }
}
