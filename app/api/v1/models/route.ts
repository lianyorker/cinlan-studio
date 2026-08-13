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

function catalogErrorMessage(error: Sub2ApiError | CreativeCoreError | undefined, reconnectRequired = false) {
  if (reconnectRequired) return '当前登录已失效或无权读取模型目录，请重新登录'
  if (!error) return '模型目录暂时不可用，请稍后重试'
  if (error.code === 'STUDIO_GROUP_NOT_FOUND') return '已配置的 Studio 分组不存在，请检查 Sub2API 分组配置'
  if (error.code === 'STUDIO_FEATURE_NOT_CONFIGURED') return '当前 Studio 功能尚未配置可用分组'
  if (error.code === 'STUDIO_CREDENTIAL_UNAVAILABLE') return 'Studio 隐藏 API Key 暂不可用，请重新登录后重试'
  if (error.status >= 500 || /UPSTREAM_HTTP_5|SUB2API_FETCH_FAILED/.test(error.code || '')) {
    return 'Sub2API 上游模型目录暂时不可用，请稍后重试'
  }
  return error.message || '模型目录暂时不可用，请稍后重试'
}

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
      ...(failures.length ? { error: { status: failures[0].status, code: failures[0].code, message: catalogErrorMessage(failures[0], reconnectRequired) } } : {}),
    }, { headers: NO_STORE_HEADERS })
  } catch (error) {
    const known = error instanceof Sub2ApiError || error instanceof CreativeCoreError ? error : undefined
    const status = known ? known.status : 502
    const code = known?.code
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
        message: catalogErrorMessage(known, reconnectRequired),
      },
    }, { headers: NO_STORE_HEADERS })
  }
}
