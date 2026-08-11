import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg'
import { creativeCoreConfigured } from './config'
import { CreativeCoreError } from './errors'

declare global {
  // eslint-disable-next-line no-var
  var __cinlanCreativePool: Pool | undefined
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

export function creativeQuery<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<QueryResult<T>> {
  return creativePool().query<T>(text, values)
}

export async function creativeTransaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await creativePool().connect()
  try {
    await client.query('BEGIN')
    const result = await run(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
