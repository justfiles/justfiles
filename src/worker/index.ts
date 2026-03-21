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

const applyApiKeyAuth = async (
	c: { req: { header: (h: string) => string | undefined }; set: (k: string, v: string) => void; env: Env },
	next: () => Promise<void>
) => {
	const authorization = (c.req.header('authorization') ?? '').trim()
	const [scheme, token = ''] = authorization.split(' ')

	if (!scheme || !token || scheme.toLowerCase() !== 'bearer' || !isApiKeyToken(token)) {
		await next()
		return
	}

	let apiKey
	try {
		apiKey = await verifyApiKey(token, c.env.CLERK_SECRET_KEY)
	} catch {
		return new Response('Unauthorized', { status: 401 })
	}
	if (!apiKey) {
		return new Response('Unauthorized', { status: 401 })
	}

	const userId = getUserIdFromApiKey(apiKey)
	if (!userId) {
		return new Response('Unauthorized', { status: 401 })
	}

	c.set('apiKeyUserId', userId)
	await next()
}

let clerkMw: ReturnType<typeof clerkMiddleware> | null = null

// Apply auth + routing to /api/* and /mcp
for (const path of ['/api/*', '/mcp'] as const) {
	app.use(path, async (c, next) => applyApiKeyAuth(c as never, next))
	app.use(path, async (c, next) => {
		if (!clerkMw) clerkMw = clerkMiddleware()
		return clerkMw(c, next)
	})
	app.use(path, async (c) => {
		const auth = getAuth(c)
		const apiUserId = c.get('apiKeyUserId')
		const userId = apiUserId ?? auth?.userId
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
