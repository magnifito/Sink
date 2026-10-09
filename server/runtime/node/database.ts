import type { SQLInputValue } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

/** Compatibility boundary for the existing Drizzle D1 driver and atomic batches. */
export class LocalStatement {
  readonly params: SQLInputValue[]

  constructor(readonly db: DatabaseSync, readonly sql: string, params: (SQLInputValue | undefined)[] = []) {
    this.params = params.map(p => (p === undefined ? null : p)) as SQLInputValue[]
  }

  bind(...params: (SQLInputValue | undefined)[]) {
    return new LocalStatement(this.db, this.sql, params)
  }

  execute() {
    const statement = this.db.prepare(this.sql)
    const results = statement.all(...this.params)
    const meta = this.db.prepare('SELECT changes() AS changes, last_insert_rowid() AS last_row_id').get()!
    return { results, success: true, meta }
  }

  async all() { return this.execute() }
  async run() { return this.execute() }
  async first(column?: string) {
    const row = this.execute().results[0]
    return column ? row?.[column] ?? null : row ?? null
  }

  async raw() {
    const statement = this.db.prepare(this.sql)
    statement.setReturnArrays(true)
    return statement.all(...this.params)
  }
}

export class LocalDatabase {
  readonly sqlite: DatabaseSync

  constructor(filename: string) {
    this.sqlite = new DatabaseSync(filename)
    this.sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  }

  prepare(sql: string) { return new LocalStatement(this.sqlite, sql) }

  async batch(statements: LocalStatement[]) {
    // No await inside the transaction: another request cannot interleave.
    this.sqlite.exec('BEGIN IMMEDIATE')
    try {
      const results = statements.map(statement => statement.execute())
      this.sqlite.exec('COMMIT')
      return results
    }
    catch (error) {
      this.sqlite.exec('ROLLBACK')
      throw error
    }
  }

  migrate(migrations: { name: string, sql: string }[]) {
    this.sqlite.exec('CREATE TABLE IF NOT EXISTS sink_migrations (name TEXT PRIMARY KEY, hash TEXT NOT NULL)')
    for (const migration of migrations.sort((a, b) => a.name.localeCompare(b.name))) {
      const normalizedSql = migration.sql.replace(/\r\n/g, '\n')
      const hash = createHash('sha256').update(normalizedSql).digest('hex')
      const previous = this.sqlite.prepare('SELECT hash FROM sink_migrations WHERE name = ?').get(migration.name)
      if (previous) {
        if (previous.hash !== hash)
          throw new Error(`Applied migration changed: ${migration.name}`)
        continue
      }
      this.sqlite.exec('BEGIN IMMEDIATE')
      try {
        this.sqlite.exec(normalizedSql)
        this.sqlite.prepare('INSERT INTO sink_migrations VALUES (?, ?)').run(migration.name, hash)
        this.sqlite.exec('COMMIT')
      }
      catch (error) {
        this.sqlite.exec('ROLLBACK')
        throw error
      }
    }
    // Node starts with an authoritative SQLite store, never a legacy KV store.
    this.sqlite.prepare(`INSERT OR IGNORE INTO link_migration_runs
      (id, force, status, created_at, updated_at) VALUES ('self-hosted', 0, 'completed', unixepoch(), unixepoch())`).run()
  }

  close() { this.sqlite.close() }
}
