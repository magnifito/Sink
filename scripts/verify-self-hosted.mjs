import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'

// An external URL exercises the same contract against a built Docker container.
const external = process.env.SINK_TEST_URL
const port = external ? undefined : await availablePort()
const base = external || `http://127.0.0.1:${port}`
const token = external ? process.env.NUXT_SITE_TOKEN : randomBytes(32).toString('hex')
assert(token, 'Set NUXT_SITE_TOKEN when testing an external container')
const directory = external ? undefined : await mkdtemp(join(tmpdir(), 'sink-runtime-'))
const serverEnv = {
  NODE_ENV: 'production',
  HOST: '127.0.0.1',
  PORT: String(port),
  NUXT_SITE_TOKEN: token,
  NUXT_DATA_DIR: directory,
  NUXT_DISABLE_AUTO_BACKUP: 'true',
  NUXT_PUBLIC_PREVIEW_MODE: '',
}
const slugs = []
let child
let logs = ''
let checks = 0

async function availablePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

async function request(path, { expected = 200, auth = true, json, ...options } = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    redirect: 'manual',
    headers: {
      ...(auth ? { Authorization: `Bearer ${token}` } : {}),
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
    body: json ? JSON.stringify(json) : options.body,
  })
  assert.equal(response.status, expected, `${path}: ${response.status} ${response.status === expected ? '' : await response.text()}`)
  checks++
  return response
}

async function start() {
  child = spawn(process.execPath, ['.output/server/index.mjs'], {
    env: serverEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', chunk => logs += chunk)
  child.stderr.on('data', chunk => logs += chunk)
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null)
      throw new Error(`Server exited: ${logs}`)
    try {
      if ((await fetch(`${base}/api/verify`, { headers: { Authorization: `Bearer ${token}` } })).ok)
        return
    }
    catch {}
    await delay(100)
  }
  throw new Error(`Server did not become ready: ${logs}`)
}

async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null)
    return
  const stopped = once(child, 'exit')
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
  await stopped
  clearTimeout(timer)
}

