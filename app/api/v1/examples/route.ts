import { NextResponse } from 'next/server'
import { STUDIO_EXAMPLES } from '@/lib/server/examples'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const model = url.searchParams.get('model')
  const limit = Math.min(12, Math.max(1, Number(url.searchParams.get('limit') || 6)))
  const examples = STUDIO_EXAMPLES.filter((item) => !model || item.model === model).slice(0, limit)
  return NextResponse.json({ examples: examples.length ? examples : STUDIO_EXAMPLES.slice(0, limit) })
}
