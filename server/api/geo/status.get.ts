defineRouteMeta({
  openAPI: {
    description: 'Get the local geo database status without exposing its path or visitor IPs',
    security: [{ bearerAuth: [] }],
  },
})

export default eventHandler((event) => {
  if (!event.context.selfHosted)
    return { state: 'cloudflare' }
  return event.context.selfHosted.geoStatus?.() ?? { state: 'disabled', lastReloadFailed: false }
})
