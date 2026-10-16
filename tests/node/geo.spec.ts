import { copyFile, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalGeo } from '../../server/runtime/node/geo'

const directories: string[] = []
async function database() {
  const directory = await mkdtemp(join(tmpdir(), 'sink-geo-'))
  directories.push(directory)
  const path = join(directory, 'City.mmdb')
  await copyFile('tests/fixtures/geo/GeoIP2-City-Test.mmdb', path)
  return { path, geo: new LocalGeo(path) }
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('local geo lookup', () => {
  it('maps real MMDB country and city records to the shared request fields', async () => {
    const { geo } = await database()
    await geo.reload()
    expect(geo.lookup('81.2.69.142')).toMatchObject({ country: 'GB', city: 'London', timezone: 'Europe/London', latitude: '51.5142', longitude: '-0.0931' })
    expect(geo.lookup('2001:218::')).toMatchObject({ country: 'JP' })
    expect(geo.lookup('::ffff:81.2.69.142')).toEqual(geo.lookup('81.2.69.142'))
    expect(geo.status()).toMatchObject({ state: 'ready', databaseType: 'GeoIP2-City', lastReloadFailed: false })
  })

  it('returns no location for private, reserved, invalid and unknown addresses', async () => {
    const { geo } = await database()
    await geo.reload()
    for (const ip of [undefined, '', 'bad', '127.0.0.1', '10.0.0.1', '172.16.1.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '8.8.8.8'])
      expect(geo.lookup(ip), ip).toBeUndefined()
  })

  it('supports country-only databases without inventing coordinates', async () => {
    const { path, geo } = await database()
    await copyFile('tests/fixtures/geo/GeoLite2-Country-Test.mmdb', path)
    await geo.reload()
    expect(geo.lookup('81.2.69.142')).toMatchObject({ country: 'GB' })
    expect(geo.lookup('81.2.69.142')?.latitude).toBeUndefined()
  })

  it('keeps the last valid reader after a broken replacement and recovers after an atomic swap', async () => {
    const { path, geo } = await database()
    await geo.reload()
    await writeFile(path, 'not an mmdb')
    await geo.reload()
    expect(geo.lookup('81.2.69.142')?.country).toBe('GB')
    expect(geo.status()).toMatchObject({ state: 'ready', lastReloadFailed: true })
    await copyFile('tests/fixtures/geo/GeoLite2-Country-Test.mmdb', `${path}.new`)
    await rename(`${path}.new`, path)
    await geo.reload()
    expect(geo.status()).toMatchObject({ state: 'ready', lastReloadFailed: false, databaseType: 'GeoLite2-Country' })
  })

  it('starts without a database and recovers when it appears', async () => {
    const { path } = await database()
    await rm(path)
    const geo = new LocalGeo(path)
    await geo.reload()
    expect(geo.lookup('81.2.69.142')).toBeUndefined()
    expect(geo.status()).toMatchObject({ state: 'unavailable', lastReloadFailed: true })
    await copyFile('tests/fixtures/geo/GeoIP2-City-Test.mmdb', path)
    await geo.reload()
    expect(geo.lookup('81.2.69.142')?.country).toBe('GB')
  })

  it('does not expose paths or IPs in disabled status', async () => {
    const geo = new LocalGeo('')
    await geo.reload()
    expect(geo.status()).toEqual({ state: 'disabled', lastReloadFailed: false })
  })

  it('rejects unrelated MMDB editions without preventing fallback redirects', async () => {
    const { path, geo } = await database()
    const buffer = await readFile(path)
    const index = buffer.indexOf('GeoIP2-City')
    expect(index).toBeGreaterThan(0)
    buffer.write('GeoIP2-ASN!', index)
    await writeFile(path, buffer)
    await geo.reload()
    expect(geo.status()).toEqual({ state: 'unavailable', lastReloadFailed: true })
    expect(geo.lookup('81.2.69.142')).toBeUndefined()
  })
})
