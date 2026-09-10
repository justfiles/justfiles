import { IDENTITY_DEFAULTS, IDENTITY_PATHS } from '@justfiles/agent/defaults'
import { volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { afterEach, expect, test, vi } from 'vitest'
import { createClient } from './client.ts'
import { createSettingsHost } from './host.ts'
import { serveSettings } from './http.ts'
import { DOCK_MATERIAL_PATH, WALLPAPER_PATH } from './types.ts'

afterEach(() => vi.unstubAllGlobals())

const local = () => ({
	volume: volume(memStore()),
	user: async () => ({ id: 'person', name: 'Fern' }),
	version: 'web-test'
})

test('the native view calls the shared endpoint with the current token', async () => {
	const host = createSettingsHost({
		version: 'mac-test',
		agent: { volume: volume(memStore()), paths: IDENTITY_PATHS, defaults: IDENTITY_DEFAULTS }
	})
	let token: string | null = 'first-token'
	const requests: string[] = []
	vi.stubGlobal('fetch', async (url: string, options: RequestInit) => {
		expect(new Headers(options.headers).get('authorization')).toBe(`Bearer ${token}`)
		requests.push(url)
		return serveSettings(new Request(`https://host${url}`, options), host)
	})
	const client = createClient({ getToken: async () => token })
	await client.writeProfile({ name: 'Fern' })
	token = 'rotated-token'
	expect(await client.readProfile({})).toMatchObject({ name: 'Fern' })
	expect(await client.readVersion({})).toBe('mac-test')
	expect(requests).toEqual([
		'/api/settings/writeProfile',
		'/api/settings/readProfile',
		'/api/settings/readVersion'
	])
	token = null
	await expect(client.readProfile({})).rejects.toThrow('Sign in to manage')
	expect(requests).toHaveLength(3)
})

test('the web view keeps file edits local and available without authentication or network', async () => {
	const files = local()
	const getToken = vi.fn(async () => null)
	const network = vi.fn(async () => {
		throw new Error('offline')
	})
	vi.stubGlobal('fetch', network)
	const client = createClient({ getToken, local: files })
	const wallpaper = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
	await client.writeSoul({ name: 'Frieren', body: 'You are Frieren.' })
	await client.writeProfile({ name: 'Fern' })
	await client.writeWallpaper({ bytes: wallpaper })
	await client.writeDockMaterial({ material: 'frosted' })
	expect(await client.readSoul({})).toMatchObject({ name: 'Frieren', body: 'You are Frieren.' })
	expect(await client.readProfile({})).toMatchObject({ name: 'Fern' })
	expect(await files.volume.readFile(WALLPAPER_PATH)).toEqual(wallpaper)
	expect(new TextDecoder().decode(await files.volume.readFile(DOCK_MATERIAL_PATH))).toBe('frosted')
	expect(await client.readUser({})).toEqual({ id: 'person', name: 'Fern' })
	expect(await client.readVersion({})).toBe('web-test')
	expect(getToken).not.toHaveBeenCalled()
	expect(network).not.toHaveBeenCalled()
})

test('local files do not override cloud account and generation requests', async () => {
	const generate = vi.fn(async () => ({ body: 'Generated in the cloud.' }))
	const host = createSettingsHost({
		agent: {
			volume: volume(memStore()),
			paths: IDENTITY_PATHS,
			defaults: IDENTITY_DEFAULTS,
			generateSoul: generate
		}
	})
	const requests: string[] = []
	vi.stubGlobal('fetch', async (url: string, options: RequestInit) => {
		requests.push(url)
		return serveSettings(new Request(`https://cloud${url}`, options), host)
	})
	const client = createClient({ getToken: async () => 'cloud-token', local: local() })
	expect(await client.listAccounts({})).toEqual([])
	expect(await client.generateSoul({ name: 'Frieren', gender: 'female' })).toEqual({
		body: 'Generated in the cloud.'
	})
	expect(generate).toHaveBeenCalledTimes(1)
	expect(requests).toEqual(['/api/settings/listAccounts', '/api/settings/generateSoul'])
})

test('browser sign-in reserves its tab before authentication and closes invalid prompts', async () => {
	const events: string[] = []
	const page = {
		opener: 'parent' as string | null,
		location: { href: 'about:blank' },
		close: vi.fn()
	}
	vi.stubGlobal('window', {
		open: () => {
			events.push('open')
			return page
		}
	})
	let address = 'https://auth.openai.com/codex/device'
	vi.stubGlobal('fetch', async () =>
		Response.json({ status: 'pending', prompt: { verificationUrl: address } })
	)
	const client = createClient({
		local: local(),
		getToken: async () => {
			events.push('token')
			return 'cloud-token'
		}
	})
	const ref = { providerId: 'chatgpt', operationId: 'attempt' }
	await client.openAccountConnection(ref)
	expect(events).toEqual(['open', 'token'])
	expect(page.opener).toBeNull()
	expect(page.location.href).toBe(address)
	address = 'http://untrusted.example'
	await expect(client.openAccountConnection(ref)).rejects.toThrow('Invalid sign-in address')
	expect(page.close).toHaveBeenCalledTimes(1)
})

test('reopening Settings while a file save is pending preserves both edits', async () => {
	const files = local()
	const getToken = async () => null
	const first = createClient({ getToken, local: files })
	const reopened = createClient({ getToken, local: { ...files } })
	await Promise.all([
		first.writeSoul({ name: 'Frieren' }),
		reopened.writeSoul({ body: 'Updated soul.' })
	])
	expect(await reopened.readSoul({})).toMatchObject({ name: 'Frieren', body: 'Updated soul.' })
})
