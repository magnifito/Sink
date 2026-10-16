import type { CityResponse } from 'maxmind'
import type { GeoStatus, RequestGeo } from '../../../shared/types/geo'
import { readFile, stat } from 'node:fs/promises'
import { BlockList, isIP } from 'node:net'
import { Reader } from 'maxmind'

const reserved = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) reserved.addSubnet(address, prefix, 'ipv4')
const globalIPv6 = new BlockList()
globalIPv6.addSubnet('2000::', 3, 'ipv6')
reserved.addSubnet('2001:db8::', 32, 'ipv6')

/** Reads only local MMDB files. A failed update never replaces a working reader. */
export class LocalGeo {
  private reader?: Reader<CityResponse>
  private signature?: string
  private lastReloadFailed = false
  private reloading?: Promise<void>

  constructor(private readonly path: string) {}

  reload(): Promise<void> {
    this.reloading ??= this.load().finally(() => {
      this.reloading = undefined
    })
    return this.reloading
  }

  private async load() {
    if (!this.path)
      return
    try {
      const file = await stat(this.path)
      // Bound memory use before reading an operator-provided replacement.
      if (!file.isFile() || file.size > 128 * 1024 * 1024)
        throw new Error('Invalid geo database file')
      const signature = `${file.ino}:${file.size}:${file.mtimeMs}:${file.ctimeMs}`
      if (signature === this.signature) {
        this.lastReloadFailed = false
        return
      }
      const reader = new Reader<CityResponse>(await readFile(this.path))
      if (!/^(?:GeoLite2|GeoIP2)-(?:City|Country)$/.test(reader.metadata.databaseType))
        throw new Error('Unsupported geo database type')
      // Validate representative decoding before making the replacement visible.
      reader.get('81.2.69.142')
      reader.get('2001:218::')
      this.reader = reader
      this.signature = signature
      this.lastReloadFailed = false
    }
    catch {
      if (!this.lastReloadFailed)
        console.error('[node] Geo database reload failed; keeping the last valid database')
      this.lastReloadFailed = true
    }
  }

  lookup(value?: string): RequestGeo | undefined {
    if (!this.reader || !value)
      return
    // Normalize IPv4-mapped IPv6, including its hexadecimal representation.
    let ip = value
    if (isIP(ip) === 6) {
      const normalized = new URL(`http://[${ip}]/`).hostname.slice(1, -1)
      const mapped = normalized.match(/^::ffff:([\da-f]+):([\da-f]+)$/i)
      if (mapped) {
        const high = Number.parseInt(mapped[1]!, 16)
        const low = Number.parseInt(mapped[2]!, 16)
        ip = `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
      }
    }
    const family = isIP(ip)
    if (!family || reserved.check(ip, family === 4 ? 'ipv4' : 'ipv6')
      || (family === 6 && !globalIPv6.check(ip, 'ipv6'))) {
      return
    }
    try {
      const result = this.reader.get(ip)
      if (!result)
        return
      const location = result.location
      const coordinates = Number.isFinite(location?.latitude) && Number.isFinite(location?.longitude)
        && Math.abs(location!.latitude!) <= 90 && Math.abs(location!.longitude!) <= 180
      return {
        country: result.country?.iso_code,
        region: result.subdivisions?.[0]?.names?.en,
        city: result.city?.names?.en,
        timezone: location?.time_zone,
        latitude: coordinates ? String(location!.latitude) : undefined,
        longitude: coordinates ? String(location!.longitude) : undefined,
      }
    }
    catch {

    }
  }

  status(): GeoStatus {
    return {
      state: !this.path ? 'disabled' : this.reader ? 'ready' : 'unavailable',
      lastReloadFailed: this.lastReloadFailed,
      ...(this.reader && {
        databaseType: this.reader.metadata.databaseType,
        builtAt: this.reader.metadata.buildEpoch.toISOString(),
      }),
    }
  }
}
