import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const FULL_MODELS = [
  'mock-async-image',
  'mock-sync-image',
  'mock-video-one',
  'mock-video-two',
  'gpt-5.2',
  'mock-text-two',
]

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(value))
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', async () => {
      try {
        const buffer = Buffer.concat(chunks)
        const contentType = String(request.headers['content-type'] ?? '')
        if (contentType.startsWith('multipart/form-data')) {
          const headers = new Headers()
          for (const [key, value] of Object.entries(request.headers)) {
            if (Array.isArray(value)) value.forEach((item) => headers.append(key, item))
            else if (value !== undefined) headers.set(key, value)
          }
          const webRequest = new Request('http://mock.local', { method: 'POST', headers, body: buffer })
          const form = await webRequest.formData()
          const body = {}
          for (const [key, value] of form.entries()) {
            const next = typeof value === 'string'
              ? value
              : { name: value.name, size: value.size, type: value.type }
            body[key] = body[key] === undefined ? next : [...(Array.isArray(body[key]) ? body[key] : [body[key]]), next]
          }
          resolveBody(body)
          return
        }
        resolveBody(buffer.length ? JSON.parse(buffer.toString('utf8')) : {})
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => error ? reject(error) : resolvePort(port))
    })
  })
}

function listen(server) {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolveListen(server.address().port))
  })
}

function closeServer(server) {
  return new Promise((resolveClose) => server.close(() => resolveClose()))
}

async function waitForHttp(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`)
}

async function fetchJson(url, init) {
  const response = await fetch(url, init)
  const value = await response.json().catch(() => null)
  return { response, value }
}

function cookieFrom(response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean)
  return values[0]?.split(';', 1)[0] ?? ''
}

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ]
  return candidates.filter(Boolean).find(existsSync) ?? null
}

function terminateProcess(child) {
  if (!child?.pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

class CdpClient {
  constructor(url) {
    this.url = url
    this.id = 0
    this.pending = new Map()
    this.listeners = new Map()
  }

  async connect() {
    this.socket = new WebSocket(this.url)
    await new Promise((resolveOpen, reject) => {
      this.socket.addEventListener('open', resolveOpen, { once: true })
      this.socket.addEventListener('error', reject, { once: true })
    })
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (message.id) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error.message))
        else pending.resolve(message.result)
        return
      }
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params)
    })
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? []
    listeners.push(listener)
    this.listeners.set(method, listeners)
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolveSend, reject) => {
      this.pending.set(id, { resolve: resolveSend, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
    }
    return response.result.value
  }

  close() {
    this.socket?.close()
  }
}

async function waitForEvaluation(client, expression, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      if (await client.evaluate(expression)) return
    } catch (error) {
      lastError = error
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150))
  }
  throw lastError ?? new Error(`Timed out evaluating: ${expression}`)
}

async function click(client, predicate) {
  const clicked = await client.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => ${predicate});
    if (!button) return false;
    button.click();
    return true;
  })()`)
  assert.equal(clicked, true, `Button not found: ${predicate}`)
}