async function rejectsStartup(overrides, expectedError) {
  const probe = spawn(process.execPath, ['.output/server/index.mjs'], {
    env: { ...serverEnv, ...overrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  probe.stdout.on('data', chunk => output += chunk)
  probe.stderr.on('data', chunk => output += chunk)
  const timer = setTimeout(() => probe.kill('SIGKILL'), 5_000)
  const [code] = await once(probe, 'exit')
  clearTimeout(timer)
  assert.equal(code, 1, `Invalid configuration did not stop the server: ${output}`)
  assert(output.includes(expectedError), output)
  checks++
}

async function create(fields) {
  const slug = `docker-${randomBytes(5).toString('hex')}`
  slugs.push(slug)
  return (await request('/api/link/create', {
    method: 'POST',
    expected: 201,
    json: { slug, url: 'https://example.com/', ...fields },
  })).json()
}

try {
  if (!external) {
    await rejectsStartup({ NUXT_SITE_TOKEN: '' }, 'Node runtime requires NUXT_SITE_TOKEN')
    await rejectsStartup({ NUXT_ANALYTICS_RETENTION_DAYS: '0' }, 'NUXT_ANALYTICS_RETENTION_DAYS must be a positive integer')
    await start()
  }
  await request('/_health', { auth: false })
  await request('/dashboard/links', { auth: false })
  await request('/api/link/list', { auth: false, expected: 401 })
  await request('/api/verify')
  const { link } = await create({ tags: ['docker-test'], redirectWithQuery: true })
  await request('/api/link/create', { method: 'POST', expected: 409, json: { slug: link.slug, url: 'https://other.example/' } })
  const redirect = await request(`/${link.slug}?source=test`, { auth: false, expected: 301 })
  assert.equal(redirect.headers.get('location'), 'https://example.com/?source=test')
  const list = await (await request('/api/link/list?tag=docker-test')).json()
  assert(list.links.some(item => item.slug === link.slug))

  const counters = await (await request(`/api/stats/counters?id=${link.id}`)).json()
  assert.equal(Number(counters.data[0].visits), 1)
  for (const path of ['views?unit=minute&clientTimezone=Europe/Sofia', 'heatmap?clientTimezone=Europe/Sofia', 'metrics?type=browser']) {
    const data = await (await request(`/api/stats/${path}&id=${link.id}`)).json()
    assert(data.data.length > 0, `Empty ${path}`)
  }
  const events = await (await request(`/api/logs/events?id=${link.id}`)).json()
  assert.equal(events.length, 1)
  assert(Number.isFinite(events[0].timestamp))
  assert.equal(events[0].ip, undefined)
  await request(`/api/logs/locations?id=${link.id}`)
  const csv = await (await request(`/api/stats/export?id=${link.id}`)).text()
  assert(csv.includes(link.slug))
  await request('/api/location')
  await request('/api/link/ai?url=https://example.com', { expected: 501 })

  await request('/api/link/edit', { method: 'PUT', expected: 201, json: { ...link, url: 'https://example.org/', tags: ['edited'] } })
  assert.equal((await request(`/${link.slug}`, { auth: false, expected: 301 })).headers.get('location'), 'https://example.org/')
  const protectedLink = await create({ password: 'secret-passphrase' })
  await request(`/${protectedLink.link.slug}`, { auth: false })
  await request(`/${protectedLink.link.slug}`, { auth: false, expected: 403, headers: { 'x-link-password': 'wrong' } })
  await request(`/${protectedLink.link.slug}`, { auth: false, expected: 301, headers: { 'x-link-password': 'secret-passphrase' } })

  const expiredSlug = `expired-${randomBytes(5).toString('hex')}`
  slugs.push(expiredSlug)
  const imported = await (await request('/api/link/import', {
    method: 'POST',
    json: { version: '1.0', links: [{ slug: expiredSlug, url: 'https://example.com', expiration: 1 }] },
  })).json()
  assert.equal(imported.success, 1)
  await request(`/${expiredSlug}`, { auth: false, expected: 404 })

  const image = new FormData()
  image.set('slug', link.slug)
  image.set('file', new Blob([Uint8Array.from([137, 80, 78, 71])], { type: 'image/png' }), 'test.png')
  const uploaded = await (await request('/api/upload/image', { method: 'POST', body: image })).json()
  const object = await request(uploaded.url, { auth: false })
  assert.equal(object.headers.get('content-type'), 'image/png')
  assert.deepEqual(new Uint8Array(await object.arrayBuffer()), Uint8Array.from([137, 80, 78, 71]))
  await request('/_assets/backups/secret.json', { auth: false, expected: 403 })
  await request('/api/backup', { method: 'POST' })

  const exported = await (await request('/api/link/export?status=all')).json()
  assert(exported.links.some(item => item.slug === link.slug))
  const roundTrip = await (await request('/api/link/import', { method: 'POST', json: { version: '1.0', links: exported.links.filter(item => item.slug === link.slug) } })).json()
  assert.equal(roundTrip.skipped, 1)

  if (!external) {
    await stop()
    const db = new DatabaseSync(join(directory, 'sink.sqlite'))
    const backup = db.prepare('SELECT filename FROM sink_objects WHERE key LIKE \'backups/manual-links-%\' AND key NOT LIKE \'%.pending-%\'').get()
    assert(backup)
    const contents = JSON.parse(await readFile(join(directory, 'objects', backup.filename), 'utf8'))
    assert(contents.links.some(item => item.slug === link.slug))
    db.close()
    await start()
    await request(`/${link.slug}`, { auth: false, expected: 301 })
    await request(uploaded.url, { auth: false })
    const persisted = await (await request(`/api/stats/counters?id=${link.id}`)).json()
    assert.equal(Number(persisted.data[0].visits), 3)
    checks++
  }

  for (const slug of slugs)
    await request('/api/link/delete', { method: 'POST', expected: 204, json: { slug } })
  await request(`/${link.slug}`, { auth: false, expected: 404 })
  console.log(`PASS: ${checks} checks; links, auth, analytics, images, backup, import/export${external ? '' : ', and restart persistence'}`)
}
finally {
  await stop()
  if (directory)
    await rm(directory, { recursive: true, force: true })
}
