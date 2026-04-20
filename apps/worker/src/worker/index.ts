import { clerkMiddleware, getAuth } from '@hono/clerk-auth'
import { Hono } from 'hono'
import { MemoryObject } from './memory-object'

type WorkerVariables = {
	apiKeyUserId?: string
}
type WorkerEnv = { Bindings: Env; Variables: WorkerVariables }

const app = new Hono<WorkerEnv>()
const API_KEY_PREFIX = 'ak_'
const CLERK_API_KEYS_VERIFY_URL = 'https://api.clerk.com/v1/api_keys/verify'
const API_KEY_SUCCESS_TTL_MS = 60_000
const API_KEY_FAILURE_TTL_MS = 5_000
const apiKeyCache = new Map<
	string,
	{
		expiresAt: number
		userId: string | null
	}
>()

if (import.meta.env.DEV) {
	app.use('*', async (c, next) => {
		const startedAt = Date.now()
		await next()
		const durationMs = Date.now() - startedAt
		console.log(
			`[worker] ${c.req.method} ${new URL(c.req.url).pathname}${new URL(c.req.url).search} -> ${c.res.status} (${durationMs}ms)`
		)
	})
}

const isApiKeyToken = (token: string | undefined): boolean =>
	!!token && token.startsWith(API_KEY_PREFIX)
const verifyApiKey = async (
	apiKey: string,
	secretKey: string
): Promise<{
	subject?: string | null
	createdBy?: string | null
} | null> => {
	const res = await fetch(CLERK_API_KEYS_VERIFY_URL, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${secretKey}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ secret: apiKey })
	})
	if (!res.ok) {
		return null
	}

	const payload = (await res.json()) as {
		subject?: string | null
		createdBy?: string | null
	}
	return payload
}

const getUserIdFromApiKey = (apiKey: {
	subject?: string | null
	createdBy?: string | null
}): string | null => {
	if (apiKey.subject?.startsWith('user_')) return apiKey.subject
	return apiKey.createdBy ?? null
}

const pruneExpiredApiKeyCache = (now: number) => {
	for (const [token, entry] of apiKeyCache) {
		if (entry.expiresAt <= now) apiKeyCache.delete(token)
	}
}

const requireClerkSecretKey = (env: Env): string => {
	if (!env.CLERK_SECRET_KEY) {
		throw new Error('Missing CLERK_SECRET_KEY')
	}

	return env.CLERK_SECRET_KEY
}

const applyApiKeyAuth = async (
	c: {
		req: { header: (h: string) => string | undefined }
		set: (k: string, v: string) => void
		env: Env
	},
	next: () => Promise<void>
) => {
	const authorization = (c.req.header('authorization') ?? '').trim()
	const [scheme, token = ''] = authorization.split(' ')

	if (!scheme || !token || scheme.toLowerCase() !== 'bearer' || !isApiKeyToken(token)) {
		await next()
		return
	}

	const now = Date.now()
	const cached = apiKeyCache.get(token)
	if (cached && cached.expiresAt > now) {
		if (!cached.userId) return new Response('Unauthorized', { status: 401 })
		c.set('apiKeyUserId', cached.userId)
		await next()
		return
	}

	let apiKey
	try {
		apiKey = await verifyApiKey(token, requireClerkSecretKey(c.env))
	} catch {
		apiKeyCache.set(token, { expiresAt: now + API_KEY_FAILURE_TTL_MS, userId: null })
		return new Response('Unauthorized', { status: 401 })
	}
	if (!apiKey) {
		apiKeyCache.set(token, { expiresAt: now + API_KEY_FAILURE_TTL_MS, userId: null })
		return new Response('Unauthorized', { status: 401 })
	}

	const userId = getUserIdFromApiKey(apiKey)
	if (!userId) {
		apiKeyCache.set(token, { expiresAt: now + API_KEY_FAILURE_TTL_MS, userId: null })
		return new Response('Unauthorized', { status: 401 })
	}

	if (apiKeyCache.size >= 1024) {
		pruneExpiredApiKeyCache(now)
	}
	apiKeyCache.set(token, { expiresAt: now + API_KEY_SUCCESS_TTL_MS, userId })
	c.set('apiKeyUserId', userId)
	await next()
}

let clerkMw: ReturnType<typeof clerkMiddleware> | null = null

// Apply auth + routing to /fs*.
for (const path of ['/fs', '/fs/*'] as const) {
	app.use(path, async (c, next) => applyApiKeyAuth(c as never, next))
	app.use(path, async (c, next) => {
		if (c.get('apiKeyUserId')) return next()
		if (!clerkMw) clerkMw = clerkMiddleware()
		return clerkMw(c, next)
	})
	app.use(path, async (c) => {
		const apiUserId = c.get('apiKeyUserId')
		const userId = apiUserId ?? getAuth(c)?.userId
		if (!userId) {
			return new Response('Unauthorized', { status: 401 })
		}

		const id = c.env.STORE.idFromName(userId)
		const stub = c.env.STORE.get(id)
		const headers = new Headers(c.req.raw.headers)
		headers.set('x-user-id', userId)
		return stub.fetch(new Request(c.req.raw, { headers }))
	})
}

export { MemoryObject }
export default app
