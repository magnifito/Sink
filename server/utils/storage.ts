import type { H3Event } from 'h3'
import type { GeoStatus, RequestGeo } from '#shared/types/geo'

export interface SelfHostedRuntime {
  bindings: Cloudflare.Env
  queryAnalytics: (sql: string) => { data: unknown[] }
  waitUntil: (promise: Promise<unknown>) => void
  geoStatus?: () => GeoStatus
}

declare module 'h3' {
  interface H3EventContext {
    selfHosted?: SelfHostedRuntime
    requestGeo?: RequestGeo
  }
}

/** The Node adapter implements only the binding operations used by Sink. */
export function getStorage(event: H3Event): Cloudflare.Env {
  return event.context.selfHosted?.bindings ?? event.context.cloudflare.env
}

export function getRequestGeo(event: H3Event) {
  // Never accept client-supplied geo headers as trusted location data on Node.
  if (event.context.selfHosted)
    return event.context.requestGeo
  return event.context.cloudflare?.request?.cf
}
