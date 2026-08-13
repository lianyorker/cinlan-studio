import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'

async function main() {
  const server = createServer((request, response) => {
    if (request.url === '/hang') return
    response.writeHead(502, { 'Content-Type': 'text/plain' })
    response.end('Bad Gateway')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    process.env.SUB2API_BASE_URL = `http://127.0.0.1:${address.port}`
    const { Sub2ApiError, sub2apiFetch } = await import('../lib/server/sub2api')
    const { authErrorResponse } = await import('../lib/server/auth-errors')

    let upstreamError: unknown
    try {
      await sub2apiFetch('/v1/models', { apiKey: 'test-only-key' })
    } catch (error) {
      upstreamError = error
    }
    assert.ok(upstreamError instanceof Sub2ApiError)
    assert.equal(upstreamError.status, 502)
    assert.equal(upstreamError.code, 'UPSTREAM_HTTP_502')
    assert.equal(upstreamError.message, 'Sub2API upstream request failed')

    const response = authErrorResponse(upstreamError, 'fallback', 'AUTH_FAILED')
    assert.equal(response.status, 502)
    const body = await response.json()
    assert.equal(body.code, 'UPSTREAM_HTTP_502')
    assert.equal(body.message, 'Sub2API 上游暂时不可用，请稍后重试')
    assert.equal(body.upstream_status, 502)

    let timeoutError: unknown
    try {
      await sub2apiFetch('/hang', { signal: AbortSignal.timeout(50) })
    } catch (error) {
      timeoutError = error
    }
    assert.ok(timeoutError instanceof Sub2ApiError)
    assert.equal(timeoutError.status, 504)
    assert.equal(timeoutError.code, 'SUB2API_TIMEOUT')
    const timeoutResponse = authErrorResponse(timeoutError, 'fallback', 'AUTH_FAILED')
    assert.equal(timeoutResponse.status, 504)
    assert.equal((await timeoutResponse.json()).message, 'Sub2API 响应超时，请稍后重试')

    const { commitStudioLoginSession } = await import('../lib/server/studio-auth')
    const order: string[] = []
    await commitStudioLoginSession(
      { accessToken: 'test-access-token', authMode: 'login', user: { id: 1 } },
      {
        setSession: async () => { order.push('session') },
        persistIdentity: async () => {
          order.push('identity')
          throw Object.assign(new Error('relation does not exist'), { code: '42P01' })
        },
      }
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(order, ['session', 'identity'])

    const { CreativeCoreError } = await import('../lib/server/creative/errors')
    const { normalizeCreativeStorageError } = await import('../lib/server/creative/db')
    const schemaError = normalizeCreativeStorageError(Object.assign(new Error('relation does not exist'), { code: '42P01', table: 'studio_identity_sessions' }))
    assert.ok(schemaError instanceof CreativeCoreError)
    assert.equal(schemaError.code, 'CREATIVE_SCHEMA_OUTDATED')
    const upstreamInTransaction = new Sub2ApiError(502, 'Sub2API upstream request failed', 'UPSTREAM_HTTP_502')
    assert.equal(normalizeCreativeStorageError(upstreamInTransaction), upstreamInTransaction)
    const upstreamTimeoutInTransaction = new Sub2ApiError(504, 'Sub2API request timed out', 'SUB2API_TIMEOUT')
    assert.equal(normalizeCreativeStorageError(upstreamTimeoutInTransaction), upstreamTimeoutInTransaction)
    console.log('Auth error test passed')
  } finally {
    server.close()
  }
}

void main()
