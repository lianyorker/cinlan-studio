import { NextResponse } from 'next/server'
import { getStudioSession } from '@/lib/server/session'
import { refreshStudioSession } from '@/lib/server/studio-auth'
import { sub2apiFetch } from '@/lib/server/sub2api'
import { manualApiKeyLoginEnabled } from '@/lib/server/studio-config'

export async function GET() {
  const session = await getStudioSession()
  if (!session) return NextResponse.json({ message: '请先登录或连接 Sub2API Key' }, { status: 401 })
  if (session.authMode === 'login' && session.accessToken) {
    const active = await refreshStudioSession(session)
    const user = await sub2apiFetch<{ id?: number; email?: string; username?: string; balance?: number }>('/api/v1/auth/me', { accessToken: active.accessToken })
    return NextResponse.json({ id: user.id, email: user.email ?? null, name: user.username ?? null, credits: user.balance ?? 0, currency: 'USD' })
  }
  if (!manualApiKeyLoginEnabled()) return NextResponse.json({ message: 'Sub2API account login is required', code: 'AUTH_REQUIRED' }, { status: 401 })
  return NextResponse.json({ id: 'api-key', email: null, name: null, credits: null, currency: 'USD' })
}
