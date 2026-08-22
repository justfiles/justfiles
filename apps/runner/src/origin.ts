import { decodeLabel, encodeLabel } from './id'

/** A canonical label gives each app one browser origin. */
export const appId = (
	req: Request,
	env: Pick<CloudflareBindings, 'ROOT_DOMAIN'>
): string | null => {
	const host = new URL(req.url).hostname.toLowerCase()
	const root = (host.endsWith('.localhost') ? 'localhost' : env.ROOT_DOMAIN).toLowerCase()
	if (!host.endsWith(`.${root}`)) return null
	return decodeLabel(host.slice(0, -root.length - 1))
}

export const rootOrigin = (
	req: Request,
	env: Pick<CloudflareBindings, 'ROOT_DOMAIN'>
): string | null => {
	const url = new URL(req.url)
	if (url.hostname === 'localhost' && (url.protocol === 'http:' || url.protocol === 'https:'))
		return url.origin
	const expected = `https://${env.ROOT_DOMAIN.toLowerCase()}`
	return url.origin === expected ? expected : null
}

export const appOrigin = (
	req: Request,
	env: Pick<CloudflareBindings, 'ROOT_DOMAIN'>,
	id: string
): string => {
	const url = new URL(req.url)
	const label = encodeLabel(id)
	return url.hostname === 'localhost'
		? `${url.protocol}//${label}.localhost${url.port ? `:${url.port}` : ''}`
		: `https://${label}.${env.ROOT_DOMAIN}`
}
