import { NextResponse } from 'next/server'
import { persistLoginSession } from '@/lib/server/studio-auth'
import { Sub2ApiError, sub2apiFetch } from '@/lib/server/sub2api'

export async function POST(request: Request) {
  try {
    const result = await sub2apiFetch<{
      access_token?: string
      refresh_token?: string
      expires_in?: number
      user?: { id?: number; email?: string | null; username?: string | null; balance?: number }
    }>('/api/v1/auth/login/2fa', { method: 'POST', body: JSON.stringify(await request.json()) })
    if (!result.access_token) return NextResponse.json({ message: 'Sub2API 未返回登录令牌' }, { status: 502 })
    const session = await persistLoginSession({
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      expiresIn: result.expires_in,
      user: result.user,
    })
    return NextResponse.json({ user: session.user, balance: session.user.balance })
  } catch (error) {
    if (error instanceof Sub2ApiError) return NextResponse.json({ message: error.message, code: error.code }, { status: error.status })
    return NextResponse.json({ message: error instanceof Error ? error.message : '二次验证失败' }, { status: 502 })
  }
}
