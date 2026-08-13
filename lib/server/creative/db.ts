import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg'
import { creativeCoreConfigured } from './config'
import { CreativeCoreError } from './errors'

declare global {
  // eslint-disable-next-line no-var
  var __cinlanCreativePool: Pool | undefined
}

type PostgresError = Error & {
  code?: string
  schema?: string
  table?: string
  constraint?: string
}

export function normalizeCreativeStorageError(error: unknown) {
  if (error instanceof CreativeCoreError) return error
  if (error && typeof error === 'object' && 'status' in error && 'code' in error) return error
  const candidate = error instanceof Error ? error as PostgresError : undefined
  const code = candidate?.code || ''
  const postgresCode = /^[0-9A-Z]{5}$/.test(code)
  const connectionCode = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(code)
  const connectionMessage = /connection|timeout|terminated unexpectedly/i.test(candidate?.message || '')
  if (!postgresCode && !connectionCode && !connectionMessage) return error
  console.error('[creative-core] database operation failed', {
    name: candidate?.name || 'UnknownError',
    code: code || null,
    schema: candidate?.schema || null,
    table: candidate?.table || null,
    constraint: candidate?.constraint || null,
  })
  if (['42P01', '42703', '42883', '3F000'].includes(code)) {
    return new CreativeCoreError(503, 'CREATIVE_SCHEMA_OUTDATED', 'Creative Core database migrations are incomplete')
  }
  if (/^(08|28)/.test(code)
    || ['3D000', '53300', '57P01', '57P02', '57P03'].includes(code)
    || connectionCode
    || connectionMessage) {
    return new CreativeCoreError(503, 'CREATIVE_STORAGE_UNAVAILABLE', 'Creative Core database is temporarily unavailable')
  }
  return new CreativeCoreError(500, 'CREATIVE_STORAGE_ERROR', 'Creative Core database operation failed')
}

function createPool() {
  const connectionString = process.env.DATABASE_URL?.trim()
  if (!connectionString) throw new CreativeCoreError(503, 'CREATIVE_CORE_DISABLED', 'Creative Core database is not configured')
  return new Pool({
    connectionString,
    max: Math.min(20, Math.max(2, Number(process.env.CREATIVE_DATABASE_POOL_SIZE || 10))),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'cinlan-studio-creative-core',
    ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== 'false' } : undefined,
  })
}

export function creativePool() {
  if (!creativeCoreConfigured()) throw new CreativeCoreError(503, 'CREATIVE_CORE_DISABLED', 'Creative Core database is not configured')
  globalThis.__cinlanCreativePool ??= createPool()
  return globalThis.__cinlanCreativePool
}

export async function creativeQuery<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<QueryResult<T>> {
  try {
    return await creativePool().query<T>(text, values)
  } catch (error) {
    throw normalizeCreativeStorageError(error)
  }
}

export async function creativeTransaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  let client: PoolClient
  try {
    client = await creativePool().connect()
  } catch (error) {
    throw normalizeCreativeStorageError(error)
  }
  try {
    await client.query('BEGIN')
    const result = await run(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw normalizeCreativeStorageError(error)
  } finally {
    client.release()
  }
}
