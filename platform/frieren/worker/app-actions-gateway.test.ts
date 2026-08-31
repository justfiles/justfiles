import type { AppController, AppInspection } from '@justfiles/app'
import { Hono } from 'hono'
import { describe, expect, test, vi } from 'vitest'
import { createAppActionsGateway } from './app-actions-gateway.ts'

const inspection: AppInspection = {
	id: 'justfiles.read',
	name: 'Read',
	description: 'Save things for later.',
	state: { items: [] },
	actions: { save: { kind: 'procedure' } }
}

function setup() {
	const controller = {
		list: vi.fn(async () => [
			{ id: 'justfiles.read', name: 'Read', description: 'Save things for later.' }
		]),
		inspect: vi.fn(async () => inspection),
		run: vi.fn(async () => ({ saved: true }))
	} as unknown as AppController
	const log = vi.fn()
	return { app: createAppActionsGateway({ controller: () => controller, log }), controller, log }
}

async function json(response: Response): Promise<unknown> {
	return response.json()
}

describe('app actions gateway', () => {
	test('serves the list route at the mounted path without a trailing slash', async () => {
		const { app } = setup()
		const worker = new Hono().route('/api/v1/apps', app)
		const response = await worker.request('/api/v1/apps')
		expect(response.status).toBe(200)
	})

	test('lists the controller apps without reshaping them', async () => {
		const { app, controller } = setup()
		const response = await app.request('/')
		expect(response.status).toBe(200)
		expect(await json(response)).toEqual(await controller.list())
	})

	test('inspects a decoded app id and returns the existing inspection', async () => {
		const { app, controller } = setup()
		const response = await app.request('/justfiles%2Eread')
		expect(response.status).toBe(200)
		expect(await json(response)).toEqual(inspection)
		expect(controller.inspect).toHaveBeenCalledWith('justfiles.read')
	})

	test('runs one visible action with nested params unchanged', async () => {
		const { app, controller } = setup()
		const params = { input: 'https://example.com', options: { tags: ['one', 'two'] } }
		const response = await app.request('/justfiles.read/actions/save', {
			method: 'POST',
			headers: { 'content-type': 'application/json; charset=utf-8' },
			body: JSON.stringify(params)
		})
		expect(response.status).toBe(200)
		expect(await json(response)).toEqual({ result: { saved: true } })
		expect(controller.run).toHaveBeenCalledOnce()
		expect(controller.run).toHaveBeenCalledWith('justfiles.read', 'save', params)
	})

	test('keeps the result field when an action returns no value', async () => {
		const { app, controller } = setup()
		vi.mocked(controller.run).mockResolvedValueOnce(undefined)
		const response = await app.request('/justfiles.read/actions/save', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}'
		})
		expect(await json(response)).toEqual({ result: null })
	})

	test.each([
		['bad JSON', '{', 'application/json'],
		['an array', '[]', 'application/json'],
		['null', 'null', 'application/json'],
		['the wrong content type', '{}', 'text/plain']
	])('rejects %s as invalid_request', async (_name, body, contentType) => {
		const { app, controller } = setup()
		const response = await app.request('/justfiles.read/actions/save', {
			method: 'POST',
			headers: { 'content-type': contentType },
			body
		})
		expect(response.status).toBe(400)
		expect(await json(response)).toMatchObject({ error: { code: 'invalid_request' } })
		expect(controller.run).not.toHaveBeenCalled()
	})

	test('rejects a body over 1 MiB even without a content-length header', async () => {
		const { app, controller } = setup()
		const body = new ReadableStream({
			start(stream) {
				stream.enqueue(new TextEncoder().encode(`{"input":"${'x'.repeat(1024 * 1024)}"}`))
				stream.close()
			}
		})
		const request = new Request('https://example.test/justfiles.read/actions/save', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body,
			duplex: 'half'
		} as RequestInit)
		const response = await app.fetch(request)
		expect(response.status).toBe(400)
		expect(await json(response)).toMatchObject({ error: { code: 'invalid_request' } })
		expect(controller.run).not.toHaveBeenCalled()
	})

	test('maps an absent app to app_not_installed', async () => {
		const { app, controller } = setup()
		vi.mocked(controller.inspect).mockRejectedValueOnce(new Error('app not found: missing.app'))
		const response = await app.request('/missing.app')
		expect(response.status).toBe(404)
		expect(await json(response)).toEqual({
			error: { code: 'app_not_installed', message: 'app is not installed' }
		})
	})

	test.each([
		['foo_bar', 'foo_bar'],
		['foo%2Fbar', 'foo/bar']
	])('maps invalid app id %s to invalid_request', async (path, appId) => {
		const { app, controller } = setup()
		vi.mocked(controller.inspect).mockRejectedValueOnce(new Error(`invalid app id: ${appId}`))
		const response = await app.request(`/${path}`)
		expect(response.status).toBe(400)
		expect(await json(response)).toEqual({
			error: { code: 'invalid_request', message: 'invalid app id' }
		})
		expect(controller.inspect).toHaveBeenCalledWith(appId)
	})

	test('rejects absent and inherited action names without calling run', async () => {
		for (const action of ['missing', 'toString']) {
			const { app, controller } = setup()
			const response = await app.request(`/justfiles.read/actions/${action}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{}'
			})
			expect(response.status).toBe(404)
			expect(await json(response)).toMatchObject({ error: { code: 'action_not_found' } })
			expect(controller.run).not.toHaveBeenCalled()
		}
	})

	test('maps schema failure without exposing a stack trace', async () => {
		const { app, controller } = setup()
		vi.mocked(controller.run).mockRejectedValueOnce(
			new Error('invalid params for save: input is required')
		)
		const response = await app.request('/justfiles.read/actions/save', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}'
		})
		const body = await json(response)
		expect(response.status).toBe(400)
		expect(body).toEqual({
			error: { code: 'invalid_params', message: 'invalid params for save: input is required' }
		})
		expect(JSON.stringify(body)).not.toContain('stack')
	})

	test('keeps unexpected errors, params, and results out of the response and log', async () => {
		const { app, controller, log } = setup()
		vi.mocked(controller.run).mockRejectedValueOnce(new Error('secret internal failure'))
		const response = await app.request('/justfiles.read/actions/save', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{"input":"private value"}'
		})
		const body = await response.text()
		expect(response.status).toBe(500)
		expect(JSON.parse(body)).toEqual({ error: { code: 'action_failed', message: 'action failed' } })
		expect(body).not.toContain('secret internal failure')
		expect(JSON.stringify(log.mock.calls)).not.toContain('private value')
		expect(log).toHaveBeenCalledWith({
			requestId: expect.any(String),
			route: 'POST /api/v1/apps/:appId/actions/:action',
			status: 500,
			appId: 'justfiles.read',
			action: 'save'
		})
	})

	test('rejects malformed paths and percent encoding', async () => {
		const { app } = setup()
		for (const path of ['/justfiles.read/actions', '/justfiles.read/actions/%']) {
			const response = await app.request(path, { method: 'POST' })
			expect(response.status).toBe(400)
			expect(await json(response)).toMatchObject({ error: { code: 'invalid_request' } })
		}
	})
})
