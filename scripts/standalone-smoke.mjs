import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => error ? reject(error) : resolvePort(port))
    })
  })
}

async function waitForResponse(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return response
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw lastError ?? new Error('Standalone server did not become ready')
}

const port = await freePort()
const output = []
const child = spawn(process.execPath, ['.next/standalone/server.js'], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    HOSTNAME: '127.0.0.1',
    PORT: String(port),
    DATABASE_URL: '',
    CINLAN_SESSION_SECRET: 'standalone-smoke-session-secret',
    CINLAN_EMBEDDED: 'true',
    CINLAN_FRAME_ANCESTORS: "'self' https://api.cinlan.online",
    CINLAN_ALLOWED_ORIGINS: 'https://studio.cinlan.online https://api.cinlan.online',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
child.stdout.on('data', (chunk) => output.push(chunk.toString()))
child.stderr.on('data', (chunk) => output.push(chunk.toString()))

try {
  const rootResponse = await waitForResponse(`http://127.0.0.1:${port}/`)
  const html = await rootResponse.text()
  assert.equal(rootResponse.headers.get('content-security-policy'), "frame-ancestors 'self' https://api.cinlan.online")
  assert.equal(rootResponse.headers.get('referrer-policy'), 'no-referrer')
  assert.match(html, /\/brand\/cinlan-mark\.png/)

  const favicon = await fetch(`http://127.0.0.1:${port}/brand/cinlan-mark.png`)
  assert.equal(favicon.status, 200)
  assert.match(favicon.headers.get('content-type') ?? '', /^image\/png/)

  for (const name of ['editorial-still-life.png', 'futuristic-tea-room.png', 'indigo-botanical-poster.png', 'rainy-cinematic-portrait.png']) {
    const inspiration = await fetch(`http://127.0.0.1:${port}/inspiration/${name}`)
    assert.equal(inspiration.status, 200)
    assert.match(inspiration.headers.get('content-type') ?? '', /^image\/png/)
  }

  const embed = await fetch(`http://127.0.0.1:${port}/api/v1/auth/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  assert.equal(embed.status, 400)
  assert.equal(embed.headers.get('content-security-policy'), "frame-ancestors 'self' https://api.cinlan.online")

  const blockedOrigin = await fetch(`http://127.0.0.1:${port}/api/v1/auth/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example' },
    body: '{}',
  })
  assert.equal(blockedOrigin.status, 403)
  process.stdout.write('Standalone smoke test passed\n')
} catch (error) {
  const tail = output.join('').split(/\r?\n/).slice(-30).join('\n')
  if (tail) process.stderr.write(`${tail}\n`)
  throw error
} finally {
  if (child.pid && process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } else {
    child.kill('SIGTERM')
  }
}
