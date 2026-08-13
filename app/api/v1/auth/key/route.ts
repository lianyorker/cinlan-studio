import { NextResponse } from 'next/server'
import { authErrorResponse } from '@/lib/server/auth-errors'
import { setStudioSession } from '@/lib/server/session'
import { sub2apiFetch } from '@/lib/server/sub2api'
import { manualApiKeyLoginEnabled } from '@/lib/server/studio-config'

export async function POST(request: Request) {
  try {
    const signal = AbortSignal.timeout(15_000)
    if (!manualApiKeyLoginEnabled()) {
      return NextResponse.json({ message: 'API Key login is disabled', code: 'API_KEY_LOGIN_DISABLED' }, { status: 404 })
    }
    const { key } = await request.json()
    if (typeof key !== 'string' || !key.trim()) {
      return NextResponse.json({ message: '请输入 Sub2API Key', code: 'API_KEY_REQUIRED' }, { status: 400 })
    }
    await sub2apiFetch('/v1/models', { apiKey: key.trim(), signal })
    await setStudioSession({ apiKey: key.trim(), authMode: 'api_key', user: {} })
    return NextResponse.json({ connected: true })
  } catch (error) {
    return authErrorResponse(error, 'Key 无效，请检查后重试', 'API_KEY_AUTH_FAILED')
  }
}
