import { NextResponse, type NextRequest } from 'next/server'

function secure(response: NextResponse) {
  const frameAncestors = (process.env.CINLAN_FRAME_ANCESTORS || "'self'").replace(/[\r\n]+/g, ' ')
  response.headers.set('Content-Security-Policy', `frame-ancestors ${frameAncestors}`)
  response.headers.set('X-Content-Type-Options', 'nosniff')
  response.headers.set('Referrer-Policy', 'no-referrer')
  return response
}

function normalizedOrigin(value: string | null) {
  if (!value) return undefined
  try {
    return new URL(value).origin
  } catch {
    return undefined
  }
}

function requestOrigin(request: NextRequest) {
  const host = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
    || request.headers.get('host')?.trim()
  if (!host || /[\s\\/]/.test(host)) return request.nextUrl.origin
  const forwardedProtocol = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
  const protocol = forwardedProtocol === 'http' || forwardedProtocol === 'https'
    ? forwardedProtocol
    : request.nextUrl.protocol.replace(/:$/, '')
  return normalizedOrigin(`${protocol}://${host}`) ?? request.nextUrl.origin
}

export function middleware(request: NextRequest) {
  const method = request.method.toUpperCase()
  if (request.nextUrl.pathname.startsWith('/api/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const rawOrigin = request.headers.get('origin')
    const origin = normalizedOrigin(rawOrigin)
    const allowed = (process.env.CINLAN_ALLOWED_ORIGINS || '')
      .split(/\s+/)
      .map((value) => normalizedOrigin(value))
      .filter((value): value is string => Boolean(value))
    const sameOrigin = !rawOrigin || origin === requestOrigin(request)
    if (!sameOrigin && (!origin || !allowed.includes(origin))) {
      return secure(NextResponse.json({ message: 'Origin not allowed' }, { status: 403 }))
    }
  }
  return secure(NextResponse.next())
}

export const config = { matcher: ['/((?!_next/static|_next/image).*)'] }
