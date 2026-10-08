import type { NitroApp } from 'nitropack/types'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setupAnalytics } from './analytics'
import { LocalBucket } from './bucket'
import { LocalDatabase } from './database'

export default defineNitroPlugin((nitroApp) => {
  const ready = initialize(nitroApp)
  nitroApp.hooks.hook('request', async (event) => {
    event.context.selfHosted = await ready
  })
  void ready.catch((error) => {
    console.error('[node] Startup failed', error)
    process.exit(1)
  })
})

async function initialize(nitroApp: NitroApp) {
  // Require the secret at runtime, never bake a generated token into an image.
  if (!process.env.NUXT_SITE_TOKEN || process.env.NUXT_SITE_TOKEN.length < 32)
    throw new Error('Node runtime requires NUXT_SITE_TOKEN with at least 32 characters')

  const config = useRuntimeConfig()
  const retentionDays = Number(config.analyticsRetentionDays)
  if (!Number.isInteger(retentionDays) || retentionDays < 1)
    throw new Error('NUXT_ANALYTICS_RETENTION_DAYS must be a positive integer')

  const directory = resolve(config.dataDir)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const database = new LocalDatabase(join(directory, 'sink.sqlite'))
  const assets = useStorage('assets:migrations')
  const keys = (await assets.getKeys()).filter(key => key.endsWith('.sql'))
  if (!keys.length)
    throw new Error('No database migrations bundled in this build')
  database.migrate(await Promise.all(keys.map(async name => ({ name, sql: String(await assets.getItem(name)) }))))
  const analytics = setupAnalytics(database.sqlite)
  const bucket = new LocalBucket(join(directory, 'objects'), database.sqlite)

  // SQLite reads are local. Bypass the remote KV cache and its legacy fallback.
  const bindings = {
    DB: database,
    KV: {
      async getWithMetadata() { return { value: null, metadata: null } },
      async put() {},
      async delete() {},
      async list() { return { keys: [], list_complete: true } },
    },
    R2: bucket,
    ANALYTICS: analytics,
  } as unknown as Cloudflare.Env

  const pending = new Set<Promise<unknown>>()
  function waitUntil(promise: Promise<unknown>) {
    const handled = promise.catch(error => console.error('[node] Background task failed', error))
    pending.add(handled)
    void handled.finally(() => pending.delete(handled))
  }

  analytics.prune(retentionDays)
  let lastBackupDay = ''
  let maintenanceRunning = false
  async function maintenance() {
    if (maintenanceRunning)
      return
    maintenanceRunning = true
    try {
      analytics.prune(retentionDays)
      const today = new Date().toISOString().slice(0, 10)
      if (!config.disableAutoBackup && today !== lastBackupDay) {
        const existing = database.sqlite.prepare('SELECT 1 FROM sink_objects WHERE key LIKE ? AND key NOT LIKE \'%.pending-%\' LIMIT 1').get(`backups/links-${today}T%`)
        if (!existing)
          await backupLinksToR2(bindings)
        lastBackupDay = today
      }
    }
    finally {
      maintenanceRunning = false
    }
  }
  const timer = setInterval(() => waitUntil(maintenance()), 60_000)
  timer.unref()
  nitroApp.hooks.hook('close', async () => {
    clearInterval(timer)
    await Promise.allSettled([...pending])
    database.close()
  })
  return { bindings, queryAnalytics: analytics.query, waitUntil }
}
