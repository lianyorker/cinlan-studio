import { NextResponse } from 'next/server'
import { setStudioSession } from '@/lib/server/session'
import { sub2apiFetch, Sub2ApiError } from '@/lib/server/sub2api'
import { manualApiKeyLoginEnabled } from '@/lib/server/studio-config'

export async function POST(request: Request) {
  try {
    if (!manualApiKeyLoginEnabled()) {
      return NextResponse.json({ message: 'API Key login is disabled', code: 'API_KEY_LOGIN_DISABLED' }, { status: 404 })
    }
    const { key } = await request.json()
    if (typeof key !== 'string' || !key.trim()) return NextResponse.json({ message: '请输入 Sub2API Key' }, { status: 400 })
    await sub2apiFetch('/v1/models', { apiKey: key.trim() })
    await setStudioSession({ apiKey: key.trim(), authMode: 'api_key', user: {} })
    return NextResponse.json({ connected: true })
  } catch (error) {
    if (error instanceof Sub2ApiError) return NextResponse.json({ message: error.message, code: error.code }, { status: error.status })
    return NextResponse.json({ message: error instanceof Error ? error.message : 'Key 无效' }, { status: 502 })
  }
}
