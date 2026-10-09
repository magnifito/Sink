import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { setupAnalytics } from '../../server/runtime/node/analytics'
import { LocalBucket } from '../../server/runtime/node/bucket'
import { LocalDatabase } from '../../server/runtime/node/database'

const resources: { db: LocalDatabase, directory: string }[] = []

async function store() {
  const directory = await mkdtemp(join(tmpdir(), 'sink-storage-'))
  const db = new LocalDatabase(join(directory, 'sink.sqlite'))
  const migrations = await Promise.all((await readdir('drizzle')).filter(name => name.endsWith('.sql')).map(async name => ({ name, sql: await readFile(join('drizzle', name), 'utf8') })))
  db.migrate(migrations)
  resources.push({ db, directory })
  return { db, directory, migrations }
}

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    resource.db.close()
    await rm(resource.directory, { recursive: true, force: true })
  }
})

describe('node storage boundary', () => {
  it('applies migrations once and rejects changes to applied SQL', async () => {
    const { db, migrations } = await store()
    db.migrate(migrations)
    expect(await db.prepare('SELECT count(*) AS count FROM sink_migrations').first('count')).toBe(migrations.length)
    expect(await db.prepare('SELECT status FROM link_migration_runs').first('status')).toBe('completed')
    expect(() => db.migrate([{ ...migrations[0]!, sql: `${migrations[0]!.sql}\n-- changed` }])).toThrow('Applied migration changed')
    // CRLF normalization ensures Windows-style checkouts match recorded hash
    expect(() => db.migrate([{ ...migrations[0]!, sql: migrations[0]!.sql.replace(/\n/g, '\r\n') }])).not.toThrow()
  })

  it('binds undefined parameters as null without throwing', async () => {
    const { db } = await store()
    const isNull = await db.prepare('SELECT (? IS NULL) AS is_null').bind(undefined).first('is_null')
    expect(isNull).toBe(1)
  })

  it('rolls back all writes in a failed batch', async () => {
    const { db } = await store()
    await expect(db.batch([
      db.prepare('INSERT INTO tags VALUES (?)').bind('rollback'),
      db.prepare('INSERT INTO tags VALUES (?)').bind('rollback'),
    ])).rejects.toThrow()
    expect(await db.prepare('SELECT count(*) AS count FROM tags').first('count')).toBe(0)
  })

  it('preserves changes() and ordered raw rows for the Drizzle adapter', async () => {
    const { db } = await store()
    const result = await db.batch([
      db.prepare('INSERT INTO tags VALUES (?)').bind('one'),
      db.prepare('INSERT INTO tags SELECT ? WHERE changes() = 1').bind('two'),
    ])
    expect(result.map(row => row.meta.changes)).toEqual([1, 1])
    expect(await db.prepare('SELECT name FROM tags ORDER BY name').raw()).toEqual([['one'], ['two']])
  })

  it('streams multipart objects and treats path traversal strings as opaque keys', async () => {
    const { db, directory } = await store()
    const bucket = new LocalBucket(join(directory, 'objects'), db.sqlite)
    const upload = await bucket.createMultipartUpload('../../escape', { httpMetadata: { contentType: 'text/plain' } })
    const second = await upload.uploadPart(2, 'world')
    const first = await upload.uploadPart(1, 'hello ')
    await upload.complete([second, first])
    const object = await bucket.get('../../escape')
    expect(object?.httpMetadata?.contentType).toBe('text/plain')
    expect(await new Response(object!.body).text()).toBe('hello world')
    expect((await readdir(directory)).sort()).toEqual(['objects', 'sink.sqlite', 'sink.sqlite-shm', 'sink.sqlite-wal'])
    await bucket.put('../../escape', 'replacement')
    expect(await new Response((await bucket.get('../../escape'))!.body).text()).toBe('replacement')
    await bucket.delete('../../escape')
    expect(await bucket.get('../../escape')).toBeNull()
    expect(await readdir(join(directory, 'objects'))).toEqual([])
  })

  it('aborts incomplete multipart uploads', async () => {
    const { db, directory } = await store()
    const bucket = new LocalBucket(join(directory, 'objects'), db.sqlite)
    const upload = await bucket.createMultipartUpload('backup')
    await upload.uploadPart(1, 'partial')
    await expect(upload.complete([{ partNumber: -1 }])).rejects.toThrow('Invalid multipart completion')
    await upload.abort()
    expect(await bucket.get('backup')).toBeNull()
    expect(await readdir(join(directory, 'objects'))).toEqual([])
  })

  it('cleans up abandoned multipart staging directories', async () => {
    const { db, directory } = await store()
    const bucket = new LocalBucket(join(directory, 'objects'), db.sqlite)
    await bucket.createMultipartUpload('abandoned')
    expect((await readdir(join(directory, 'objects'))).some(n => n.startsWith('upload-'))).toBe(true)
    await bucket.cleanStagedUploads()
    expect(await readdir(join(directory, 'objects'))).toEqual([])
  })

  it('handles timezone and DST buckets and removes only expired events', async () => {
    const { db } = await store()
    const analytics = setupAnalytics(db.sqlite)
    analytics.writeDataPoint({ indexes: ['link'], blobs: ['slug'] })
    const latestEvent = analytics.query('SELECT timestamp FROM sink_events ORDER BY event_id DESC LIMIT 1').data[0] as { timestamp: string }
    expect(latestEvent.timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    db.sqlite.prepare('INSERT INTO sink_events (timestamp, index1) VALUES (?, ?)').run('2000-01-01 00:00:00', 'old')
    analytics.prune(90)
    expect(analytics.query('SELECT count(*) AS count FROM sink_events').data[0]?.count).toBe(1)
    const result = analytics.query(`SELECT
      formatDateTime('2026-03-29 00:30:00', '%Y-%m-%d %H:%i', 'Europe/Sofia') AS before,
      formatDateTime('2026-03-29 01:30:00', '%Y-%m-%d %H:%i', 'Europe/Sofia') AS after,
      toDayOfWeek(toDateTime(toUnixTimestamp('2026-03-29 01:30:00'), 'Europe/Sofia')) AS weekday,
      toHour(toDateTime(toUnixTimestamp('2026-03-29 01:30:00'), 'Europe/Sofia')) AS hour`)
    expect(result.data[0]).toMatchObject({ before: '2026-03-29 02:30', after: '2026-03-29 04:30', weekday: 7, hour: 4 })
  })
})
