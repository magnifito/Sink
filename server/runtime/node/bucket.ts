import type { DatabaseSync } from 'node:sqlite'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

interface Metadata {
  httpMetadata?: { contentType?: string }
  customMetadata?: Record<string, string>
}

type Body = ArrayBuffer | ArrayBufferView | string | ReadableStream<Uint8Array>

function source(body: Body): Readable {
  if (body instanceof ReadableStream)
    return Readable.fromWeb(body as import('node:stream/web').ReadableStream)
  if (typeof body === 'string')
    return Readable.from([body])
  return Readable.from([ArrayBuffer.isView(body) ? Buffer.from(body.buffer, body.byteOffset, body.byteLength) : Buffer.from(body)])
}

/** Opaque filenames prevent object keys from becoming filesystem paths. */
export class LocalBucket {
  constructor(readonly directory: string, readonly db: DatabaseSync) {
    db.exec('CREATE TABLE IF NOT EXISTS sink_objects (key TEXT PRIMARY KEY, filename TEXT NOT NULL, metadata TEXT NOT NULL)')
  }

  async put(key: string, body: Body, metadata: Metadata = {}) {
    await mkdir(this.directory, { recursive: true })
    const filename = randomUUID()
    const target = join(this.directory, filename)
    try {
      await pipeline(source(body), createWriteStream(target, { flags: 'wx', mode: 0o600 }))
      const old = this.db.prepare('SELECT filename FROM sink_objects WHERE key = ?').get(key)
      this.db.prepare(`INSERT INTO sink_objects VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET filename = excluded.filename, metadata = excluded.metadata`).run(key, filename, JSON.stringify(metadata))
      if (old)
        await rm(join(this.directory, String(old.filename)), { force: true })
      return { key, etag: filename }
    }
    catch (error) {
      // A completed metadata swap must not lose its referenced file.
      const current = this.db.prepare('SELECT filename FROM sink_objects WHERE key = ?').get(key)
      if (current?.filename !== filename)
        await rm(target, { force: true })
      throw error
    }
  }

  async get(key: string) {
    const row = this.db.prepare('SELECT filename, metadata FROM sink_objects WHERE key = ?').get(key)
    if (!row)
      return null
    return {
      key,
      etag: String(row.filename),
      ...JSON.parse(String(row.metadata)) as Metadata,
      body: Readable.toWeb(createReadStream(join(this.directory, String(row.filename)))),
    }
  }

  async delete(key: string) {
    const row = this.db.prepare('DELETE FROM sink_objects WHERE key = ? RETURNING filename').get(key)
    if (row)
      await rm(join(this.directory, String(row.filename)), { force: true })
  }

  async createMultipartUpload(key: string, metadata: Metadata = {}) {
    const directory = join(this.directory, `upload-${randomUUID()}`)
    await mkdir(directory, { recursive: true })
    const put = this.put.bind(this)
    return {
      async uploadPart(partNumber: number, body: Body) {
        if (!Number.isSafeInteger(partNumber) || partNumber < 1)
          throw new Error('Invalid multipart part number')
        await pipeline(source(body), createWriteStream(join(directory, String(partNumber)), { flags: 'wx', mode: 0o600 }))
        return { partNumber, etag: String(partNumber) }
      },
      async complete(parts: { partNumber: number }[]) {
        const seen = new Set<number>()
        for (const part of parts) {
          if (!Number.isSafeInteger(part.partNumber) || part.partNumber < 1 || seen.has(part.partNumber))
            throw new Error('Invalid multipart completion')
          seen.add(part.partNumber)
        }
        async function* chunks() {
          for (const part of parts.sort((a, b) => a.partNumber - b.partNumber))
            yield* createReadStream(join(directory, String(part.partNumber)))
        }
        const result = await put(key, Readable.toWeb(Readable.from(chunks())) as ReadableStream<Uint8Array>, metadata)
        await rm(directory, { recursive: true, force: true })
        return result
      },
      async abort() { await rm(directory, { recursive: true, force: true }) },
    }
  }
}
