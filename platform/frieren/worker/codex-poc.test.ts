import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from './codex-poc.ts'

afterEach(() => {
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

describe('Codex POC access', () => {
	it('keeps an idle stream alive and stops the heartbeat when the probe ends', async () => {
		vi.useFakeTimers()
		let respond!: (response: Response) => void
		const upstream = new Promise<Response>((resolve) => {
			respond = resolve
		})
		vi.stubGlobal(
			'fetch',
			vi.fn(() => upstream)
		)
		const response = worker.fetch(
			new Request('https://poc.example/probe', {
				method: 'POST',
				headers: { authorization: 'Bearer private-test-key' }
			}),
			{ POC_KEY: 'private-test-key', PROXY_URL: 'https://proxy.example' }
		)
		const reader = response.body!.getReader()
		await reader.read()
		await vi.advanceTimersByTimeAsync(15_000)
		const heartbeat = await reader.read()
		expect(JSON.parse(new TextDecoder().decode(heartbeat.value))).toEqual({ type: 'heartbeat' })
		respond(new Response('Not found', { status: 404 }))
		while (!(await reader.read()).done) {}
		expect(vi.getTimerCount()).toBe(0)
	})

	it('reports a broken proxy before asking the user to sign in', async () => {
		const fetch = vi.fn().mockResolvedValue(new Response('Not found', { status: 404 }))
		vi.stubGlobal('fetch', fetch)
		const response = worker.fetch(
			new Request('https://poc.example/probe', {
				method: 'POST',
				headers: { authorization: 'Bearer private-test-key' }
			}),
			{ POC_KEY: 'private-test-key', PROXY_URL: 'https://proxy.example' }
		)
		const events = (await response.text())
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line))
		expect(events.at(-1)).toMatchObject({
			type: 'complete',
			ok: false,
			stage: 'proxy_transport',
			status: 404
		})
		expect(events.some((event) => event.stage === 'device_login')).toBe(false)
		expect(fetch).toHaveBeenCalledTimes(1)
	})

	it.each([undefined, '', 'Bearer wrong'])('rejects missing or wrong credentials: %s', (auth) => {
		const headers = auth ? { authorization: auth } : undefined
		const response = worker.fetch(
			new Request('https://poc.example/probe', { method: 'POST', headers }),
			{
				POC_KEY: 'private-test-key'
			}
		)
		expect(response.status).toBe(401)
	})

	it('fails closed when the server secret is missing', () => {
		const response = worker.fetch(
			new Request('https://poc.example/probe', {
				method: 'POST',
				headers: { authorization: 'Bearer ' }
			}),
			{ POC_KEY: '' }
		)
		expect(response.status).toBe(401)
	})

	it('does not start login on GET, even with the correct key', () => {
		const response = worker.fetch(
			new Request('https://poc.example/probe', {
				headers: { authorization: 'Bearer private-test-key' }
			}),
			{ POC_KEY: 'private-test-key' }
		)
		expect(response.status).toBe(405)
	})

	it('does not disclose the secret in the public page', async () => {
		const response = worker.fetch(new Request('https://poc.example/'), {
			POC_KEY: 'private-test-key'
		})
		expect(await response.text()).not.toContain('private-test-key')
		expect(response.headers.get('cache-control')).toBe('no-store')
	})
})
