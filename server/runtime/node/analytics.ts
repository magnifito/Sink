import type { DatabaseSync, SQLInputValue } from 'node:sqlite'

const formatters = new Map<string, Intl.DateTimeFormat>()

function getFormatter(timeZone: string) {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

function parts(value: string, timeZone: string) {
  const date = new Date(`${value.replace(' ', 'T')}Z`)
  return Object.fromEntries(getFormatter(timeZone).formatToParts(date).map(part => [part.type, part.value]))
}

export function setupAnalytics(db: DatabaseSync) {
  const blobs = Array.from({ length: 16 }, (_, i) => `blob${i + 1} TEXT NOT NULL DEFAULT ''`)
  db.exec(`CREATE TABLE IF NOT EXISTS sink_events (
    event_id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL, index1 TEXT NOT NULL,
    _sample_interval INTEGER NOT NULL DEFAULT 1, ${blobs.join(',')},
    double1 REAL NOT NULL DEFAULT 0, double2 REAL NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS sink_events_time ON sink_events(timestamp);
    CREATE INDEX IF NOT EXISTS sink_events_link_time ON sink_events(index1, timestamp);`)

  // These functions keep the existing, validated analytics query builders shared.
  db.function('toDateTime', { varargs: true }, (...args: SQLInputValue[]) => {
    const utc = new Date(Number(args[0]) * 1000).toISOString().slice(0, 19).replace('T', ' ')
    if (!args[1])
      return utc
    const p = parts(utc, String(args[1]))
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`
  })
  db.function('toUnixTimestamp', value => Math.floor(new Date(`${String(value).replace(' ', 'T')}Z`).getTime() / 1000))
  db.function('toDayOfWeek', value => new Date(`${String(value).replace(' ', 'T')}Z`).getUTCDay() || 7)
  db.function('toHour', value => Number(String(value).slice(11, 13)))
  db.function('formatDateTime', (value, format, timezone) => {
    const p = parts(String(value), String(timezone))
    const replacements: Record<string, string> = { '%Y': p.year!, '%m': p.month!, '%d': p.day!, '%H': p.hour!, '%i': p.minute! }
    return String(format).replace(/%[YmdHi]/g, match => replacements[match]!)
  })

  const columns = ['timestamp', 'index1', ...blobs.map((_, i) => `blob${i + 1}`), 'double1', 'double2']
  const insert = db.prepare(`INSERT INTO sink_events (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
  return {
    writeDataPoint(point: { indexes?: string[], blobs?: string[], doubles?: number[] }) {
      insert.run(
        new Date().toISOString().slice(0, 19).replace('T', ' '),
        point.indexes?.[0] ?? '',
        ...blobs.map((_, i) => point.blobs?.[i] ?? ''),
        point.doubles?.[0] ?? 0,
        point.doubles?.[1] ?? 0,
      )
    },
    query(sql: string) { return { data: db.prepare(sql).all() } },
    prune(days: number) {
      const cutoff = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 19).replace('T', ' ')
      db.prepare('DELETE FROM sink_events WHERE timestamp < ?').run(cutoff)
    },
  }
}