async function clickReal(client, predicate) {
  const point = await client.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => ${predicate});
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`)
  assert.ok(point, `Button not found: ${predicate}`)
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
}

async function fillReal(client, predicate, value) {
  const focused = await client.evaluate(`(() => {
    const input = [...document.querySelectorAll('input')].find((item) => ${predicate});
    if (!input) return false;
    input.focus();
    return true;
  })()`)
  assert.equal(focused, true, `Input not found: ${predicate}`)
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
  await client.send('Input.insertText', { text: value })
}

async function selectModel(client, currentName, nextName, absentName) {
  await click(client, `item.textContent?.includes(${JSON.stringify(currentName)})`)
  await waitForEvaluation(client, `document.body.innerText.includes(${JSON.stringify(nextName)})`)
  if (absentName) {
    assert.equal(
      await client.evaluate(`document.body.innerText.includes(${JSON.stringify(absentName)})`),
      false,
      `Unexpected model remained visible: ${absentName}`
    )
  }
  await click(client, `item.textContent?.includes(${JSON.stringify(nextName)})`)
  await waitForEvaluation(client, `document.body.innerText.includes(${JSON.stringify(nextName)})`)
}

async function runBrowserSmoke(appUrl, upstreamRequests) {
  const browserExecutable = findBrowser()
  if (!browserExecutable) {
    console.warn('Browser smoke skipped: set CHROME_PATH or install Chrome/Chromium')
    return false
  }
  const browserPort = await freePort()
  const browserRoot = mkdtempSync(join(tmpdir(), 'cinlan-studio-smoke-'))
  const browser = spawn(browserExecutable, [
    '--headless=new',
    `--remote-debugging-port=${browserPort}`,
    `--user-data-dir=${browserRoot}`,
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' })
  let client
  try {
    await waitForHttp(`http://127.0.0.1:${browserPort}/json/version`)
    const targets = await fetch(`http://127.0.0.1:${browserPort}/json/list`).then((response) => response.json())
    const target = targets.find((item) => item.type === 'page')
    assert.ok(target?.webSocketDebuggerUrl, 'Browser page target was not found')
    client = new CdpClient(target.webSocketDebuggerUrl)
    await client.connect()
    const requests = []
    const consoleErrors = []
    client.on('Network.requestWillBeSent', ({ request }) => requests.push(request.url))
    client.on('Runtime.consoleAPICalled', ({ type, args }) => {
      if (type === 'error') consoleErrors.push(args.map((argument) => argument.value ?? argument.description ?? '').join(' '))
    })
    await client.send('Page.enable')
    await client.send('Runtime.enable')
    await client.send('Network.enable')
    await client.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      const originalFetch = window.fetch.bind(window);
      const cancelledParallelJobs = new Set();
      let terminalDeleted = false;
      let terminalPolled = false;
      let resolveTerminalInitialHistory;
      const terminalInitialHistory = new Promise((resolve) => { resolveTerminalInitialHistory = resolve; });
      let releaseTerminalHistory;
      const terminalHistoryGate = new Promise((resolve) => { releaseTerminalHistory = resolve; });
      window.__cinlanReleaseTerminalHistory = () => releaseTerminalHistory();
      window.__cinlanTerminalHistoryResolved = false;
      const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
      window.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        const method = (init?.method || (typeof input === 'string' ? 'GET' : input.method) || 'GET').toUpperCase();
        if (localStorage.getItem('__cinlan_history_pagination_smoke') === '1' && url.pathname === '/api/v1/generations' && method === 'GET') {
          const page = Number(url.searchParams.get('page') || '1');
          window.__cinlanHistoryPages = [...(window.__cinlanHistoryPages || []), page];
          const count = page === 1 ? 24 : page === 2 ? 7 : 0;
          const offset = page === 1 ? 0 : 24;
          const generations = Array.from({ length: count }, (_, index) => ({
            id: 'job_history_pagination_' + (offset + index), type: 'image', model: 'mock-sync-image', prompt: 'history pagination ' + (offset + index),
            status: 'COMPLETED', result_url: 'data:image/png;base64,${PNG}', result_urls: ['data:image/png;base64,${PNG}'], expected_count: 1,
            thumbnail_url: null, credits_used: 0, created_at: new Date(Date.now() - (offset + index) * 1000).toISOString(), error: null,
          }));
          return json({ generations, pagination: { page, pageSize: 24, totalCount: 31, workCount: 31, totalPages: 2, hasMore: page === 1 } });
        }
        if (localStorage.getItem('__cinlan_terminal_smoke') === '1') {
          const now = new Date().toISOString();
          const failedJob = {
            id: 'job_terminal_smoke', mode: 'GENERATE', status: 'FAILED', model: 'mock-sync-image',
            prompt: 'terminal state smoke', parameters: { count: 1 }, result_url: null, result_urls: [],
            attempt_count: 1, created_at: now, updated_at: now, completed_at: now,
          };
          if (url.pathname === '/api/v1/creative/config') {
            return json({
              enabled: true, database: 'postgresql', asset_storage: 'filesystem', planner_enabled: true,
              features: { image: true, text: true, video: true },
              feature_status: {
                image: { configured: true, available: true, degraded: false, group_id: 7 },
                text: { configured: true, available: true, degraded: false, group_id: 7 },
                video: { configured: true, available: true, degraded: false, group_id: 7 },
              },
              api_key_login_enabled: true,
            });
          }
          if (url.pathname === '/api/v1/creative/jobs' && method === 'GET') {
            await terminalInitialHistory;
            return json({ jobs: terminalDeleted ? [] : [{ ...failedJob, status: 'RUNNING', completed_at: null }], pagination: { page: 1, pageSize: 24, totalCount: terminalDeleted ? 0 : 1, totalPages: 1, hasMore: false } });
          }
          if (url.pathname === '/api/v1/tasks/job_terminal_smoke') {
            terminalPolled = true;
            return json({ id: failedJob.id, type: 'image', model: failedJob.model, status: 'FAILED', result_urls: [], error: 'Image generation is not enabled for this group', credits_used: 0 });
          }
          if (url.pathname === '/api/v1/creative/jobs/job_terminal_smoke/events') {
            return json({ events: [] });
          }
          if (url.pathname === '/api/v1/creative/jobs/job_terminal_smoke' && method === 'DELETE') {
            terminalDeleted = true;
            return new Response(null, { status: 204 });
          }
          if (url.pathname === '/api/v1/generations' && method === 'GET') {
            const refreshAfterTerminal = terminalPolled;
            if (refreshAfterTerminal) await terminalHistoryGate;
            const completedCount = terminalDeleted ? 15 : 14;
            const completed = Array.from({ length: completedCount }, (_, index) => ({
              id: 'job_terminal_work_' + index, type: 'image', model: 'mock-sync-image', prompt: 'completed work ' + index,
              status: 'COMPLETED', result_url: 'data:image/png;base64,${PNG}', result_urls: ['data:image/png;base64,${PNG}'], expected_count: 1,
              thumbnail_url: null, credits_used: 0, created_at: new Date(Date.now() - (index + 1) * 1000).toISOString(), error: null,
            }));
            window.__cinlanTerminalHistoryResolved = refreshAfterTerminal;
            if (!refreshAfterTerminal) resolveTerminalInitialHistory();
            return json({
              generations: terminalDeleted ? completed : [...completed, ...(refreshAfterTerminal ? [{
                id: failedJob.id, type: 'image', model: failedJob.model, prompt: failedJob.prompt, status: failedJob.status,
                result_url: null, result_urls: [], expected_count: 1, thumbnail_url: null, credits_used: 0, created_at: now,
                error: 'Image generation is not enabled for this group',
              }] : [])],
              pagination: { page: 1, pageSize: 24, totalCount: completed.length + (terminalDeleted ? 0 : 1), workCount: 15, totalPages: 1, hasMore: false },
            });
          }
        }
        if (localStorage.getItem('__cinlan_parallel_smoke') === '1') {
          const now = new Date().toISOString();
          const jobs = [
            { id: 'job_parallel_smoke_1', ratio: '9:16' },
            { id: 'job_parallel_smoke_2', ratio: '4:5' },
          ].map(({ id, ratio }) => ({
            id, mode: 'GENERATE', status: cancelledParallelJobs.has(id) ? 'CANCELLED' : 'RUNNING', model: 'mock-sync-image',
            prompt: 'parallel cancellation smoke', parameters: { count: 1, aspect_ratio: ratio }, result_url: null, result_urls: [],
            attempt_count: 1, created_at: now, updated_at: now, completed_at: cancelledParallelJobs.has(id) ? now : null,
          }));
          if (url.pathname === '/api/v1/creative/config') {
            return json({
              enabled: true,
              database: 'postgresql',
              asset_storage: 'filesystem',
              planner_enabled: true,
              features: { image: true, text: true, video: true },
              feature_status: {
                image: { configured: true, available: true, degraded: false, group_id: 7 },
                text: { configured: true, available: true, degraded: false, group_id: 7 },
                video: { configured: true, available: true, degraded: false, group_id: 7 },
              },
              api_key_login_enabled: true,
            });
          }
          if (url.pathname === '/api/v1/creative/jobs' && method === 'GET') {
            return json({ jobs, pagination: { page: 1, pageSize: 24, totalCount: jobs.length, totalPages: 1, hasMore: false } });
          }
          if (url.pathname === '/api/v1/generations' && method === 'GET') {
            return json({ generations: jobs.map((job) => ({
              id: job.id, type: 'image', model: job.model, prompt: job.prompt, status: job.status,
              result_url: null, result_urls: [], expected_count: 1, aspect_ratio: job.parameters.aspect_ratio,
              thumbnail_url: null, credits_used: 0, created_at: now, error: null,
            })), pagination: { page: 1, pageSize: 24, totalCount: jobs.length, totalPages: 1, hasMore: false } });
          }
          const taskId = ['job_parallel_smoke_1', 'job_parallel_smoke_2'].find((id) => url.pathname === '/api/v1/tasks/' + id);
          if (taskId) {
            const cancelled = cancelledParallelJobs.has(taskId);
            return json({ id: taskId, type: 'image', model: 'mock-sync-image', status: cancelled ? 'CANCELLED' : 'IN_PROGRESS', result_urls: [], error: cancelled ? 'Cancelled' : null, credits_used: 0 });
          }
          const eventJobId = ['job_parallel_smoke_1', 'job_parallel_smoke_2'].find((id) => url.pathname === '/api/v1/creative/jobs/' + id + '/events');
          if (eventJobId) {
            return json({ events: [{ id: 1, job_id: eventJobId, type: 'status', phase: 'generating', message_key: 'creative.activity.generating', payload: {}, created_at: now }] });
          }
          const jobId = ['job_parallel_smoke_1', 'job_parallel_smoke_2'].find((id) => url.pathname === '/api/v1/creative/jobs/' + id);
          if (jobId && method === 'PATCH') {
            cancelledParallelJobs.add(jobId);
            const job = jobs.find((item) => item.id === jobId);
            return json({ ...job, status: 'CANCELLED', completed_at: now });
          }
        }
        if (localStorage.getItem('__cinlan_restore_smoke') === '1') {
          if (url.pathname === '/api/v1/creative/config') {
            return json({
              enabled: true,
              database: 'postgresql',
              asset_storage: 'filesystem',
              planner_enabled: true,
              features: { image: true, text: true, video: true },
              feature_status: {
                image: { configured: true, available: true, degraded: false, group_id: 7 },
                text: { configured: true, available: true, degraded: false, group_id: 7 },
                video: { configured: true, available: true, degraded: false, group_id: 7 },
              },
              api_key_login_enabled: true,
            });
          }
          if (url.pathname === '/api/v1/creative/jobs' && (!init?.method || init.method === 'GET')) {
            const now = new Date().toISOString();
            return json({
              jobs: [{
                id: 'job_restore_smoke', mode: 'GENERATE', status: 'COMPLETED', model: 'mock-sync-image',
                prompt: 'restored activity smoke', parameters: { count: 2 }, result_url: null, result_urls: [],
                attempt_count: 1, created_at: now, updated_at: now, completed_at: now,
              }],
              pagination: { page: 1, pageSize: 24, totalCount: 1, totalPages: 1, hasMore: false },
            });
          }
          if (url.pathname === '/api/v1/creative/jobs/job_restore_smoke/events') {
            const now = new Date().toISOString();
            return json({ events: [
              { id: 1, job_id: 'job_restore_smoke', type: 'status', phase: 'created', message_key: 'creative.activity.created', payload: {}, created_at: now },
              { id: 2, job_id: 'job_restore_smoke', type: 'status', phase: 'completed', message_key: 'creative.activity.completed', payload: {}, created_at: now },
            ] });
          }
        }
        return originalFetch(input, init);
      };
    })()` })
    await client.send('Page.navigate', { url: appUrl })
    await waitForEvaluation(client, `document.querySelector('[data-testid="surface-skeleton"]') !== null`)
    assert.equal(await client.evaluate(`document.querySelector('[data-testid="skeleton-model-control"]') !== null`), true)
    assert.equal(await client.evaluate(`document.querySelector('[data-testid="skeleton-quality-control"]') !== null`), true)
    await waitForEvaluation(client, `document.readyState === 'complete' && document.body.innerText.includes('Cinlan Studio')`, 60_000)
    await waitForEvaluation(client, `(() => { const logo = document.querySelector('[data-testid="brand-logo"]'); return logo?.complete && logo.naturalWidth > 0 })()`)
    assert.equal(await client.evaluate(`document.querySelector('[data-testid="brand-logo"]')?.getAttribute('src')`), '/brand/cinlan-mark.png')
    assert.equal(await client.evaluate(`getComputedStyle(document.querySelector('button[aria-label="文字"]')).display !== 'none'`), true)
    assert.equal(await client.evaluate(`getComputedStyle(document.querySelector('button[aria-label="视频"]')).display !== 'none'`), true)
    assert.equal(requests.some((url) => url.startsWith('http://127.0.0.1:8188')), false, 'Cloud mode contacted the local runtime on load')

    await click(client, `item.getAttribute('aria-label') === '账户'`)
    await waitForEvaluation(client, `document.body.innerText.includes('API Key')`)
    await click(client, `item.textContent?.trim() === 'API Key'`)
    const filled = await client.evaluate(`(() => {
      const input = [...document.querySelectorAll('input')].find((item) => item.placeholder === 'sk-...');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'sk-retry-catalog');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      return true;
    })()`)
    assert.equal(filled, true, 'API key input was not found')
    await waitForEvaluation(client, `[...document.querySelectorAll('button')].some((item) => item.textContent?.includes('连接 Key') && !item.disabled)`)
    await clickReal(client, `item.textContent?.includes('连接 Key') && !item.disabled`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000))
    await waitForEvaluation(client, `document.body.innerText.includes('Mock Async Image')`, 20_000)
    await waitForEvaluation(client, `document.querySelectorAll('img[src^="/inspiration/"]').length === 4`, 20_000)
    await waitForEvaluation(client, `document.body.innerText.includes('透明玻璃花器与新鲜绿植的高级编辑静物')`, 20_000)
    await waitForEvaluation(client, `document.querySelector('[data-provider-logo="true"]') !== null`, 20_000)
    await waitForEvaluation(client, `document.querySelector('[data-testid="connect-modal"]') === null`, 20_000)
    assert.equal(
      upstreamRequests().filter((item) => item.path === '/v1/models' && item.headers.authorization === 'Bearer sk-retry-catalog').length,
      3,
      'Transient model catalog failure was not retried'
    )
    await client.evaluate(`(() => { localStorage.setItem('locale', 'en'); location.reload(); return true })()`)
    await waitForEvaluation(client, `document.body.innerText.includes('Editorial still life with transparent glass vessels')`, 20_000)
    await client.evaluate(`(() => { localStorage.setItem('locale', 'zh'); location.reload(); return true })()`)
    await waitForEvaluation(client, `document.body.innerText.includes('透明玻璃花器与新鲜绿植的高级编辑静物')`, 20_000)
    const connectionState = await client.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('连接 Key'));
      const input = [...document.querySelectorAll('input')].find((item) => item.placeholder === 'sk-...');
      return {
        button: button?.outerHTML ?? null,
        inputValue: input?.value ?? null,
        activePlaceholder: document.activeElement?.getAttribute?.('placeholder') ?? null,
        body: document.body.innerText.slice(-800),
      };
    })()`)
    if (!await client.evaluate(`document.body.innerText.includes('Mock Async Image')`)) {
      throw new Error(`API key UI submission did not refresh models: ${JSON.stringify(connectionState)}`)
    }
    await waitForEvaluation(client, `document.body.innerText.includes('Mock Async Image')`, 20_000)

    await click(client, `item.getAttribute('aria-label') === '账户'`)
    await waitForEvaluation(client, `document.body.innerText.includes('重新连接 API Key')`)
    await click(client, `item.textContent?.includes('重新连接 API Key')`)
    await waitForEvaluation(client, `[...document.querySelectorAll('input')].some((item) => item.placeholder === 'sk-...')`)
    await click(client, `item.getAttribute('aria-label') === '关闭'`)

    await selectModel(client, 'Mock Async Image', 'Mock Sync Image', 'Z-Image Turbo')
    assert.equal(await client.evaluate(`localStorage.getItem('cinlan-model-image')`), 'mock-sync-image')

    await client.evaluate(`(() => {
      localStorage.setItem('__cinlan_history_pagination_smoke', '1');
      localStorage.setItem('locale', 'en');
      window.__cinlanHistoryPages = [];
      location.reload();
      return true;
    })()`)
    await waitForEvaluation(client, `document.readyState === 'complete' && document.body.innerText.includes('Mock Sync Image')`, 30_000)
    await click(client, `item.getAttribute('aria-label') === 'History'`)
    await waitForEvaluation(client, `(() => {
      const gallery = [...document.querySelectorAll('[data-testid="history-gallery"]')].find((item) => item.offsetParent !== null);
      return gallery?.querySelectorAll('[data-history-key^="cloud:job_history_pagination_"]').length === 24;
    })()`, 20_000)
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
    assert.equal(await client.evaluate(`(window.__cinlanHistoryPages || []).includes(2)`), false, 'History requested page 2 before the user reached the end')
    const historyScrolled = await client.evaluate(`(() => {
      const gallery = [...document.querySelectorAll('[data-testid="history-gallery"]')].find((item) => item.offsetParent !== null);
      if (!gallery) return false;
      let scroller = gallery.parentElement;
      while (scroller && scroller !== document.body && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
      if (!scroller || scroller === document.body) return false;
      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new Event('scroll'));
      return true;
    })()`)
    assert.equal(historyScrolled, true, 'Scrollable history container was not found')
    await waitForEvaluation(client, `(window.__cinlanHistoryPages || []).includes(2)`, 20_000)
    await waitForEvaluation(client, `(() => {
      const gallery = [...document.querySelectorAll('[data-testid="history-gallery"]')].find((item) => item.offsetParent !== null);
      return gallery?.querySelectorAll('[data-history-key^="cloud:job_history_pagination_"]').length === 31;
    })()`, 20_000)
    const paginatedHistory = await client.evaluate(`(() => {
      const gallery = [...document.querySelectorAll('[data-testid="history-gallery"]')].find((item) => item.offsetParent !== null);
      const keys = [...(gallery?.querySelectorAll('[data-history-key^="cloud:job_history_pagination_"]') || [])].map((item) => item.getAttribute('data-history-key'));
      return { count: keys.length, unique: new Set(keys).size, pageTwoRequests: (window.__cinlanHistoryPages || []).filter((page) => page === 2).length };
    })()`)
    assert.deepEqual(paginatedHistory, { count: 31, unique: 31, pageTwoRequests: 1 }, 'History pagination did not append one unique second page')
    await client.evaluate(`(() => {
      localStorage.removeItem('__cinlan_history_pagination_smoke');
      localStorage.setItem('locale', 'zh');
      location.reload();
      return true;
    })()`)
    await waitForEvaluation(client, `document.readyState === 'complete' && document.body.innerText.includes('Mock Sync Image')`, 30_000)

    await client.evaluate(`(() => { localStorage.setItem('__cinlan_restore_smoke', '1'); location.reload(); return true })()`)
    await waitForEvaluation(client, `document.querySelector('[data-testid="creative-activity"]') !== null`, 20_000)
    await click(client, `item.getAttribute('data-testid') === 'creative-activity'`)
    await waitForEvaluation(client, `document.querySelectorAll('[data-testid="creative-activity-panel"] li').length === 2`, 20_000)
    await client.evaluate(`(() => { localStorage.removeItem('__cinlan_restore_smoke'); location.reload(); return true })()`)
    await waitForEvaluation(client, `document.readyState === 'complete' && document.body.innerText.includes('Mock Sync Image')`, 30_000)

    await client.evaluate(`(() => { localStorage.setItem('__cinlan_parallel_smoke', '1'); location.reload(); return true })()`)
    await waitForEvaluation(client, `document.querySelectorAll('[data-testid="cancel-creative-job"]').length === 2`, 20_000)
    const restoredTaskLayout = await client.evaluate(`(() => {
      const buttons = [...document.querySelectorAll('[data-testid="cancel-creative-job"]')];
      return {
        ratios: buttons.map((button) => Number(button.closest('[data-history-key]')?.dataset.taskAspectRatio)),
        separated: buttons.every((button) => button.closest('[data-testid="history-task-list"]') && !button.closest('[data-testid="history-gallery"]')),
      };
    })()`)
    assert.ok(restoredTaskLayout.ratios.some((ratio) => Math.abs(ratio - 9 / 16) < 0.01), 'A restored 9:16 task lost its requested ratio metadata')
    assert.ok(restoredTaskLayout.ratios.some((ratio) => Math.abs(ratio - 4 / 5) < 0.01), 'A restored 4:5 task lost its requested ratio metadata')
    assert.equal(restoredTaskLayout.separated, true, 'Active generation tasks were mixed into the completed-work gallery')
    await click(client, `item.getAttribute('data-testid') === 'cancel-creative-job' && !item.disabled`)
    await waitForEvaluation(client, `document.querySelectorAll('[data-testid="cancel-creative-job"]').length === 1`, 20_000)
    await client.evaluate(`(() => { localStorage.removeItem('__cinlan_parallel_smoke'); location.reload(); return true })()`)
    await waitForEvaluation(client, `document.readyState === 'complete' && document.body.innerText.includes('Mock Sync Image')`, 30_000)

    await client.evaluate(`(() => { localStorage.setItem('__cinlan_terminal_smoke', '1'); location.reload(); return true })()`)
    await waitForEvaluation(client, `document.querySelector('[data-testid="delete-creative-job"]') !== null`, 10_000)
    assert.equal(await client.evaluate(`window.__cinlanTerminalHistoryResolved`), false, 'Terminal task only appeared after the delayed history refresh')
    assert.equal(await client.evaluate(`document.body.innerText.includes('Image generation is not enabled for this group')`), true, 'Terminal task did not expose its failure reason')
    const workCountBeforeDelete = await client.evaluate(`document.querySelector('[data-testid="history-work-count"]')?.textContent`)
    await click(client, `item.getAttribute('data-testid') === 'delete-creative-job' && !item.disabled`)
    await waitForEvaluation(client, `document.querySelector('[data-testid="delete-creative-job"]') === null`, 2_000)
    await client.evaluate(`window.__cinlanReleaseTerminalHistory()`)
    await waitForEvaluation(client, `document.querySelector('[data-testid="history-work-count"]')?.textContent === ${JSON.stringify(workCountBeforeDelete)}`, 10_000)
    assert.equal(await client.evaluate(`document.querySelector('[data-testid="history-work-count"]')?.textContent`), workCountBeforeDelete, 'Deleting a failed task changed the stable work count')
    await client.evaluate(`(() => { localStorage.removeItem('__cinlan_terminal_smoke'); location.reload(); return true })()`)
    await waitForEvaluation(client, `document.readyState === 'complete' && document.body.innerText.includes('Mock Sync Image')`, 30_000)

    await click(client, `item.getAttribute('aria-label') === '文字'`)
    await waitForEvaluation(client, `document.body.innerText.includes('Gpt 5.2')`)
    await waitForEvaluation(client, `[...document.querySelectorAll('button')].some((item) => item.getAttribute('aria-label') === '思考强度' && item.textContent?.includes('xhigh'))`)
    await selectModel(client, 'Gpt 5.2', 'Mock Text Two')
    assert.equal(await client.evaluate(`localStorage.getItem('cinlan-model-text')`), 'mock-text-two')

    await click(client, `item.getAttribute('aria-label') === '视频'`)
    await waitForEvaluation(client, `document.body.innerText.includes('Mock Video One')`)
    await selectModel(client, 'Mock Video One', 'Mock Video Two')
    assert.equal(await client.evaluate(`localStorage.getItem('cinlan-model-video')`), 'mock-video-two')

    await client.evaluate(`location.reload(); true`)
    await waitForEvaluation(client, `document.readyState === 'complete' && document.body.innerText.includes('Mock Sync Image')`, 30_000)
    await click(client, `item.getAttribute('aria-label') === '文字'`)
    await waitForEvaluation(client, `document.body.innerText.includes('Mock Text Two')`)
    await click(client, `item.getAttribute('aria-label') === '视频'`)
    await waitForEvaluation(client, `document.body.innerText.includes('Mock Video Two')`)
    await click(client, `item.getAttribute('aria-label') === '图片'`)
    await waitForEvaluation(client, `document.body.innerText.includes('Mock Sync Image')`)

    const promptFilled = await client.evaluate(`(() => {
      const input = document.querySelector('textarea');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(input, 'smoke sync image');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`)
    assert.equal(promptFilled, true, 'Prompt input was not found')
    const mixedPaste = await client.evaluate(`(() => {
      const input = document.querySelector('textarea');
      if (!input) return null;
      const binary = atob(${JSON.stringify(PNG)});
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const transfer = new DataTransfer();
      transfer.items.add('enterprise prompt text', 'text/plain');
      transfer.items.add(new File([bytes], 'rich-copy-preview.png', { type: 'image/png' }));
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer });
      const dispatched = input.dispatchEvent(event);
      return { dispatched, defaultPrevented: event.defaultPrevented };
    })()`)
    assert.deepEqual(mixedPaste, { dispatched: true, defaultPrevented: false }, 'Text-and-image clipboard content did not prioritize text paste')
    assert.equal(await client.evaluate(`document.querySelector('[data-testid="reference-image-preview"]') === null`), true, 'Mixed clipboard content incorrectly uploaded its preview image')
    await click(client, `item.getAttribute('aria-label') === '添加附件'`)
    await waitForEvaluation(client, `document.body.innerText.includes('上传图片')`)
    await click(client, `item.getAttribute('aria-label') === '添加附件'`)
    const pasted = await client.evaluate(`(() => {
      const input = document.querySelector('textarea');
      if (!input) return false;
      const binary = atob(${JSON.stringify(PNG)});
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'clipboard.png', { type: 'image/png' }));
      input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: transfer }));
      return true;
    })()`)
    assert.equal(pasted, true, 'Clipboard image paste could not be dispatched')
    await waitForEvaluation(client, `document.querySelector('[data-testid="reference-image-preview"]') !== null`)
    await waitForEvaluation(client, `document.querySelector('[data-testid="history-skeleton"]') === null`)
    await client.evaluate(`(() => {
      window.__historySkeletonReappeared = false;
      window.__historySkeletonObserver = new MutationObserver(() => {
        if (document.querySelector('[data-testid="history-skeleton"]')) window.__historySkeletonReappeared = true;
      });
      window.__historySkeletonObserver.observe(document.body, { childList: true, subtree: true });
      return true;
    })()`)
    for (let index = 0; index < 3; index += 1) {
      await click(client, `item.getAttribute('aria-label') === '增加数量' && !item.disabled`)
    }
    await waitForEvaluation(client, `document.body.innerText.includes('4 张')`)
    const enterPrevented = await client.evaluate(`document.querySelector('textarea')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) === false`)
    assert.equal(enterPrevented, true, 'Enter did not submit the image prompt')
    await waitForEvaluation(client, `document.querySelector('textarea')?.value === ''`)
    await waitForEvaluation(client, `document.querySelector('[data-testid="reference-image-preview"]') === null`)
    await waitForEvaluation(client, `document.querySelector('.creative-pending-card') !== null`)
    assert.equal(await client.evaluate(`document.querySelectorAll('.creative-pending-card').length`), 4, 'A four-image request did not render exactly four pending output cards')
    const pendingAnimation = await client.evaluate(`getComputedStyle(document.querySelector('.creative-pending-card'), '::before').animationName`)
    assert.equal(pendingAnimation, 'creativeSweep', 'Pending generation card has no transition animation')
    await waitForEvaluation(client, `(() => {
      const notice = document.querySelector('[data-testid="generation-notice"]');
      const composer = document.querySelector('.composer-shell');
      if (!notice || !composer || composer.contains(notice)) return false;
      return notice.getBoundingClientRect().bottom < composer.getBoundingClientRect().top;
    })()`)
    if (process.env.CINLAN_SMOKE_NOTICE_SCREENSHOT) {
      const screenshot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      writeFileSync(process.env.CINLAN_SMOKE_NOTICE_SCREENSHOT, Buffer.from(screenshot.data, 'base64'))
    }
    await click(client, `item.getAttribute('aria-label') === '文字'`)
    await waitForEvaluation(client, `document.body.innerText.includes('Mock Text Two')`)
    await click(client, `item.getAttribute('aria-label') === '图片'`)
    await waitForEvaluation(client, `document.querySelector('img[src^="data:image/png;base64,"]') !== null`, 20_000)
    await waitForEvaluation(client, `document.querySelector('[data-testid="generation-notice"]') === null`, 30_000)
    const parallelImageCalls = upstreamRequests().filter((item) => item.path === '/v1/images/edits' && String(item.body?.prompt ?? '').includes('smoke sync image'))
    assert.equal(parallelImageCalls.length, 4, 'A four-image request did not submit four independent generation jobs')
    assert.ok(Math.max(...parallelImageCalls.map((item) => item.at)) - Math.min(...parallelImageCalls.map((item) => item.at)) < 750, 'Multiple image jobs were submitted sequentially instead of concurrently')
    await waitForEvaluation(client, `(async () => {
      const records = await new Promise((resolveRecords, reject) => {
        const open = indexedDB.open('cinlan-studio-history', 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const request = open.result.transaction('items', 'readonly').objectStore('items').getAll();
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolveRecords(request.result);
        };
      });
      return records.some((item) => item.prompt === 'smoke sync image' && item.status === 'COMPLETED');
    })()`, 20_000)
    const historyRender = await client.evaluate(`(() => {
      window.__historySkeletonObserver?.disconnect();
      const keys = [...document.querySelectorAll('[data-history-key]')].map((item) => item.getAttribute('data-history-key'));
      return { skeletonReappeared: window.__historySkeletonReappeared, keys, uniqueCount: new Set(keys).size };
    })()`)
    assert.equal(historyRender.skeletonReappeared, false, 'History returned to its skeleton while a generation was running')
    assert.equal(historyRender.uniqueCount, historyRender.keys.length, 'History rendered duplicate task keys')
    assert.equal(consoleErrors.some((message) => message.includes('Encountered two children with the same key')), false, 'React reported duplicate history keys')

    await client.evaluate(`(() => { localStorage.setItem('locale', 'en'); location.reload(); return true })()`)
    await waitForEvaluation(client, `document.body.innerText.includes('My work') && document.body.innerText.includes('Xinglan Studio')`, 20_000)
    const englishUi = await client.evaluate(`(() => {
      const quality = [...document.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === 'Quality');
      return {
        hasChineseWorkTitle: document.body.innerText.includes('我的作品'),
        hasChineseManage: document.body.innerText.includes('管理'),
        hasManage: document.body.innerText.includes('Manage'),
        nativeSelects: document.querySelectorAll('select').length,
        hasImageRatio: [...document.querySelectorAll('button')].some((item) => item.getAttribute('aria-label') === 'Aspect ratio' && item.getBoundingClientRect().width > 0 && item.getBoundingClientRect().height > 0),
        qualityBorder: quality ? getComputedStyle(quality).borderTopColor : null,
      };
    })()`)
    assert.equal(englishUi.hasChineseWorkTitle, false, 'English UI kept the Chinese work title')
    assert.equal(englishUi.hasChineseManage, false, 'English UI kept the Chinese manage action')
    assert.equal(englishUi.hasManage, true, 'English UI did not render the localized manage action')
    assert.equal(englishUi.nativeSelects, 0, 'Composer still renders a native select menu')
    assert.equal(englishUi.hasImageRatio, false, 'Image composer still renders an aspect-ratio control')
    assert.ok(['rgba(0, 0, 0, 0)', 'transparent'].includes(englishUi.qualityBorder), `Composer control has a default border: ${englishUi.qualityBorder}`)
    await click(client, `item.textContent?.trim() === 'Manage'`)
    await waitForEvaluation(client, `document.body.innerText.includes('Done')`)
    await click(client, `item.closest('[data-history-key]') && !item.disabled`)
    await waitForEvaluation(client, `document.body.innerText.includes('Delete selected (1)')`)
    await click(client, `item.textContent?.trim() === 'Done'`)
    await click(client, `item.closest('[data-history-key]')?.querySelector('img') && !item.disabled`)
    await waitForEvaluation(client, `document.body.innerText.includes('Download') && !document.body.innerText.includes('Transparent PNG') && !document.body.innerText.includes('White PNG')`)
    await click(client, `item.getAttribute('aria-label') === 'Close'`)
    const visibleQuality = `item.getAttribute('aria-label') === 'Quality' && item.getBoundingClientRect().width > 0 && item.getBoundingClientRect().height > 0 && getComputedStyle(item).visibility !== 'hidden'`
    await click(client, visibleQuality)
    await waitForEvaluation(client, ` [...document.querySelectorAll('[role="listbox"][aria-label="Quality"]')].some((item) => item.getBoundingClientRect().width > 0 && item.getBoundingClientRect().height > 0)`)
    const composerMenuUi = await client.evaluate(`(() => {
      const trigger = [...document.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === 'Quality');
      const menu = document.querySelector('[role="listbox"][aria-label="Quality"]');
      if (!trigger || !menu) return null;
      const triggerRect = trigger.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const hit = document.elementFromPoint(menuRect.left + Math.min(16, menuRect.width / 2), menuRect.top + Math.min(16, menuRect.height / 2));
      return {
        state: trigger.dataset.state,
        visible: menuRect.width > 0 && menuRect.height > 0 && menuRect.top >= 0 && menuRect.bottom <= window.innerHeight,
        opensAbove: menuRect.bottom <= triggerRect.top,
        receivesPointerEvents: menu.contains(hit),
      };
    })()`)
    assert.deepEqual(composerMenuUi, {
      state: 'open',
      visible: true,
      opensAbove: true,
      receivesPointerEvents: true,
    }, 'Composer select popover was not visible above the input')
    if (process.env.CINLAN_SMOKE_SCREENSHOT) {
      const screenshot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      writeFileSync(process.env.CINLAN_SMOKE_SCREENSHOT, Buffer.from(screenshot.data, 'base64'))
    }
    await click(client, `item.getAttribute('role') === 'option' && item.textContent?.includes('Medium')`)
    await waitForEvaluation(client, `document.querySelector('[role="listbox"][aria-label="Quality"]') === null`)
    assert.equal(
      await client.evaluate(`[...document.querySelectorAll('button')].some((item) => item.getAttribute('aria-label') === 'Quality' && item.textContent?.includes('Medium'))`),
      true,
      'Selecting a composer option did not update its visible value'
    )
    await client.evaluate(`(() => { localStorage.setItem('locale', 'zh'); location.reload(); return true })()`)
    await waitForEvaluation(client, `document.body.innerText.includes('我的作品')`, 20_000)

    await click(client, `item.getAttribute('aria-label') === '账户'`)
    await waitForEvaluation(client, `document.body.innerText.includes('重新连接 API Key')`)
    await click(client, `item.textContent?.includes('重新连接 API Key')`)
    await waitForEvaluation(client, `[...document.querySelectorAll('input')].some((item) => item.placeholder === 'sk-...')`)
    await fillReal(client, `item.placeholder === 'sk-...'`, 'sk-expiring-catalog')
    await waitForEvaluation(client, `[...document.querySelectorAll('input')].some((item) => item.placeholder === 'sk-...' && item.value === 'sk-expiring-catalog')`)
    await waitForEvaluation(client, `[...document.querySelectorAll('button')].some((item) => item.textContent?.includes('连接 Key') && !item.disabled)`)
    await clickReal(client, `item.textContent?.includes('连接 Key') && !item.disabled`)
    await waitForEvaluation(client, `document.querySelector('[data-testid="connect-modal"]') === null`, 20_000)
    await waitForEvaluation(client, `document.body.innerText.includes('模型目录加载失败，请稍后重试')`, 20_000)
    await click(client, `item.textContent?.includes('重新连接 API Key')`)
    await waitForEvaluation(client, `[...document.querySelectorAll('input')].some((item) => item.placeholder === 'name@example.com')`)
    await click(client, `item.closest('[data-testid="connect-modal"]') && item.classList.contains('absolute')`)
    await click(client, `item === document.querySelector('header button:last-child')`)
    await click(client, `item.closest('[data-testid="connect-modal"]') && item.classList.contains('primary-btn')`)
    await waitForEvaluation(client, `[...document.querySelectorAll('input')].some((item) => item.placeholder === 'sk-...')`)
    await fillReal(client, `item.placeholder === 'sk-...'`, 'sk-empty')
    await waitForEvaluation(client, `[...document.querySelectorAll('input')].some((item) => item.placeholder === 'sk-...' && item.value === 'sk-empty')`)
    await waitForEvaluation(client, `[...document.querySelectorAll('button')].some((item) => item.textContent?.includes('连接 Key') && !item.disabled)`)
    await clickReal(client, `item.textContent?.includes('连接 Key') && !item.disabled`)
    await waitForEvaluation(client, `document.querySelector('[data-testid="connect-modal"]') === null`, 20_000)
    const latestCatalogRequest = upstreamRequests().filter((item) => item.path === '/v1/models').at(-1)
    assert.equal(latestCatalogRequest?.headers.authorization, 'Bearer sk-empty', 'Reconnect submitted the previous API key')
    const activeCatalog = await client.evaluate(`fetch('/api/v1/models', { cache: 'no-store' }).then((response) => response.json())`)
    assert.deepEqual(activeCatalog.models.map((item) => [item.slug, item.type]), [['mock-text-only', 'text']])
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000))
    const emptyGroupBody = await client.evaluate(`document.body.innerText`)
    assert.equal(emptyGroupBody.includes('当前账户分组没有可用的图片模型'), true, `Empty image group kept stale UI: ${emptyGroupBody.slice(-600)}`)

    await client.evaluate(`(() => {
      localStorage.setItem('cinlan-generation-mode', 'local');
      localStorage.setItem('cinlan-model-image', 'z-image-turbo-local');
      location.reload();
      return true;
    })()`)
    await waitForEvaluation(client, `localStorage.getItem('cinlan-generation-mode') === 'cloud'`, 20_000)
    assert.equal(
      await client.evaluate(`localStorage.getItem('cinlan-model-image')`),
      null,
      'The removed local model remained selected in browser storage'
    )
    assert.equal(
      await client.evaluate(`document.body.innerText.includes('Z-Image Turbo')`),
      false,
      'The removed local model remained visible after a reload'
    )
    await client.evaluate(`window.dispatchEvent(new Event('focus')); true`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
    assert.equal(
      requests.filter((url) => url.startsWith('http://127.0.0.1:8188')).length,
      0,
      'The disabled local integration still contacted the local runtime'
    )

    const embeddedUrl = new URL(appUrl)
    embeddedUrl.searchParams.set('user_id', '1')
    embeddedUrl.searchParams.set('token', 'embed-access-token')
    embeddedUrl.searchParams.set('theme', 'dark')
    embeddedUrl.searchParams.set('lang', 'en')
    embeddedUrl.searchParams.set('ui_mode', 'embedded')
    embeddedUrl.searchParams.set('src_host', 'https://api.cinlan.online')
    embeddedUrl.searchParams.set('src_url', 'https://api.cinlan.online/custom/smoke')
    await client.send('Page.navigate', { url: embeddedUrl.toString() })
    await waitForEvaluation(client, `!new URL(location.href).searchParams.has('token')`, 20_000)
    await waitForEvaluation(client, `document.body.innerText.includes('My work') && document.body.innerText.includes('Mock Async Image')`, 20_000)
    const embeddedState = await client.evaluate(`(() => ({
      theme: localStorage.getItem('theme'),
      locale: localStorage.getItem('locale'),
      dark: document.documentElement.classList.contains('dark'),
      token: new URL(location.href).searchParams.get('token'),
      userId: new URL(location.href).searchParams.get('user_id'),
      authToken: localStorage.getItem('auth_token'),
      apiKey: localStorage.getItem('cinlan_studio_api_key'),
      icon: document.querySelector('link[rel~="icon"]')?.getAttribute('href') ?? null,
    }))()`)
    assert.deepEqual(embeddedState, {
      theme: 'dark',
      locale: 'en',
      dark: true,
      token: null,
      userId: null,
      authToken: null,
      apiKey: null,
      icon: '/brand/cinlan-mark.png',
    })
    assert.equal(await client.evaluate(`fetch('/brand/cinlan-mark.png').then((response) => response.ok)`), true)
    return true
  } finally {
    client?.close()
    terminateProcess(browser)
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
    const tempRoot = resolve(tmpdir()) + sep
    const resolvedBrowserRoot = resolve(browserRoot)
    if (resolvedBrowserRoot.startsWith(tempRoot) && basename(resolvedBrowserRoot).startsWith('cinlan-studio-smoke-')) {
      try {
        rmSync(resolvedBrowserRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch {
        // A terminating browser may briefly retain profile locks on Windows.
      }
    }
  }
}

async function main() {
  const requests = []
  let degradeModels = false
  let groupRetryAttempts = 0
  let sizeCompatibilityAttempts = 0
  let transientCatalogCalls = 0
  let expiringCatalogCalls = 0
  const mock = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const body = request.method === 'POST' ? await readBody(request) : {}
    requests.push({ path: url.pathname, method: request.method, headers: request.headers, body, at: Date.now() })

    if (request.method === 'POST' && url.pathname === '/api/v1/auth/login') {
      if (body.email === 'invalid@example.com') return json(response, 401, { message: 'invalid credentials' })
      return json(response, 200, {
        access_token: 'embed-access-token',
        refresh_token: 'smoke-refresh-token',
        expires_in: 3600,
        user: { id: 1, email: 'login@example.com', username: 'Login User', balance: 88 },
      })
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/auth/me') {
      const token = String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
      if (token !== 'embed-access-token') return json(response, 401, { message: 'invalid embed token' })
      return json(response, 200, { id: 1, email: 'embed@example.com', username: 'Embedded User', balance: 88 })
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/keys') {
      return json(response, 200, { data: [] })
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/groups/available') {
      return json(response, 200, { data: [{ id: 7, name: 'Studio', platform: 'composite', allow_image_generation: true }] })
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/keys') {
      return json(response, 200, { id: 70, key: 'sk-embed', name: 'Cinlan Studio', status: 'active', group_id: body.group_id })
    }
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      await new Promise((resolveWait) => setTimeout(resolveWait, 500))
      const token = String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
      if (degradeModels) return json(response, 503, { message: 'catalog unavailable' })
      if (token === 'sk-retry-catalog') {
        transientCatalogCalls += 1
        if (transientCatalogCalls === 2) return json(response, 503, { message: 'transient catalog failure' })
      }
      if (token === 'sk-expiring-catalog') {
        expiringCatalogCalls += 1
        if (expiringCatalogCalls >= 2) return json(response, 401, { message: 'expired catalog key' })
      }
      const models = token === 'sk-empty' ? ['mock-text-only'] : FULL_MODELS
      return json(response, 200, { data: models.map((id) => ({ id })) })
    }
    if (request.method === 'POST' && url.pathname === '/v1/images/generations/async') {
      if (body.model === 'gpt-image-size-validation') {
        sizeCompatibilityAttempts += 1
        if (body.size !== '1024x1024') return json(response, 400, { message: '$width must be one of: 768, 832, 848, 864, 896, 928, 1024, 1088, 1136' })
        return json(response, 200, { data: [{ b64_json: PNG }] })
      }
      if (body.model === 'mock-gateway-fallback-image') return json(response, 404, { message: 'async image endpoint unavailable' })
      if (body.model === 'mock-gateway-fail-image') {
        response.writeHead(502)
        response.end()
        return
      }
      if (body.model === 'mock-group-retry-image') {
        groupRetryAttempts += 1
        if (groupRetryAttempts === 1) return json(response, 400, { message: 'Image generation is not enabled for this group' })
        return json(response, 404, { message: 'async image storage disabled' })
      }
      if (body.model === 'mock-sync-image') return json(response, 404, { message: 'async image storage disabled' })
      return json(response, 200, { task_id: 'mock-task-1' })
    }
    if (request.method === 'POST' && url.pathname === '/v1/images/generations') {
      if (body.model === 'mock-gateway-fail-image') {
        response.writeHead(502)
        response.end()
        return
      }
      return json(response, 200, { request_id: 'mock-sync-request', data: [{ b64_json: PNG }] })
    }
    if (request.method === 'POST' && url.pathname === '/v1/images/edits/async') {
      return json(response, 404, { message: 'async image storage disabled' })
    }
    if (request.method === 'POST' && url.pathname === '/v1/images/edits') {
      if (String(body.prompt ?? '').includes('smoke sync image')) await new Promise((resolveWait) => setTimeout(resolveWait, 500))
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      response.write(`event: image_edit.partial_image\ndata: ${JSON.stringify({ type: 'image_edit.partial_image', b64_json: PNG, partial_image_index: 0 })}\n\n`)
      response.end(`event: image_edit.completed\ndata: ${JSON.stringify({ type: 'image_edit.completed', b64_json: PNG })}\n\n`)
      return
    }
    if (request.method === 'GET' && url.pathname === '/v1/images/tasks/mock-task-1') {
      return json(response, 200, { status: 'completed', result: { data: [{ url: `data:image/png;base64,${PNG}` }] } })
    }
    if (request.method === 'POST' && url.pathname === '/v1/videos/generations') {
      return json(response, 200, { task_id: 'video-task-1', status: 'processing', poll_url: '/v1/videos/video-task-1' })
    }
    if (request.method === 'GET' && url.pathname === '/v1/images/tasks/video-task-1') {
      return json(response, 404, { message: 'image task not found' })
    }
    if (request.method === 'GET' && url.pathname === '/v1/videos/video-task-1') {
      return json(response, 200, { id: 'video-task-1', model: 'mock-video-one', status: 'completed', video: { url: 'https://media.example/video.mp4', cover_url: 'https://media.example/cover.jpg', duration: 8 } })
    }
    if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
      if (body.stream === true) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'reasoning ' } }] })}\n\n`)
        await new Promise((resolveWait) => setTimeout(resolveWait, 40))
        response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'stream result' } }] })}\n\ndata: [DONE]\n\n`)
        return
      }
      return json(response, 200, { choices: [{ message: { content: 'reasoning smoke result' } }] })
    }
    return json(response, 404, { message: 'not found' })
  })

  const mockPort = await listen(mock)
  const appPort = await freePort()
  const appUrl = `http://localhost:${appPort}`
  const logs = []
  const nextCli = join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next')
  const app = spawn(process.execPath, [nextCli, 'dev', '-p', String(appPort)], {
    cwd: ROOT,
    env: {
      ...process.env,
      SUB2API_BASE_URL: `http://127.0.0.1:${mockPort}`,
      SUB2API_STUDIO_IMAGE_GROUP_ID: '7',
      SUB2API_STUDIO_TEXT_GROUP_ID: '7',
      SUB2API_STUDIO_VIDEO_GROUP_ID: '7',
      CINLAN_ALLOW_API_KEY_LOGIN: 'true',
      CINLAN_SESSION_SECRET: 'cinlan-studio-smoke-session-secret',
      CINLAN_EMBEDDED: 'true',
      CINLAN_FRAME_ANCESTORS: "'self' https://api.cinlan.online",
      CINLAN_ALLOWED_ORIGINS: 'https://api.cinlan.online',
      NEXT_PUBLIC_LOCAL_GENERATION_ENABLED: 'true',
      NEXT_PUBLIC_LOCAL_RUNTIME_URL: 'http://127.0.0.1:8188',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  })
  app.stdout.on('data', (chunk) => logs.push(chunk.toString()))
  app.stderr.on('data', (chunk) => logs.push(chunk.toString()))

  try {
    await waitForHttp(appUrl, 90_000)

    const rootResponse = await fetch(appUrl)
    assert.match(await rootResponse.text(), /\/brand\/cinlan-mark\.png/)
    assert.equal(rootResponse.headers.get('content-security-policy'), "frame-ancestors 'self' https://api.cinlan.online")
    assert.equal(rootResponse.headers.get('referrer-policy'), 'no-referrer')
    for (const name of ['editorial-still-life.png', 'futuristic-tea-room.png', 'indigo-botanical-poster.png', 'rainy-cinematic-portrait.png']) {
      const assetResponse = await fetch(`${appUrl}/inspiration/${name}`)
      assert.equal(assetResponse.status, 200)
      assert.equal(assetResponse.headers.get('content-type'), 'image/png')
    }

    const preview = await fetchJson(`${appUrl}/api/v1/models`)
    assert.equal(preview.response.status, 200)
    assert.equal(preview.value.authoritative, false)
    assert.equal(preview.value.models.some((model) => model.slug === 'gpt-image-2'), true)
    const creativeConfig = await fetchJson(`${appUrl}/api/v1/creative/config`)
    assert.deepEqual(creativeConfig.value, {
      enabled: false,
      database: 'postgresql',
      asset_storage: 'filesystem',
      planner_enabled: true,
      features: { image: true, text: true, video: true },
      feature_status: {
        image: { configured: true, available: true, degraded: false, group_id: 7 },
        text: { configured: true, available: true, degraded: false, group_id: 7 },
        video: { configured: true, available: true, degraded: false, group_id: 7 },
      },
      api_key_login_enabled: true,
    })
    const disabledCreative = await fetchJson(`${appUrl}/api/v1/creative/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-2', prompt: 'disabled core smoke' }),
    })
    assert.equal(disabledCreative.response.status, 503)
    assert.equal(disabledCreative.value.code, 'CREATIVE_CORE_DISABLED')
    const previewImageFields = preview.value.models.find((model) => model.slug === 'gpt-image-2')?.form_config?.fields ?? []
    assert.equal(previewImageFields.some((field) => field.type === 'aspect_ratio'), false)
    assert.equal(previewImageFields.some((field) => field.type === 'resolution'), false)
    assert.deepEqual(previewImageFields.find((field) => field.type === 'quality')?.options, ['low', 'medium', 'high'])
    assert.equal(previewImageFields.find((field) => field.type === 'quality')?.default, 'high')
    const previewVideoFields = preview.value.models.find((model) => model.slug === 'grok-imagine-video')?.form_config?.fields ?? []
    assert.deepEqual(previewVideoFields.map((field) => field.type), ['aspect_ratio', 'duration'])

    const accountLogin = await fetchJson(`${appUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'login@example.com', password: 'smoke-password' }),
    })
    assert.equal(accountLogin.response.status, 200)
    assert.ok(cookieFrom(accountLogin.response).startsWith('cinlan_session='))
    assert.equal(accountLogin.value.user.id, 1)
    assert.equal(accountLogin.value.balance, 88)

    const embeddedMismatch = await fetchJson(`${appUrl}/api/v1/auth/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'embed-access-token', user_id: 2, src_host: 'https://api.cinlan.online' }),
    })
    assert.equal(embeddedMismatch.response.status, 403)
    assert.equal(embeddedMismatch.value.code, 'EMBED_USER_MISMATCH')

    const blockedEmbedSource = await fetchJson(`${appUrl}/api/v1/auth/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'embed-access-token', user_id: 1, src_host: 'https://untrusted.example' }),
    })
    assert.equal(blockedEmbedSource.response.status, 403)
    assert.equal(blockedEmbedSource.value.code, 'EMBED_SOURCE_NOT_ALLOWED')

    const embeddedConnection = await fetchJson(`${appUrl}/api/v1/auth/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'embed-access-token', user_id: 1, src_host: 'https://api.cinlan.online' }),
    })
    assert.equal(embeddedConnection.response.status, 200)
    assert.equal(embeddedConnection.response.headers.get('cache-control'), 'no-store, max-age=0')
    assert.ok(cookieFrom(embeddedConnection.response).startsWith('cinlan_session='))
    assert.equal(embeddedConnection.value.user.id, 1)
    const embeddedKeyRequest = requests.find((item) => item.path === '/api/v1/keys' && item.method === 'POST')
    assert.equal(embeddedKeyRequest?.body?.name, 'Cinlan Studio')
    assert.equal(embeddedKeyRequest?.body?.group_id, 7)

    const emptyConnection = await fetchJson(`${appUrl}/api/v1/auth/key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'sk-empty' }),
    })
    assert.equal(emptyConnection.response.status, 200)
    const emptyCookie = cookieFrom(emptyConnection.response)
    const emptyCatalog = await fetchJson(`${appUrl}/api/v1/models`, { headers: { Cookie: emptyCookie } })
    assert.equal(emptyCatalog.value.authoritative, true)
    assert.deepEqual(emptyCatalog.value.models.map((model) => model.slug), ['mock-text-only'])

    const connection = await fetchJson(`${appUrl}/api/v1/auth/key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'sk-smoke' }),
    })
    assert.equal(connection.response.status, 200)
    const cookie = cookieFrom(connection.response)
    assert.ok(cookie.startsWith('cinlan_session='))

    const catalog = await fetchJson(`${appUrl}/api/v1/models`, { headers: { Cookie: cookie } })
    assert.equal(catalog.value.authoritative, true)
    assert.equal(catalog.value.degraded, false)
    assert.deepEqual(catalog.value.models.map((model) => model.slug), FULL_MODELS)

    degradeModels = true
    const degraded = await fetchJson(`${appUrl}/api/v1/models`, { headers: { Cookie: cookie } })
    degradeModels = false
    assert.equal(degraded.response.status, 200)
    assert.equal(degraded.value.authoritative, true)
    assert.equal(degraded.value.degraded, true)
    assert.deepEqual(degraded.value.models, [])

    const asyncGeneration = await fetchJson(`${appUrl}/api/v1/generate/image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ model: 'mock-async-image', prompt: 'async smoke' }),
    })
    assert.equal(asyncGeneration.response.status, 200)
    assert.equal(asyncGeneration.value.status, 'IN_PROGRESS')
    assert.equal(asyncGeneration.value.id, 'mock-task-1')
    const asyncGenerationCall = requests.find((item) => item.path === '/v1/images/generations/async' && item.body?.prompt === 'async smoke')
    assert.equal(asyncGenerationCall?.body?.n, undefined, 'Single-image requests must not send the unsupported n parameter')
    const task = await fetchJson(`${appUrl}/api/v1/tasks/mock-task-1`, { headers: { Cookie: cookie } })
    assert.equal(task.value.status, 'COMPLETED')
    assert.ok(task.value.result_url.startsWith('data:image/png;base64,'))

    const syncGeneration = await fetchJson(`${appUrl}/api/v1/generate/image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ model: 'mock-sync-image', prompt: 'sync smoke' }),
    })
    assert.equal(syncGeneration.response.status, 200)
    assert.equal(syncGeneration.value.status, 'COMPLETED')
    assert.ok(syncGeneration.value.result_url.startsWith('data:image/png;base64,'))

    const syncCalls = requests.filter((item) => item.body?.model === 'mock-sync-image')
    assert.deepEqual(syncCalls.map((item) => item.path), ['/v1/images/generations/async', '/v1/images/generations'])
    assert.equal(syncCalls[0].headers['idempotency-key'], syncCalls[1].headers['idempotency-key'])

    const gatewayFallback = await fetchJson(`${appUrl}/api/v1/generate/image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ model: 'mock-gateway-fallback-image', prompt: 'gateway fallback smoke' }),
    })
    assert.equal(gatewayFallback.response.status, 200)
    assert.equal(gatewayFallback.value.status, 'COMPLETED')
    const gatewayFallbackCalls = requests.filter((item) => item.body?.model === 'mock-gateway-fallback-image')
    assert.deepEqual(gatewayFallbackCalls.map((item) => item.path), ['/v1/images/generations/async', '/v1/images/generations'])
    assert.equal(new Set(gatewayFallbackCalls.map((item) => item.headers['idempotency-key'])).size, 1)

    const gatewayFailure = await fetchJson(`${appUrl}/api/v1/generate/image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ model: 'mock-gateway-fail-image', prompt: 'gateway failure smoke' }),
    })
    assert.equal(gatewayFailure.response.status, 502)
    assert.equal(gatewayFailure.value.code, 'UPSTREAM_HTTP_502')
    assert.notEqual(gatewayFailure.value.message, '<none>')
    assert.match(gatewayFailure.value.message, /Sub2API upstream request failed|Bad Gateway|HTTP 502/)

    const autoSizeGeneration = await fetchJson(`${appUrl}/api/v1/generate/image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ model: 'gpt-image-2', prompt: 'automatic canvas smoke', quality: 'high' }),
    })
    assert.equal(autoSizeGeneration.response.status, 200)
    const autoSizeCall = requests.find((item) => item.path === '/v1/images/generations/async' && item.body?.prompt === 'automatic canvas smoke')
    assert.equal(autoSizeCall?.body?.size, '1024x1024')
    assert.equal(autoSizeCall?.body?.background, undefined)
    assert.equal(autoSizeCall?.body?.output_format, undefined)
    assert.equal(autoSizeCall?.body?.aspect_ratio, undefined)

    const sizeCompatibilityGeneration = await fetchJson(`${appUrl}/api/v1/generate/image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ model: 'gpt-image-size-validation', prompt: 'size compatibility smoke', aspectRatio: '16:9', quality: 'high' }),
    })
    assert.equal(sizeCompatibilityGeneration.response.status, 200)
    assert.equal(sizeCompatibilityGeneration.value.status, 'COMPLETED')
    assert.equal(sizeCompatibilityAttempts, 2)
    const sizeCompatibilityCalls = requests.filter((item) => item.body?.model === 'gpt-image-size-validation')
    assert.deepEqual(sizeCompatibilityCalls.map((item) => item.body?.size), ['1280x720', '1024x1024'])

    const disabledTransparentInference = await fetchJson(`${appUrl}/api/v1/generate/image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ model: 'gpt-image-2', prompt: 'logo，透明底图' }),
    })
    assert.equal(disabledTransparentInference.response.status, 200)
    const disabledTransparentCall = requests.find((item) => item.path === '/v1/images/generations/async' && item.body?.prompt === 'logo，透明底图')
    assert.equal(disabledTransparentCall?.body?.background, undefined)
    assert.equal(disabledTransparentCall?.body?.output_format, undefined)

    const jpegGeneration = await fetchJson(`${appUrl}/api/v1/generate/image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ model: 'gpt-image-2', prompt: 'explicit jpeg smoke', output_format: 'jpeg' }),
    })
    assert.equal(jpegGeneration.response.status, 200)
    const jpegCall = requests.find((item) => item.path === '/v1/images/generations/async' && item.body?.prompt === 'explicit jpeg smoke')
    assert.equal(jpegCall?.body?.output_format, 'jpeg')
    assert.equal(jpegCall?.body?.background, undefined)

    const aspectGeneration = await fetchJson(`${appUrl}/api/v1/generate/image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ model: 'gpt-image-2', prompt: 'wide smoke', aspectRatio: '3:2', quality: 'high' }),
    })
    assert.equal(aspectGeneration.response.status, 200)
    const aspectCall = requests.find((item) => item.path === '/v1/images/generations/async' && item.body?.prompt === 'wide smoke')
    assert.equal(aspectCall?.body?.aspect_ratio, undefined)
    assert.equal(aspectCall?.body?.n, undefined)
    assert.equal(aspectCall?.body?.size, '1536x1024')
    assert.equal(aspectCall?.body?.quality, 'high')
    assert.equal(aspectCall?.body?.background, undefined)
    assert.equal(aspectCall?.body?.output_format, undefined)

    for (const [prompt, expectedSize] of [
      ['prompt ratio smoke 4:5', '896x1120'],
      ['prompt ratio smoke 16:9', '1280x720'],
      ['prompt ratio smoke 1080：1920', '720x1280'],
    ]) {
      const inferredRatioGeneration = await fetchJson(`${appUrl}/api/v1/generate/image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ model: 'gpt-image-2', prompt, quality: 'high' }),
      })
      assert.equal(inferredRatioGeneration.response.status, 200)
      const inferredRatioCall = requests.find((item) => item.path === '/v1/images/generations/async' && item.body?.prompt === prompt)
      assert.equal(inferredRatioCall?.body?.size, expectedSize)
    }

    const bannerPrompt = '尺寸调整 1600*440 电商租赁 Banner，绿色渐变科技感背景；左侧大标题「租享好物狂欢季」；尺寸长440宽1660'
    const bannerGeneration = await fetchJson(`${appUrl}/api/v1/generate/image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ model: 'gpt-image-2', prompt: bannerPrompt, quality: 'high' }),
    })
    assert.equal(bannerGeneration.response.status, 200)
    const bannerCall = requests.find((item) => item.path === '/v1/images/generations/async' && item.body?.prompt === bannerPrompt)
    assert.equal(bannerCall?.body?.size, '1536x512')
    assert.equal(bannerCall?.body?.aspect_ratio, undefined)

    const squareGeneration = await fetchJson(`${appUrl}/api/v1/generate/image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ model: 'gpt-image-2', prompt: 'square smoke', aspectRatio: '1:1', quality: 'high' }),
    })
    assert.equal(squareGeneration.response.status, 200)
    const squareCall = requests.find((item) => item.path === '/v1/images/generations/async' && item.body?.prompt === 'square smoke')
    assert.equal(squareCall?.body?.aspect_ratio, undefined)
    assert.equal(squareCall?.body?.size, '1024x1024')

    const resolutionGeneration = await fetchJson(`${appUrl}/api/v1/generate/image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ model: 'gpt-image-2', prompt: '4k smoke', aspectRatio: '16:9', resolution: '4K', quality: 'high' }),
    })
    assert.equal(resolutionGeneration.response.status, 200)
    const resolutionCall = requests.find((item) => item.path === '/v1/images/generations/async' && item.body?.prompt === '4k smoke')
    assert.equal(resolutionCall?.body?.size, '3840x2160')

    const multiForm = new FormData()
    multiForm.set('model', 'gpt-image-2')
    multiForm.set('prompt', 'multi reference smoke')
    multiForm.set('quality', 'high')
    multiForm.set('aspectRatio', '9:16')
    multiForm.set('resolution', '2K')
    multiForm.append('image[]', new Blob([Buffer.from(PNG, 'base64')], { type: 'image/png' }), 'one.png')
    multiForm.append('image[]', new Blob([Buffer.from(PNG, 'base64')], { type: 'image/png' }), 'two.png')
    const multiGeneration = await fetchJson(`${appUrl}/api/v1/generate/image`, { method: 'POST', headers: { Cookie: cookie }, body: multiForm })
    assert.equal(multiGeneration.response.status, 200)
    assert.equal(multiGeneration.value.status, 'COMPLETED')
    const multiCalls = requests.filter((item) => item.body?.prompt?.includes('User instruction: multi reference smoke'))
    assert.equal(multiCalls.length, 2)
    assert.equal(multiCalls.every((item) => item.body.n === undefined), true)
    assert.equal(multiCalls.every((item) => Array.isArray(item.body['image[]']) && item.body['image[]'].length === 2), true)
    assert.equal(multiCalls.every((item) => item.body.size === '1152x2048'), true)

    const videoGeneration = await fetchJson(`${appUrl}/api/v1/generate/video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ model: 'mock-video-one', prompt: 'video smoke', aspectRatio: '9:16', duration: 8, imageUrls: ['data:image/png;base64,one', 'data:image/png;base64,two'] }),
    })
    assert.equal(videoGeneration.response.status, 200)
    assert.equal(videoGeneration.value.task_id, 'video-task-1')
    const videoSubmit = requests.find((item) => item.path === '/v1/videos/generations' && item.body?.prompt === 'video smoke')
    assert.deepEqual(videoSubmit?.body?.image_urls, ['data:image/png;base64,one', 'data:image/png;base64,two'])
    assert.equal(videoSubmit?.body?.aspect_ratio, '9:16')
    assert.equal(videoSubmit?.body?.duration, 8)
    assert.equal(videoSubmit?.body?.resolution, undefined)
    assert.equal(videoSubmit?.body?.n, undefined)
    const videoTask = await fetchJson(`${appUrl}/api/v1/tasks/video-task-1`, { headers: { Cookie: cookie } })
    assert.equal(videoTask.value.status, 'COMPLETED')
    assert.equal(videoTask.value.result_url, 'https://media.example/video.mp4')
    assert.equal(videoTask.value.cover_url, 'https://media.example/cover.jpg')
    assert.equal(videoTask.value.duration, 8)

    const groupRetryGeneration = await fetchJson(`${appUrl}/api/v1/generate/image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ model: 'mock-group-retry-image', prompt: 'group retry smoke' }),
    })
    assert.equal(groupRetryGeneration.response.status, 200)
    assert.equal(groupRetryGeneration.value.status, 'COMPLETED')
    assert.equal(groupRetryAttempts, 2)
    const groupRetryCalls = requests.filter((item) => item.body?.model === 'mock-group-retry-image')
    assert.equal(new Set(groupRetryCalls.map((item) => item.headers['idempotency-key'])).size, 1)

    const textGeneration = await fetchJson(`${appUrl}/api/v1/generate/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ model: 'mock-text-two', prompt: 'reasoning smoke', reasoning_effort: 'xhigh' }),
    })
    assert.equal(textGeneration.response.status, 200)
    assert.equal(textGeneration.value.result.choices[0].message.content, 'reasoning smoke result')
    const textCall = requests.find((item) => item.path === '/v1/chat/completions' && item.body?.messages?.[0]?.content === 'reasoning smoke')
    assert.equal(textCall?.body?.reasoning_effort, 'xhigh')

    const textStreamResponse = await fetch(`${appUrl}/api/v1/generate/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ model: 'mock-text-two', prompt: 'streaming smoke', stream: true }),
    })
    assert.equal(textStreamResponse.status, 200)
    assert.match(textStreamResponse.headers.get('content-type') || '', /text\/event-stream/)
    const textStreamBody = await textStreamResponse.text()
    assert.match(textStreamBody, /reasoning /)
    assert.match(textStreamBody, /stream result/)
    assert.match(textStreamBody, /\[DONE\]/)
    const textStreamCall = requests.find((item) => item.path === '/v1/chat/completions' && item.body?.messages?.[0]?.content === 'streaming smoke')
    assert.equal(textStreamCall?.body?.stream, true)

    const browserSmokeRan = await runBrowserSmoke(appUrl, () => requests)
    if (browserSmokeRan) {
      const browserImageCalls = requests.filter((item) => item.body?.prompt?.includes('User instruction: smoke sync image') && item.path.startsWith('/v1/images/edits'))
      const browserAsyncCalls = browserImageCalls.filter((item) => item.path === '/v1/images/edits/async')
      const browserSyncCalls = browserImageCalls.filter((item) => item.path === '/v1/images/edits')
      assert.equal(browserAsyncCalls.length, 4)
      assert.equal(browserSyncCalls.length, 4)
      assert.equal(browserImageCalls.every((item) => item.body.n === undefined), true)
      assert.equal(browserImageCalls.every((item) => item.body.image?.type === 'image/png' && item.body.image?.size > 0), true)
      assert.equal(browserSyncCalls.every((item) => item.body.stream === 'true' && item.body.partial_images === '1'), true)
    }
    console.log('Studio smoke test passed')
  } catch (error) {
    const tail = logs.join('').split(/\r?\n/).slice(-30).join('\n')
    if (tail) console.error(tail)
    throw error
  } finally {
    terminateProcess(app)
    await closeServer(mock)
  }
}

await main()
