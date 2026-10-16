/** Location fields consumed by redirects and analytics in either runtime. */
export interface RequestGeo {
  country?: string
  region?: string
  city?: string
  timezone?: string
  latitude?: string
  longitude?: string
  colo?: string
  botManagement?: { verifiedBot?: boolean }
}

export interface GeoStatus {
  state: 'disabled' | 'unavailable' | 'ready'
  lastReloadFailed: boolean
  databaseType?: string
  builtAt?: string
}
