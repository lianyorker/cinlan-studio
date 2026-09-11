import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Pool } from 'pg'

async function main() {
  const testDatabaseUrl = process.env.CINLAN_TEST_DATABASE_URL?.trim()
  if (!testDatabaseUrl) {
    process.stdout.write('Skipped PostgreSQL integration test: CINLAN_TEST_DATABASE_URL is not configured\n')
    return
  }

const schema = `creative_test_${randomUUID().replace(/-/g, '')}`
const assetRoot = await mkdtemp(join(tmpdir(), 'cinlan-creative-assets-'))
const admin = new Pool({ connectionString: testDatabaseUrl, max: 2 })
const scoped = new URL(testDatabaseUrl)
scoped.searchParams.set('options', `-c search_path=${schema}`)
process.env.DATABASE_URL = scoped.toString()
process.env.CREATIVE_ASSET_STORAGE_DIR = assetRoot
process.env.CINLAN_SESSION_SECRET ||= 'creative-postgres-integration-test-only'

  let creativePool: (() => Pool) | undefined
  let providerMock: Server | undefined
  let groupAvailable = true
  let keyCreateCount = 0
  let nextRemoteKeyId = 100
  const remoteKeys = new Map<number, { id: number; key: string; name: string; status: string; group_id: number }>()

async function expectCode(run: () => Promise<unknown>, code: string) {
  await assert.rejects(run, (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === code))
}

  try {
  await admin.query(`CREATE SCHEMA ${schema}`)
  providerMock = createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : {}
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/groups/available') {
      return send(200, { data: groupAvailable ? [{ id: 7, name: 'Studio', status: 'active' }] : [] })
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/keys') {
      return send(200, { data: [...remoteKeys.values()].map(({ key: _key, ...item }) => item) })
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/keys') {
      keyCreateCount += 1
      const id = nextRemoteKeyId++
      const item = { id, key: `sk-test-managed-${id}`, name: String(body.name || ''), status: 'active', group_id: Number(body.group_id) }
      remoteKeys.set(id, item)
      return send(200, item)
    }
    return send(404, { message: 'not found' })
  })
  await new Promise<void>((resolveListen, reject) => {
    providerMock!.once('error', reject)
    providerMock!.listen(0, '127.0.0.1', resolveListen)
  })
  const address = providerMock.address()
  if (!address || typeof address === 'string') throw new Error('Provider mock did not expose a TCP port')
  process.env.SUB2API_BASE_URL = `http://127.0.0.1:${address.port}`
  process.env.SUB2API_STUDIO_IMAGE_GROUP_ID = '7'
  process.env.SUB2API_STUDIO_TEXT_GROUP_ID = '7'
  process.env.SUB2API_STUDIO_VIDEO_GROUP_ID = ''
  process.env.CINLAN_ALLOW_API_KEY_LOGIN = 'false'

  const migrationDir = resolve(process.cwd(), 'db', 'migrations')
  const migrationNames = (await readdir(migrationDir)).filter((name) => /^\d+.*\.sql$/i.test(name)).sort()
  const db = await import('../lib/server/creative/db')
  creativePool = db.creativePool
  for (const name of migrationNames) {
    await db.creativePool().query(await readFile(resolve(migrationDir, name), 'utf8'))
  }

  const repository = await import('../lib/server/creative/repository')
  const assets = await import('../lib/server/creative/assets')
  const capabilities = await import('../lib/server/creative/capabilities')
  const ownerA = { id: 'owner_test_a', kind: 'user', displayName: 'A' }
  const ownerB = { id: 'owner_test_b', kind: 'user', displayName: 'B' }
  await repository.upsertCreativeOwner(ownerA, 'sealed-a')
  await repository.upsertCreativeOwner(ownerB, 'sealed-b')

  const credentials = await import('../lib/server/creative/provider-credentials')
  const { Sub2ApiError } = await import('../lib/server/sub2api')
  const loginSession = {
    accessToken: 'access-owner-a',
    refreshToken: 'refresh-owner-a',
    accessExpiresAt: Date.now() + 3_600_000,
    authMode: 'login' as const,
    user: { id: 101, email: 'owner-a@example.test', name: 'Owner A' },
  }
  await credentials.persistStudioIdentitySession(loginSession)
  const ownerIdentity = (await import('../lib/server/creative/identity')).creativeOwnerIdentity(loginSession)
  const identityRow = await db.creativeQuery<{ encrypted_access_token: string; encrypted_refresh_token: string }>(
    'SELECT encrypted_access_token, encrypted_refresh_token FROM studio_identity_sessions WHERE owner_id = $1',
    [ownerIdentity.id]
  )
  assert.notEqual(identityRow.rows[0]?.encrypted_access_token, loginSession.accessToken)
  assert.notEqual(identityRow.rows[0]?.encrypted_refresh_token, loginSession.refreshToken)

  const firstCredentials = await Promise.all(Array.from({ length: 4 }, () => credentials.resolveStudioCredential(loginSession, 'image', 'mock-sync-image')))
  assert.equal(new Set(firstCredentials.map((credential) => credential.id)).size, 1, 'Concurrent provisioning created different Studio credentials')
  assert.equal(keyCreateCount, 1, 'Concurrent provisioning created more than one remote key')
  const textCredential = await credentials.resolveStudioCredential(loginSession, 'text', 'mock-text-two')
  assert.equal(textCredential.id, firstCredentials[0].id, 'Capabilities sharing a group did not reuse one credential')
  assert.equal(keyCreateCount, 1)
  const storedRow = await db.creativeQuery<{ encrypted_api_key: string; status: string; rotation_version: number }>(
    'SELECT encrypted_api_key, status, rotation_version FROM studio_provider_credentials WHERE id = $1',
    [firstCredentials[0].id]
  )
  assert.notEqual(storedRow.rows[0]?.encrypted_api_key, firstCredentials[0].apiKey)
  assert.equal(storedRow.rows[0]?.status, 'active')
  assert.equal(Number(storedRow.rows[0]?.rotation_version), 1)

  remoteKeys.delete(firstCredentials[0].remoteKeyId!)
  const rotatedResults = await Promise.all(Array.from({ length: 4 }, () => credentials.withStudioCredential(loginSession, 'image', 'mock-sync-image', async (credential) => {
    if (credential.rotationVersion === 1) throw new Sub2ApiError(401, 'invalid api key', 'KEY_NOT_FOUND')
    return credential.rotationVersion
  })))
  assert.deepEqual(rotatedResults, [2, 2, 2, 2])
  assert.equal(keyCreateCount, 2, 'Concurrent invalid-key recovery rotated more than once')

  const loginSessionB = { ...loginSession, accessToken: 'access-owner-b', user: { id: 202, email: 'owner-b@example.test', name: 'Owner B' } }
  const ownerIdentityB = (await import('../lib/server/creative/identity')).creativeOwnerIdentity(loginSessionB)
  await credentials.persistStudioIdentitySession(loginSessionB)
  const ownerBCredential = await credentials.resolveStudioCredential(loginSessionB, 'image', 'mock-sync-image')
  assert.notEqual(ownerBCredential.id, firstCredentials[0].id)
  await assert.rejects(() => credentials.storedStudioCredential(ownerIdentityB.id, firstCredentials[0].id!), (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'STUDIO_CREDENTIAL_UNAVAILABLE'))

  groupAvailable = false
  ;(globalThis as typeof globalThis & { __cinlanStudioGroupCache?: Map<string, unknown> }).__cinlanStudioGroupCache?.clear()
  await expectCode(() => credentials.resolveStudioCredential(loginSession, 'image', 'mock-sync-image'), 'STUDIO_GROUP_NOT_FOUND')
  const orphaned = await db.creativeQuery<{ status: string }>('SELECT status FROM studio_provider_credentials WHERE id = $1', [firstCredentials[0].id])
  assert.equal(orphaned.rows[0]?.status, 'orphaned_group')
  groupAvailable = true
  ;(globalThis as typeof globalThis & { __cinlanStudioGroupCache?: Map<string, unknown> }).__cinlanStudioGroupCache?.clear()
  const verifiedCapability = {
    text_to_image: true, image_edit: false, multi_image: false, mask: false, asynchronous: true,
    max_reference_images: 0, max_outputs: 2, aspect_ratios: ['1:1'], qualities: ['high'], resolutions: ['1K'],
  }
  await db.creativeQuery(
    `INSERT INTO model_capabilities(model_slug, capabilities, source, verified_at) VALUES($1,$2::jsonb,'integration-test',now())`,
    ['mock-sync-image', JSON.stringify(verifiedCapability)]
  )
  assert.deepEqual(await capabilities.resolveModelCapabilities('mock-sync-image', 'image'), verifiedCapability)

  const baseJob = {
    ownerId: ownerA.id,
    mode: 'GENERATE' as const,
    model: 'mock-sync-image',
    prompt: 'integration prompt',
    parameters: { count: 1, analysis_mode: 'standard' },
    inputAssetIds: [],
  }
  const idempotent = await Promise.all([
    repository.createCreativeJob({ ...baseJob, idempotencyKey: 'same-request' }),
    repository.createCreativeJob({ ...baseJob, idempotencyKey: 'same-request' }),
  ])
  assert.equal(idempotent[0].id, idempotent[1].id, 'Concurrent idempotent submissions created different jobs')
  assert.equal(idempotent[0].max_attempts, 5, 'Creative jobs did not use the migrated retry default')
  await expectCode(() => repository.getJobForOwner(ownerB.id, idempotent[0].id), 'CREATIVE_JOB_NOT_FOUND')

  const events = await repository.listCreativeEvents(ownerA.id, idempotent[0].id)
  assert.equal(events.length, 1)
  assert.equal(events[0].message_key, 'creative.activity.created')
  await repository.appendCreativeEvent(idempotent[0].id, 'status', 'test', 'creative.activity.queued')
  const orderedEvents = await repository.listCreativeEvents(ownerA.id, idempotent[0].id)
  assert.deepEqual(orderedEvents.map((event) => Number(event.id)), [...orderedEvents].map((event) => Number(event.id)).sort((a, b) => a - b))
  await db.creativeQuery(`UPDATE creative_jobs SET status = 'COMPLETED', completed_at = now() WHERE id = $1`, [idempotent[0].id])

  const claimJobs = await Promise.all([
    repository.createCreativeJob({ ...baseJob, idempotencyKey: 'claim-a' }),
    repository.createCreativeJob({ ...baseJob, idempotencyKey: 'claim-b' }),
  ])
  const [claimedA, claimedB] = await Promise.all([
    repository.claimCreativeJobs('worker-a', 1),
    repository.claimCreativeJobs('worker-b', 1),
  ])
  assert.equal(claimedA.length, 1)
  assert.equal(claimedB.length, 1)
  assert.notEqual(claimedA[0].id, claimedB[0].id, 'SKIP LOCKED allowed two workers to claim the same job')
  await db.creativeQuery(`UPDATE creative_jobs SET status = 'COMPLETED', completed_at = now(), lease_owner = NULL, lease_expires_at = NULL WHERE id = ANY($1::text[])`, [claimJobs.map((job) => job.id)])

  const resumable = await repository.createCreativeJob({ ...baseJob, idempotencyKey: 'resume' })
  await db.creativeQuery(`UPDATE creative_jobs SET status = 'ANALYZING', lease_owner = 'dead-worker', lease_expires_at = now() - interval '1 second' WHERE id = $1`, [resumable.id])
  const resumed = await repository.claimCreativeJobs('recovery-worker', 1)
  assert.equal(resumed[0]?.id, resumable.id, 'Expired lease was not recovered')
  assert.ok(resumed[0].lease_expires_at && resumed[0].lease_expires_at.getTime() > Date.now() + 60_000, 'Claimed lease is too short for a worker heartbeat')
  const renewedLease = await repository.renewCreativeJobLease(resumable.id, 'recovery-worker')
  assert.ok(renewedLease && renewedLease.getTime() > Date.now() + 60_000, 'Worker heartbeat did not renew its lease')
  await db.creativeQuery(`UPDATE creative_jobs SET status = 'COMPLETED', completed_at = now(), lease_owner = NULL, lease_expires_at = NULL WHERE id = $1`, [resumable.id])

  const validating = await repository.createCreativeJob({ ...baseJob, idempotencyKey: 'resume-validating' })
  await db.creativeQuery(`UPDATE creative_jobs SET status = 'VALIDATING', lease_owner = NULL, lease_expires_at = NULL WHERE id = $1`, [validating.id])
  const resumedValidating = await repository.claimCreativeJobs('validation-recovery-worker', 1)
  assert.equal(resumedValidating[0]?.id, validating.id, 'VALIDATING job with a released lease was not recovered')
  await db.creativeQuery(`UPDATE creative_jobs SET status = 'COMPLETED', completed_at = now(), lease_owner = NULL, lease_expires_at = NULL WHERE id = $1`, [validating.id])

  const cancellable = await repository.createCreativeJob({ ...baseJob, idempotencyKey: 'cancel' })
  await db.creativeQuery(`UPDATE creative_jobs SET status = 'QUEUED', lease_owner = 'dead-worker', lease_expires_at = now() + interval '15 minutes' WHERE id = $1`, [cancellable.id])
  const cancellation = await repository.requestCreativeCancellation(ownerA.id, cancellable.id)
  assert.equal(cancellation.status, 'CANCELLED')
  assert.equal(cancellation.lease_owner, null)
  assert.equal(cancellation.lease_expires_at, null)
  assert.ok(cancellation.completed_at)
  await expectCode(() => repository.transitionCreativeJob(cancellable.id, { status: 'READY' }), 'CREATIVE_JOB_TERMINAL')
  assert.equal((await repository.getJobForOwner(ownerA.id, cancellable.id)).status, 'CANCELLED')
  assert.equal((await repository.requestCreativeCancellation(ownerA.id, cancellable.id)).status, 'CANCELLED')
  const cancellationEvents = await repository.listCreativeEvents(ownerA.id, cancellable.id)
  assert.equal(cancellationEvents.filter((event) => event.message_key === 'creative.activity.cancelled').length, 1, 'Idempotent cancellation appended duplicate terminal events')

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  const asset = await assets.storeCreativeAsset({ ownerId: ownerA.id, kind: 'reference', bytes: png, mime: 'image/png', originalName: 'reference.png' })
  const duplicateAsset = await assets.storeCreativeAsset({ ownerId: ownerA.id, kind: 'reference', bytes: png, mime: 'image/png', originalName: 'duplicate.png' })
  assert.equal(asset.id, duplicateAsset.id, 'Asset hash deduplication failed')
  await expectCode(() => repository.getAssetForOwner(ownerB.id, asset.id), 'ASSET_NOT_FOUND')
  await expectCode(() => assets.storeCreativeAsset({ ownerId: ownerA.id, kind: 'reference', bytes: Buffer.from('not-an-image'), mime: 'image/png' }), 'INVALID_IMAGE_ASSET')

  const resultAsset = await assets.storeCreativeAsset({ ownerId: ownerA.id, kind: 'result', bytes: png, mime: 'image/png', originalName: 'result.png' })
  assert.equal(assets.assetDownloadName({ ...resultAsset, original_name: 'result-1' }), 'result-1.png', 'Extensionless result download name was not repaired')
  await repository.attachJobAsset(idempotent[0].id, resultAsset.id, 'output', 0)
  const listedWithWorkCount = await repository.listCreativeJobs(ownerA.id, { page: 1, pageSize: 1 })
  assert.equal(listedWithWorkCount.workCount, 1, 'Creative work count did not count persisted output assets')
  const ownerBWorkCount = await repository.listCreativeJobs(ownerB.id, { page: 1, pageSize: 1 })
  assert.equal(ownerBWorkCount.workCount, 0, 'Creative work count leaked another owner output assets')
  const parentVersionId = await repository.createCreativeVersion({ ownerId: ownerA.id, jobId: idempotent[0].id, resultAssetId: resultAsset.id, prompt: 'parent' })
  const repeatedParentVersionId = await repository.createCreativeVersion({ ownerId: ownerA.id, jobId: idempotent[0].id, resultAssetId: resultAsset.id, prompt: 'parent' })
  assert.equal(repeatedParentVersionId, parentVersionId, 'Idempotent version creation returned a non-persisted ID')
  const childJob = await repository.createCreativeJob({ ...baseJob, mode: 'EDIT', idempotencyKey: 'child-version', inputAssetIds: [resultAsset.id] })
  await repository.createCreativeVersion({ ownerId: ownerA.id, jobId: childJob.id, resultAssetId: resultAsset.id, prompt: 'child', parentJobId: idempotent[0].id })
  const lineage = await db.creativeQuery<{ parent_version_id: string }>('SELECT parent_version_id FROM creative_versions WHERE job_id = $1', [childJob.id])
  assert.equal(lineage.rows[0]?.parent_version_id, parentVersionId, 'Creative version lineage was not persisted')

  process.stdout.write('PostgreSQL Creative Core integration test passed\n')
  } finally {
  if (creativePool) await creativePool().end().catch(() => {})
  if (providerMock) await new Promise<void>((resolveClose) => providerMock!.close(() => resolveClose())).catch(() => {})
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {})
  await admin.end().catch(() => {})
  await rm(assetRoot, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
  process.exitCode = 1
})
