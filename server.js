import crypto from 'node:crypto'
import http from 'node:http'
import { Readable } from 'node:stream'

const port = Number(process.env.PORT || 3000)
const clientKey = process.env.GATEWAY_CLIENT_KEY || ''
const timeoutMs = 180_000
const cooldowns = new Map()

function parseUpstreams() {
  try {
    const value = JSON.parse(process.env.GATEWAY_UPSTREAMS || '[]')
    if (!Array.isArray(value)) throw new Error('not an array')
    return value.map((item, index) => {
      if (!item || typeof item.url !== 'string' || typeof item.key !== 'string' || !item.key) {
        throw new Error(`upstream ${index + 1} needs url and key`)
      }
      const url = new URL(item.url)
      if (url.protocol !== 'https:') throw new Error(`upstream ${index + 1} must use HTTPS`)
      return {
        id: typeof item.id === 'string' && item.id ? item.id : `upstream-${index + 1}`,
        url: url.toString().replace(/\/$/, ''),
        key: item.key,
        models: Array.isArray(item.models) ? new Set(item.models.filter((model) => typeof model === 'string')) : null
      }
    })
  } catch (error) {
    console.error('[gateway] invalid GATEWAY_UPSTREAMS:', error.message)
    return []
  }
}

const upstreams = parseUpstreams()

function sameKey(value) {
  if (!clientKey || typeof value !== 'string') return false
  const a = Buffer.from(value)
  const b = Buffer.from(clientKey)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function requestKey(req) {
  const auth = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]
  return req.headers['x-api-key'] || auth || ''
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function retryDelay(response) {
  const retryAfter = Number(response.headers.get('retry-after'))
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 60 * 60_000)
  return response.status === 402 ? 15 * 60_000 : 60_000
}

function copyHeaders(source, target) {
  for (const name of ['content-type', 'cache-control', 'retry-after', 'anthropic-ratelimit-requests-limit', 'anthropic-ratelimit-requests-remaining']) {
    const value = source.headers.get(name)
    if (value) target.setHeader(name, value)
  }
}

async function bodyOf(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > 10 * 1024 * 1024) throw Object.assign(new Error('Request body is too large'), { status: 413 })
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON'), { status: 400 })
  }
}

async function chooseUpstream(body, headers, signal) {
  const candidates = upstreams.filter((upstream) => !upstream.models || upstream.models.has(body.model))
  if (!candidates.length) throw Object.assign(new Error('No upstream supports this model'), { status: 503 })
  let last = null
  for (const upstream of candidates) {
    if ((cooldowns.get(upstream.id) || 0) > Date.now()) continue
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    try {
      const response = await fetch(`${upstream.url}/messages`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': upstream.key,
          authorization: `Bearer ${upstream.key}`,
          ...(headers['anthropic-version'] ? { 'anthropic-version': headers['anthropic-version'] } : {}),
          ...(headers['anthropic-beta'] ? { 'anthropic-beta': headers['anthropic-beta'] } : {})
        },
        body: JSON.stringify(body)
      })
      if (response.ok || ![402, 403, 429, 500, 502, 503, 504].includes(response.status)) return response
      last = response
      cooldowns.set(upstream.id, Date.now() + retryDelay(response))
    } catch (error) {
      console.warn(`[gateway] ${upstream.id} failed: ${error.name}`)
      cooldowns.set(upstream.id, Date.now() + 60_000)
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
  }
  if (last) return last
  throw Object.assign(new Error('No upstream is currently available'), { status: 503 })
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { status: 'healthy', upstreams: upstreams.length })
  if (!sameKey(requestKey(req))) return send(res, 401, { error: { message: 'Invalid gateway key' } })
  if (req.method !== 'POST' || req.url !== '/v1/messages') return send(res, 404, { error: { message: 'Not found' } })

  const abort = new AbortController()
  req.once('aborted', () => abort.abort())
  res.once('close', () => { if (!res.writableEnded) abort.abort() })
  try {
    const body = await bodyOf(req)
    if (typeof body.model !== 'string') return send(res, 400, { error: { message: 'model is required' } })
    const upstream = await chooseUpstream(body, req.headers, abort.signal)
    res.writeHead(upstream.status)
    copyHeaders(upstream, res)
    if (!upstream.body) return res.end()
    Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res)
  } catch (error) {
    if (!res.headersSent) send(res, error.status || 503, { error: { message: error.message || 'Gateway request failed' } })
  }
})

server.listen(port, '0.0.0.0', () => console.log(`[gateway] listening on ${port}`))
