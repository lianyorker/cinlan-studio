import { NextResponse, type NextRequest } from 'next/server'

function secure(response: NextResponse) {
  const frameAncestors = (process.env.CINLAN_FRAME_ANCESTORS || "'self'").replace(/[\r\n]+/g, ' ')
  response.headers.set('Content-Security-Policy', `frame-ancestors ${frameAncestors}`)
  response.headers.set('X-Content-Type-Options', 'nosniff')
  response.headers.set('Referrer-Policy', 'no-referrer')
  return response
}

export function middleware(request: NextRequest) {
  const method = request.method.toUpperCase()
  if (request.nextUrl.pathname.startsWith('/api/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const origin = request.headers.get('origin')
    const allowed = (process.env.CINLAN_ALLOWED_ORIGINS || '').split(/\s+/).filter(Boolean)
    const sameOrigin = !origin || origin === request.nextUrl.origin
    if (!sameOrigin && !allowed.includes(origin)) {
      return secure(NextResponse.json({ message: 'Origin not allowed' }, { status: 403 }))
    }
  }
  return secure(NextResponse.next())
}

export const config = { matcher: ['/((?!_next/static|_next/image).*)'] }
