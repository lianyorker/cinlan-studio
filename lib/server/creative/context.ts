import { getStudioSession } from '../session'
import { requireGenerationSession } from '../generation'
import { CreativeCoreError } from './errors'
import { creativeOwnerIdentity, sealCreativeCredential } from './identity'
import { upsertCreativeOwner } from './repository'

export async function creativeOwnerContext() {
  const session = await getStudioSession()
  if (!session) throw new CreativeCoreError(401, 'AUTH_REQUIRED', 'Please sign in or connect an API Key')
  const owner = creativeOwnerIdentity(session)
  await upsertCreativeOwner(owner, session.apiKey ? sealCreativeCredential(session.apiKey) : undefined)
  return { session, owner }
}

export async function creativeSubmissionContext(existingSession?: Awaited<ReturnType<typeof requireGenerationSession>>) {
  const session = existingSession ?? await requireGenerationSession()
  const owner = creativeOwnerIdentity(session)
  await upsertCreativeOwner(owner, session.apiKey ? sealCreativeCredential(session.apiKey) : undefined)
  return { session, owner }
}
