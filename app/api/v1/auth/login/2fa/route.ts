import { NextResponse } from 'next/server'
import { authErrorResponse } from '@/lib/server/auth-errors'
import { persistLoginSession } from '@/lib/server/studio-auth'
import { sub2apiFetch } from '@/lib/server/sub2api'

export async function POST(request: Request) {
  try {
    const signal = AbortSignal.timeout(15_000)
    const result = await sub2apiFetch<{
      access_token?: string
      refresh_token?: string
      expires_in?: number
      user?: { id?: number; email?: string | null; username?: string | null; balance?: number }
    }>('/api/v1/auth/login/2fa', { method: 'POST', body: JSON.stringify(await request.json()), signal })
    if (!result.access_token) {
      return NextResponse.json({ message: 'Sub2API 未返回登录令牌', code: 'SUB2API_LOGIN_TOKEN_MISSING' }, { status: 502 })
    }
    const session = await persistLoginSession({
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      expiresIn: result.expires_in,
      user: result.user,
      signal,
    })
    return NextResponse.json({ user: session.user, balance: session.user.balance })
  } catch (error) {
    return authErrorResponse(error, '二次验证失败，请稍后重试', 'LOGIN_2FA_FAILED')
  }
}
