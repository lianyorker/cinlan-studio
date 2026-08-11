import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { creativePool } from '../lib/server/creative/db'

async function main() {
  const pool = creativePool()
  const lockClient = await pool.connect()
  try {
    await lockClient.query(`SELECT pg_advisory_lock(hashtext('cinlan-studio-schema-migrations'))`)
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`)
    const directory = resolve(process.cwd(), 'db', 'migrations')
    const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()
    for (const name of files) {
      const applied = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name])
      if (applied.rowCount) continue
      const sql = await readFile(resolve(directory, name), 'utf8')
      const migrationClient = await pool.connect()
      try {
        await migrationClient.query('BEGIN')
        await migrationClient.query(sql)
        await migrationClient.query('INSERT INTO schema_migrations(name) VALUES($1)', [name])
        await migrationClient.query('COMMIT')
        process.stdout.write(`Applied ${name}\n`)
      } catch (error) {
        await migrationClient.query('ROLLBACK')
        throw error
      } finally {
        migrationClient.release()
      }
    }
  } finally {
    await lockClient.query(`SELECT pg_advisory_unlock(hashtext('cinlan-studio-schema-migrations'))`).catch(() => {})
    lockClient.release()
    await pool.end()
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
