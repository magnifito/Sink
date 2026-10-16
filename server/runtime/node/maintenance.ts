import type { DatabaseSync } from 'node:sqlite'
import type { LocalBucket } from './bucket'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

const SNAPSHOT_PATTERN = /^sink-\d{4}-\d{2}-\d{2}\.sqlite$/

/** Parses a non-negative integer setting where 0 disables the feature. */
export function parseKeepSetting(value: unknown, name: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new Error(`${name} must be a non-negative integer`)
  return parsed
}

/**
 * Writes a consistent copy of the live database with VACUUM INTO, which includes
 * committed WAL pages, so file-level backups never need to stop the app.
 * Returns the snapshot path, or null when today's snapshot already exists.
 */
export async function snapshotDatabase(db: DatabaseSync, directory: string, keep: number, now = new Date()) {
  const target = join(directory, `sink-${now.toISOString().slice(0, 10)}.sqlite`)
  if (existsSync(target))
    return null

  await mkdir(directory, { recursive: true, mode: 0o700 })
  const staging = `${target}.pending`
  await rm(staging, { force: true })
  db.prepare('VACUUM INTO ?').run(staging)
  await rename(staging, target)

  // ISO dates sort chronologically, so the newest snapshots come last.
  const snapshots = (await readdir(directory)).filter(name => SNAPSHOT_PATTERN.test(name)).sort()
  for (const name of snapshots.slice(0, Math.max(0, snapshots.length - keep)))
    await rm(join(directory, name), { force: true })
  return target
}

/** Deletes automatic link backups older than the retention window; manual backups stay. */
export async function pruneLinkBackups(db: DatabaseSync, bucket: LocalBucket, retentionDays: number, now = new Date()) {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString().slice(0, 10)
  const rows = db.prepare('SELECT key FROM sink_objects WHERE key LIKE \'backups/links-%\' AND key < ?')
    .all(`backups/links-${cutoff}`)
  for (const row of rows)
    await bucket.delete(String(row.key))
  return rows.length
}
