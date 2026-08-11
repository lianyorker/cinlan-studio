import { NextResponse } from 'next/server'
import { persistLoginSession } from '@/lib/server/studio-auth'
import { Sub2ApiError, sub2apiFetch } from '@/lib/server/sub2api'

export async function POST(request: Request) {
  try {
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
    }>('/api/v1/auth/login', { method: 'POST', body: JSON.stringify(body) })

    if (result.requires_2fa) return NextResponse.json(result)
    if (!result.access_token) return NextResponse.json({ message: 'Sub2API 未返回登录令牌' }, { status: 502 })
    const session = await persistLoginSession({
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      expiresIn: result.expires_in,
      user: result.user,
    })
    return NextResponse.json({
      user: session.user,
      balance: session.user.balance,
      token_type: result.token_type ?? 'Bearer',
    })
  } catch (error) {
    if (error instanceof Sub2ApiError) {
      return NextResponse.json({ message: error.message, code: error.code }, { status: error.status })
    }
    const message = error instanceof Error ? error.message : '登录失败'
    return NextResponse.json({ message }, { status: 502 })
  }
}
