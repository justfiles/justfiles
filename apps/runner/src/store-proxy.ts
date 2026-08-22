import { Hono } from 'hono'
import { accessToken } from './auth/access'
import { approvedAppSession } from './auth/app-session'
import { d1 } from './auth/db'
import { APP_COOKIE, cookie, noStore, sameSecret, validOrigin } from './auth/http'
import { tokenCodec } from './auth/token'
import { findApp } from './catalog'
import { appId } from './origin'

type Env = { Bindings: CloudflareBindings }

const PREFIX = '/_runner/store'

export const storeProxy = new Hono<Env>()

storeProxy.all('*', async (c) => {
	noStore(c)
	const request = c.req.raw
	const url = new URL(request.url)
	const wire = wireRequest(url, request.method, request.headers.get('content-type'))
	if (wire === 'method') return c.text('Store method not allowed.', 405)
	if (wire === 'type') return c.text('Store content type not allowed.', 415)

	const id = appId(request, c.env)
	const sessionId = cookie(c, APP_COOKIE)
	const nonce = request.headers.get('x-runner-request') ?? ''
	if (!id || !sessionId || !nonce || !validStoreOrigin(request, url.origin))
		return c.text('Store access denied.', 403)
	const app = await findApp(c.env, id)
	if (!app || app.id !== id) return c.text('Store access denied.', 403)
	const database = d1(c.env.AUTH_DB)
	const session = await approvedAppSession(database, sessionId, app)
	if (
		!session ||
		!sameSecret(session.requestNonce, nonce) ||
		!session.resources.some((resource) => resource === 'volume:app' || resource === 'volume:system')
	)
		return c.text('Store access denied.', 403)

	let token: string
	try {
		token = await accessToken(database, tokenCodec(c.env.TOKEN_SEAL_KEY_V1), c.env, session.userId)
	} catch {
		return c.text('Frieren access is unavailable.', 502)
	}

	const headers = new Headers({ authorization: `Bearer ${token}` })
	if (wire.contentType) headers.set('content-type', wire.contentType)

	try {
		const upstream = await fetch(
			new URL(`/store${url.pathname.slice(PREFIX.length)}${url.search}`, c.env.FRIEREN_ORIGIN),
			{
				method: request.method,
				headers,
				body: wire.contentType ? request.body : undefined,
				redirect: 'manual'
			}
		)
		if (upstream.status >= 300 && upstream.status < 400)
			return c.text('Frieren Store returned a redirect.', 502)
		const responseHeaders = new Headers(upstream.headers)
		responseHeaders.delete('set-cookie')
		responseHeaders.set('cache-control', 'no-store')
		responseHeaders.set('referrer-policy', 'no-referrer')
		responseHeaders.set('x-content-type-options', 'nosniff')
		return new Response(upstream.body, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers: responseHeaders
		})
	} catch {
		return c.text('Frieren Store is unavailable.', 502)
	}
})

type Wire = { contentType?: 'application/json' | 'application/octet-stream' }

function wireRequest(
	url: URL,
	method: string,
	contentType: string | null
): Wire | 'method' | 'type' {
	const path = url.pathname.slice(PREFIX.length)
	let wire: Wire | null = null
	if (method === 'GET' && /^\/node\/[^/]+$/.test(path) && noQuery(url)) wire = {}
	else if (method === 'GET' && path === '/child' && query(url, ['parent', 'name'])) wire = {}
	else if (method === 'GET' && path === '/children' && query(url, ['parent'], ['cursor'])) wire = {}
	else if (method === 'GET' && path === '/since' && query(url, [], ['cursor'])) wire = {}
	else if ((method === 'GET' || method === 'HEAD') && /^\/blob\/[^/]+$/.test(path) && noQuery(url))
		wire = {}
	else if (method === 'POST' && path === '/commit' && noQuery(url))
		wire = { contentType: 'application/json' }
	else if (method === 'PUT' && /^\/blob\/[^/]+$/.test(path) && noQuery(url))
		wire = { contentType: 'application/octet-stream' }
	if (!wire) return 'method'

	const type = contentType?.split(';', 1)[0]?.trim().toLowerCase()
	if (type !== wire.contentType) return 'type'
	return wire
}

const noQuery = (url: URL): boolean => [...url.searchParams].length === 0

function query(url: URL, required: string[], optional: string[] = []): boolean {
	const allowed = new Set([...required, ...optional])
	for (const key of required) if (url.searchParams.getAll(key).length !== 1) return false
	for (const key of optional) if (url.searchParams.getAll(key).length > 1) return false
	return [...url.searchParams.keys()].every((key) => allowed.has(key))
}

function validStoreOrigin(request: Request, origin: string): boolean {
	if (request.headers.has('origin')) return validOrigin(request, origin)
	// Browsers omit Origin from same-origin reads. Require browser-set Fetch
	// Metadata for those reads; the nonce still proves that the host made the call.
	return (
		(request.method === 'GET' || request.method === 'HEAD') &&
		request.headers.get('sec-fetch-site') === 'same-origin' &&
		request.headers.get('sec-fetch-mode') === 'cors'
	)
}
