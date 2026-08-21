import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { hashSecret } from './secret'

export const FLOW_COOKIE = '__Host-runner-flow'
export const ROOT_COOKIE = '__Host-runner-root'
export const APP_COOKIE = '__Host-runner-app'

const COOKIE = {
	path: '/',
	secure: true,
	httpOnly: true,
	sameSite: 'Lax' as const
}

export const cookie = (c: Context, name: string): string | undefined => getCookie(c, name)

export const setFlowCookie = (c: Context, value: string): void => {
	setCookie(c, FLOW_COOKIE, value, { ...COOKIE, maxAge: 10 * 60 })
}

export const setRootCookie = (c: Context, value: string, expiresAt: number, now: number): void => {
	setCookie(c, ROOT_COOKIE, value, { ...COOKIE, maxAge: maxAge(expiresAt, now) })
}

export const setAppCookie = (c: Context, value: string, expiresAt: number, now: number): void => {
	setCookie(c, APP_COOKIE, value, { ...COOKIE, maxAge: maxAge(expiresAt, now) })
}

export const clearFlowCookie = (c: Context): void => clearCookie(c, FLOW_COOKIE)
export const clearRootCookie = (c: Context): void => clearCookie(c, ROOT_COOKIE)
export const clearAppCookie = (c: Context): void => clearCookie(c, APP_COOKIE)

export const formToken = (sessionId: string): Promise<string> =>
	hashSecret(`runner-form:${sessionId}`)

export async function validFormToken(sessionId: string, value: string): Promise<boolean> {
	return sameSecret(await formToken(sessionId), value)
}

export const sameSecret = (left: string, right: string): boolean => {
	const length = Math.max(left.length, right.length)
	let different = left.length ^ right.length
	for (let index = 0; index < length; index++)
		different |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
	return different === 0
}

export const validOrigin = (request: Request, origin: string): boolean =>
	request.headers.get('origin') === origin

export const isForm = (request: Request): boolean =>
	request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ===
	'application/x-www-form-urlencoded'

export const noStore = (c: Context): void => {
	c.header('cache-control', 'no-store')
	c.header('referrer-policy', 'no-referrer')
	c.header('x-content-type-options', 'nosniff')
}

const maxAge = (expiresAt: number, now: number): number =>
	Math.max(0, Math.floor((expiresAt - now) / 1_000))

const clearCookie = (c: Context, name: string): void => {
	deleteCookie(c, name, COOKIE)
}
