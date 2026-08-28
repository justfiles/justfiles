import { createServer, type Server } from 'node:http'
import { classifyFailure, text } from '@justfiles/agent'
import { hostAccounts } from '@justfiles/app/capabilities/accounts/host'
import { volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { afterEach, describe, expect, test } from 'vitest'
import { daemonAccounts } from './kernel.ts'
import { createPlatformAi } from './platform-ai.ts'

type Request = { path: string; authorization: string | undefined; body?: unknown }

const descriptor = {
	id: 'test/model',
	name: 'Just Computer AI',
	reasoning: false,
	input: ['text'] as const,
	contextWindow: 128_000,
	maxTokens: 8_192,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

let server: Server | undefined

afterEach(
	() =>
		new Promise<void>((resolve, reject) => {
			if (!server) return resolve()
			server.close((error) => (error ? reject(error) : resolve()))
			server = undefined
		})
)

async function gateway(
	requests: Request[],
	completion: (call: number) => { status?: number; body?: unknown } = () => ({})
): Promise<string> {
	let calls = 0
	server = createServer((req, res) => {
		const chunks: Buffer[] = []
		req.on('data', (chunk) => chunks.push(chunk))
		req.on('end', () => {
			const raw = Buffer.concat(chunks).toString()
			requests.push({
				path: req.url ?? '',
				authorization: req.headers.authorization,
				...(raw && { body: JSON.parse(raw) })
			})
			if (req.url === '/api/ai/model') {
				res.setHeader('content-type', 'application/json')
				res.end(JSON.stringify(descriptor))
				return
			}
			calls++
			const answer = completion(calls)
			if (answer.status) {
				res.statusCode = answer.status
				res.setHeader('content-type', 'application/json')
				res.end(JSON.stringify(answer.body))
				return
			}
			res.setHeader('content-type', 'text/event-stream')
			res.end(
				[
					'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"test/model","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}',
					'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"test/model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
					'data: [DONE]',
					''
				].join('\n\n')
			)
		})
	})
	await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
	const address = server.address()
	if (!address || typeof address === 'string') throw new Error('missing gateway address')
	return `http://127.0.0.1:${address.port}`
}

describe('Just Computer AI', () => {
	test('is the daemon fallback without replacing a selected ChatGPT account', async () => {
		const requests: Request[] = []
		const origin = await gateway(requests)
		const fs = volume(memStore())
		const accounts = daemonAccounts(fs, { origin, getToken: async () => 'token' })

		expect((await accounts.resolveBackend())?.model.provider).toBe('kodama')

		await fs.mkdir('/private/accounts', { recursive: true })
		await fs.writeFile(
			'/private/accounts/user%40example.com.json',
			new TextEncoder().encode(
				JSON.stringify({
					id: 'user@example.com',
					provider: 'chatgpt',
					creds: {
						type: 'oauth',
						access: 'access',
						refresh: 'refresh',
						expires: Date.now() + 60_000,
						accountId: 'user@example.com'
					}
				})
			)
		)
		await fs.writeFile(
			'/private/active-ai.json',
			new TextEncoder().encode(JSON.stringify({ accountId: 'user@example.com' }))
		)

		expect((await accounts.resolveBackend())?.model.provider).toBe('openai-codex')
	})

	test('uses the gateway model and resolves a fresh bearer token for each request', async () => {
		const requests: Request[] = []
		const origin = await gateway(requests)
		let token = 0
		const kodama = createPlatformAi({
			origin,
			getToken: async () => `token-${++token}`
		})
		const accounts = hostAccounts([kodama.provider], volume(memStore()))
		const backend = await accounts.resolveAi(kodama.backend)

		expect(backend?.model).toMatchObject({
			id: descriptor.id,
			name: descriptor.name,
			provider: 'kodama',
			baseUrl: `${origin}/api/ai/v1`
		})
		expect(await text(backend!).gen('Be brief.', 'Hello')).toBe('hello')
		expect(await text(backend!).gen('Be brief.', 'Again')).toBe('hello')

		const completions = requests.filter((request) => request.path === '/api/ai/v1/chat/completions')
		expect(completions.map((request) => request.authorization)).toEqual([
			'Bearer token-2',
			'Bearer token-3'
		])
		expect(completions.map((request) => (request.body as { model: string }).model)).toEqual([
			descriptor.id,
			descriptor.id
		])
	})

	test('has no backend while signed out', async () => {
		const kodama = createPlatformAi({
			origin: 'http://127.0.0.1:1',
			getToken: async () => null
		})
		const accounts = hostAccounts([kodama.provider], volume(memStore()))

		expect(await accounts.resolveAi(kodama.backend)).toBeNull()
	})

	test('keeps the last model when a later descriptor refresh fails', async () => {
		const requests: Request[] = []
		const origin = await gateway(requests)
		const kodama = createPlatformAi({ origin, getToken: async () => 'token' })
		const accounts = hostAccounts([kodama.provider], volume(memStore()))

		expect((await accounts.resolveAi(kodama.backend))?.model.id).toBe(descriptor.id)
		await new Promise<void>((resolve, reject) =>
			server?.close((error) => (error ? reject(error) : resolve()))
		)
		server = undefined

		expect((await accounts.resolveAi(kodama.backend))?.model.id).toBe(descriptor.id)
	})

	test.each([
		{
			status: 429,
			body: { error: { code: 'quota_exceeded', message: 'weekly limit reached' } },
			message: /limit reached/i,
			route: { kind: 'settings', pane: 'accounts' }
		},
		{
			status: 401,
			body: { error: { code: 'unauthorized', message: 'expired' } },
			message: /sign-in expired/i,
			route: { kind: 'settings', pane: 'accounts' }
		}
	])('classifies a $status gateway response', async ({ status, body, message, route }) => {
		const origin = await gateway([], () => ({ status, body }))
		const kodama = createPlatformAi({ origin, getToken: async () => 'token' })
		const accounts = hostAccounts([kodama.provider], volume(memStore()))
		const backend = await accounts.resolveAi(kodama.backend)
		const response = await backend!.completeFn(backend!.model, {
			messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }]
		})

		const failure = classifyFailure(new Error(response.errorMessage))
		expect(failure.route).toEqual(route)
		expect(failure.body).toMatch(message)
	})
})
