export default eventHandler(async (event) => {
  await getStorage(event).DB.prepare('SELECT 1').first()
  setHeader(event, 'Cache-Control', 'no-store')
  return { status: 'ok' }
})
