import { NextResponse } from 'next/server'
import { clearStudioSession, getStudioSession } from '@/lib/server/session'
import { revokeStudioIdentitySession } from '@/lib/server/creative/provider-credentials'

export async function POST() {
  const session = await getStudioSession()
  try {
    if (session) await revokeStudioIdentitySession(session)
  } finally {
    await clearStudioSession()
  }
  return NextResponse.json({ connected: false })
}
