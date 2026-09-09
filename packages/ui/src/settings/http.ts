import type { SettingsHost } from './types.ts'

const methods = [
	'listProviders',
	'listAccounts',
	'connectAccount',
	'beginAccountConnection',
	'completeAccountConnection',
	'readAccountConnection',
	'cancelAccountConnection',
	'openAccountConnection',
	'setAccountEnabled',
	'disconnectAccount',
	'readUsage',
	'readUser',
	'readVersion',
	'readSoul',
	'writeSoul',
	'listAvatars',
	'putAvatarFile',
	'readProfile',
	'writeProfile',
	'generateSoul',
	'readWallpaper',
	'writeWallpaper',
	'readDockMaterial',
	'writeDockMaterial'
] as const satisfies readonly (keyof SettingsHost)[]

const encode = (value: unknown): string =>
	JSON.stringify(value, (_key, value) =>
		value instanceof Uint8Array ? { $bytes: Array.from(value) } : value
	)
const decode = (text: string): unknown =>
	JSON.parse(text, (_key, value) =>
		value && typeof value === 'object' && Array.isArray(value.$bytes)
			? new Uint8Array(value.$bytes)
			: value
	)

export function settingsClient(
	url: string,
	headers: () => Promise<Record<string, string>>
): SettingsHost {
	return Object.fromEntries(
		methods.map((method) => [
			method,
			async (input: unknown) => {
				const response = await fetch(`${url}/${method}`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', ...(await headers()) },
					body: encode(input)
				})
				if (!response.ok) throw new Error(await response.text())
				return decode(await response.text())
			}
		])
	) as unknown as SettingsHost
}

// The host authenticates the request before handing it to this handler.
export async function serveSettings(
	request: Request,
	host: Partial<SettingsHost>
): Promise<Response> {
	const method = new URL(request.url).pathname.split('/').pop()
	if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
	if (!methods.some((name) => name === method) || !Object.hasOwn(host, method!))
		return new Response('Not found', { status: 404 })
	if (!request.headers.get('content-type')?.startsWith('application/json'))
		return new Response('JSON required', { status: 415 })
	try {
		const input = decode(await request.text())
		if (!input || typeof input !== 'object' || Array.isArray(input))
			return new Response('Object required', { status: 400 })
		const run = host[method as keyof SettingsHost] as (input: unknown) => Promise<unknown>
		return new Response(encode((await run(input)) ?? null), {
			headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
		})
	} catch (error) {
		return new Response(error instanceof Error ? error.message : String(error), { status: 400 })
	}
}
