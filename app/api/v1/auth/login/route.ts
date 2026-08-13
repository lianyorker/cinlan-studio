import { NextResponse } from 'next/server'
import { authErrorResponse } from '@/lib/server/auth-errors'
import { persistLoginSession } from '@/lib/server/studio-auth'
import { sub2apiFetch } from '@/lib/server/sub2api'

export async function POST(request: Request) {
  try {
    const signal = AbortSignal.timeout(15_000)
    const body = await request.json()
    const result = await sub2apiFetch<{
      access_token?: string
      refresh_token?: string
      expires_in?: number
      token_type?: string
      user?: { id?: number; email?: string | null; username?: string | null; balance?: number }
      requires_2fa?: boolean
      temp_token?: string
      user_email_masked?: string
    }>('/api/v1/auth/login', { method: 'POST', body: JSON.stringify(body), signal })

    if (result.requires_2fa) return NextResponse.json(result)
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
    return NextResponse.json({
      user: session.user,
      balance: session.user.balance,
      token_type: result.token_type ?? 'Bearer',
    })
  } catch (error) {
    return authErrorResponse(error, '登录失败，请稍后重试', 'LOGIN_FAILED')
  }
}
