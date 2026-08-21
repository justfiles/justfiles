import { type Context, Hono } from 'hono'
import { findApp } from '../catalog'
import { decodeLabel, encodeLabel } from '../id'
import { appId, appOrigin, rootOrigin } from '../origin'
import type { ReleaseManifest } from '../protocol'
import { deleteAccount, putAccount } from './account'
import { appAccess } from './capability'
import { consentPage } from './consent'
import { type Database, d1 } from './db'
import { beginFlow, takeFlow } from './flow'
import { putGrant, readGrant, revokeApp } from './grant'
import {
	APP_COOKIE,
	clearAppCookie,
	clearFlowCookie,
	clearRootCookie,
	cookie,
	FLOW_COOKIE,
	formToken,
	isForm,
	noStore,
	ROOT_COOKIE,
	sameSecret,
	setAppCookie,
	setFlowCookie,
	setRootCookie,
	validFormToken,
	validOrigin
} from './http'
import { authorizationUrl, discover, exchangeCode } from './oauth'
import { createSession, exchangeTicket, readSession } from './session'
import { tokenCodec } from './token'

type Env = { Bindings: CloudflareBindings }

export const rootAuth = new Hono<Env>()
export const appAuth = new Hono<Env>()

const CONSENT_CSP = [
	"default-src 'none'",
	"style-src 'unsafe-inline'",
	"form-action 'self'",
	"frame-ancestors 'none'",
	"base-uri 'none'"
].join('; ')

rootAuth.get('/connect', async (c) => {
	const origin = rootOrigin(c.req.raw, c.env)
	if (!origin) return c.notFound()
	noStore(c)
	const app = await currentApp(c.env, c.req.query('app'))
	if (!app) return c.text('App not found.', 404)
	try {
		await appAccess(app.id, app.capabilities)
	} catch {
		return c.text('Runner cannot grant the app capabilities in this release.', 403)
	}
	try {
		const metadata = await discover(c.env)
		const flow = await beginFlow(d1(c.env.AUTH_DB), app.id)
		setFlowCookie(c, flow.browser)
		return c.redirect(
			authorizationUrl(metadata, c.env, {
				callback: `${origin}/auth/callback`,
				state: flow.state,
				nonce: flow.nonce,
				challenge: flow.challenge
			})
		)
	} catch {
		return c.text('Runner cannot connect this app to Frieren.', 502)
	}
})

rootAuth.get('/auth/callback', async (c) => {
	const origin = rootOrigin(c.req.raw, c.env)
	if (!origin) return c.notFound()
	noStore(c)
	const state = c.req.query('state')
	const browser = cookie(c, FLOW_COOKIE)
	if (!state || !browser) return c.text('The connection request is invalid.', 400)

	const database = d1(c.env.AUTH_DB)
	const flow = await takeFlow(database, state, browser)
	if (!flow) return c.text('The connection request has expired or was already used.', 400)
	clearFlowCookie(c)
	if (c.req.query('error')) return c.text('Frieren did not approve the connection.', 400)
	const code = c.req.query('code')
	if (!code) return c.text('Frieren did not return an authorization code.', 400)

	try {
		const metadata = await discover(c.env)
		const tokens = await exchangeCode(metadata, c.env, {
			code,
			callback: `${origin}/auth/callback`,
			verifier: flow.verifier,
			nonce: flow.nonce
		})
		await putAccount(database, tokenCodec(c.env.TOKEN_SEAL_KEY_V1), tokens)
		const now = Date.now()
		const session = await createSession(database, { kind: 'root', userId: tokens.userId }, now)
		setRootCookie(c, session.id, session.expiresAt, now)
		return c.redirect(`/consent?app=${encodeURIComponent(flow.appId)}`, 303)
	} catch {
		return c.text('Frieren returned an invalid connection response.', 400)
	}
})

rootAuth.get('/consent', async (c) => {
	if (!rootOrigin(c.req.raw, c.env)) return c.notFound()
	privatePage(c)
	const signedIn = await rootSession(c, d1(c.env.AUTH_DB))
	if (!signedIn) return c.text('Connect to Frieren again.', 401)
	const app = await currentApp(c.env, c.req.query('app'))
	if (!app) return c.text('App not found.', 404)

	try {
		const access = await appAccess(app.id, app.capabilities)
		const csrf = await formToken(signedIn.id)
		const cancel = `${appOrigin(c.req.raw, c.env, app.id)}/`
		return c.html(consentPage(app, access, csrf, cancel))
	} catch {
		return c.text('Runner cannot grant the app capabilities in this release.', 403)
	}
})

rootAuth.post('/consent', async (c) => {
	const origin = rootOrigin(c.req.raw, c.env)
	if (!origin) return c.notFound()
	noStore(c)
	if (!validOrigin(c.req.raw, origin) || !isForm(c.req.raw))
		return c.text('The consent request is invalid.', 403)

	const database = d1(c.env.AUTH_DB)
	const signedIn = await rootSession(c, database)
	if (!signedIn) return c.text('Connect to Frieren again.', 401)
	const form = await c.req.parseBody()
	const csrf = stringField(form.csrf)
	const app = await currentApp(c.env, stringField(form.app))
	if (!csrf || !(await validFormToken(signedIn.id, csrf)))
		return c.text('The consent request is invalid.', 403)
	if (!app) return c.text('App not found.', 404)

	try {
		const access = await appAccess(app.id, app.capabilities)
		const target = appOrigin(c.req.raw, c.env, app.id)
		await putGrant(database, {
			userId: signedIn.userId,
			appId: app.id,
			capabilityHash: access.hash,
			resources: access.resources
		})
		const ticket = await createSession(database, {
			kind: 'ticket',
			userId: signedIn.userId,
			appId: app.id,
			origin: target,
			capabilityHash: access.hash
		})
		return c.redirect(
			`${target}/_runner/connect/callback?ticket=${encodeURIComponent(ticket.id)}`,
			303
		)
	} catch {
		return c.text('Runner cannot grant the app capabilities in this release.', 403)
	}
})

