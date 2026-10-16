import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalBucket } from '../../server/runtime/node/bucket'
import { LocalDatabase } from '../../server/runtime/node/database'
import { parseKeepSetting, pruneLinkBackups, snapshotDatabase } from '../../server/runtime/node/maintenance'

const resources: { db: LocalDatabase, directory: string }[] = []

async function store() {
  const directory = await mkdtemp(join(tmpdir(), 'sink-maintenance-'))
  const db = new LocalDatabase(join(directory, 'sink.sqlite'))
  const migrations = await Promise.all((await readdir('drizzle')).filter(name => name.endsWith('.sql')).map(async name => ({ name, sql: await readFile(join('drizzle', name), 'utf8') })))
  db.migrate(migrations)
  resources.push({ db, directory })
  return { db, directory, bucket: new LocalBucket(join(directory, 'objects'), db.sqlite) }
}

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    resource.db.close()
    await rm(resource.directory, { recursive: true, force: true })
  }
})

describe('node maintenance', () => {
  it('validates keep settings', () => {
    expect(parseKeepSetting('7', 'NUXT_SNAPSHOT_KEEP')).toBe(7)
    expect(parseKeepSetting(0, 'NUXT_SNAPSHOT_KEEP')).toBe(0)
    expect(() => parseKeepSetting('-1', 'NUXT_SNAPSHOT_KEEP')).toThrow('NUXT_SNAPSHOT_KEEP must be a non-negative integer')
    expect(() => parseKeepSetting('1.5', 'NUXT_SNAPSHOT_KEEP')).toThrow()
  })

  it('writes a consistent daily snapshot including uncheckpointed WAL writes', async () => {
    const { db, directory } = await store()
    await db.prepare('INSERT INTO tags VALUES (?)').bind('in-wal').run()
    const snapshots = join(directory, 'snapshots')

    const path = await snapshotDatabase(db.sqlite, snapshots, 3, new Date('2026-10-16T03:00:00Z'))
    expect(path).toBe(join(snapshots, 'sink-2026-10-16.sqlite'))
    expect(await snapshotDatabase(db.sqlite, snapshots, 3, new Date('2026-10-16T09:00:00Z'))).toBeNull()

    const copy = new DatabaseSync(path!, { readOnly: true })
    try {
      expect(copy.prepare('SELECT name FROM tags').all()).toEqual([{ name: 'in-wal' }])
    }
    finally {
      copy.close()
    }
  })

  it('keeps only the newest snapshots', async () => {
    const { db, directory } = await store()
    const snapshots = join(directory, 'snapshots')
    for (const day of ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15'])
      await snapshotDatabase(db.sqlite, snapshots, 2, new Date(`${day}T03:00:00Z`))
    expect((await readdir(snapshots)).sort()).toEqual(['sink-2026-10-14.sqlite', 'sink-2026-10-15.sqlite'])
  })

  it('prunes only automatic link backups older than the retention window', async () => {
    const { db, bucket, directory } = await store()
    for (const key of [
      'backups/links-2026-09-01T03-00-00.000Z.json',
      'backups/links-2026-10-10T03-00-00.000Z.json',
      'backups/manual-links-2026-09-01T03-00-00.000Z.json',
      'images/logo.png',
    ])
      await bucket.put(key, 'data')

    const removed = await pruneLinkBackups(db.sqlite, bucket, 30, new Date('2026-10-16T03:00:00Z'))
    expect(removed).toBe(1)
    const keys = db.sqlite.prepare('SELECT key FROM sink_objects ORDER BY key').all().map(row => row.key)
    expect(keys).toEqual([
      'backups/links-2026-10-10T03-00-00.000Z.json',
      'backups/manual-links-2026-09-01T03-00-00.000Z.json',
      'images/logo.png',
    ])
    expect(await readdir(join(directory, 'objects'))).toHaveLength(3)
  })
})