rootAuth.post('/disconnect', async (c) => {
	const origin = rootOrigin(c.req.raw, c.env)
	if (!origin) return c.notFound()
	noStore(c)
	if (!validOrigin(c.req.raw, origin) || !isForm(c.req.raw))
		return c.text('The disconnect request is invalid.', 403)

	const database = d1(c.env.AUTH_DB)
	const signedIn = await rootSession(c, database)
	if (!signedIn) return c.text('Runner is not connected.', 401)
	const form = await c.req.parseBody()
	const csrf = stringField(form.csrf)
	if (!csrf || !(await validFormToken(signedIn.id, csrf)))
		return c.text('The disconnect request is invalid.', 403)

	await deleteAccount(database, signedIn.userId)
	clearRootCookie(c)
	return c.redirect('/', 303)
})

appAuth.get('/_runner/connect/callback', async (c) => {
	noStore(c)
	const id = appId(c.req.raw, c.env)
	const ticket = c.req.query('ticket')
	if (!id || !ticket) return c.text('The app connection request is invalid.', 400)
	const app = await currentApp(c.env, id)
	if (!app) return c.text('App not found.', 404)

	try {
		const now = Date.now()
		const access = await appAccess(app.id, app.capabilities)
		const session = await exchangeTicket(
			d1(c.env.AUTH_DB),
			ticket,
			app.id,
			new URL(c.req.url).origin,
			access.hash,
			now
		)
		if (!session) return c.text('The app connection request has expired or was already used.', 400)
		setAppCookie(c, session.id, session.expiresAt, now)
		return c.redirect('/', 303)
	} catch {
		return c.text('Runner cannot connect this app release.', 403)
	}
})

appAuth.get('/_runner/account', async (c) => {
	noStore(c)
	const id = appId(c.req.raw, c.env)
	const sessionId = cookie(c, APP_COOKIE)
	if (!id || !sessionId) return c.json({ connected: false })
	const database = d1(c.env.AUTH_DB)
	const session = await readSession(database, sessionId, 'app')
	if (!session || session.appId !== id) {
		clearAppCookie(c)
		return c.json({ connected: false })
	}
	const nonce = c.req.header('x-runner-request') ?? ''
	if (!session.requestNonce || !nonce || !sameSecret(session.requestNonce, nonce))
		return c.json({ error: 'The account request is invalid.' }, 403)
	const app = await currentApp(c.env, id)
	if (!app) {
		clearAppCookie(c)
		return c.json({ connected: false })
	}

	try {
		const access = await appAccess(app.id, app.capabilities)
		const grant = await readGrant(database, session.userId, app.id)
		if (!grant || grant.capabilityHash !== access.hash) {
			clearAppCookie(c)
			return c.json({ connected: false })
		}
		return c.json({ connected: true, resources: grant.resources })
	} catch {
		clearAppCookie(c)
		return c.json({ connected: false })
	}
})

appAuth.post('/_runner/disconnect', async (c) => {
	noStore(c)
	const id = appId(c.req.raw, c.env)
	const origin = new URL(c.req.url).origin
	if (!id || !validOrigin(c.req.raw, origin) || !isForm(c.req.raw))
		return c.text('The disconnect request is invalid.', 403)
	const sessionId = cookie(c, APP_COOKIE)
	if (!sessionId) return c.text('Runner is not connected.', 401)

	const database = d1(c.env.AUTH_DB)
	const session = await readSession(database, sessionId, 'app')
	const nonce = c.req.header('x-runner-request') ?? ''
	if (
		!session ||
		session.appId !== id ||
		!session.requestNonce ||
		!nonce ||
		!sameSecret(session.requestNonce, nonce)
	)
		return c.text('The disconnect request is invalid.', 403)

	await revokeApp(database, session.userId, id)
	clearAppCookie(c)
	return c.body(null, 204)
})

async function rootSession(c: Context<Env>, database: Database) {
	const id = cookie(c, ROOT_COOKIE)
	if (!id) return null
	const session = await readSession(database, id, 'root')
	if (!session) {
		clearRootCookie(c)
		return null
	}
	return { ...session, id }
}

async function currentApp(
	env: CloudflareBindings,
	value: string | undefined
): Promise<ReleaseManifest | null> {
	if (!value || decodeLabel(encodeLabel(value)) !== value) return null
	const app = await findApp(env, value)
	return app?.id === value ? app : null
}

const stringField = (value: string | File | (string | File)[] | undefined): string | undefined =>
	typeof value === 'string' ? value : undefined

const privatePage = (c: Context<Env>): void => {
	noStore(c)
	c.header('content-security-policy', CONSENT_CSP)
}
