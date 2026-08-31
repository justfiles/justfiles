import type { AppController } from '@justfiles/app'
import { Hono } from 'hono'

const MAX_BODY_BYTES = 1024 * 1024

type ErrorCode =
	| 'invalid_request'
	| 'invalid_params'
	| 'app_not_installed'
	| 'action_not_found'
	| 'action_failed'

interface LogEntry {
	requestId: string
	route: string
	status: number
	appId?: string
	action?: string
}

interface GatewayDeps {
	controller: () => AppController
	log?: (entry: LogEntry) => void
}

export function createAppActionsGateway(deps: GatewayDeps): Hono {
	const log = deps.log ?? ((entry) => console.info(entry))
	const handle = async (
		route: string,
		details: { appId?: string; action?: string },
		run: (reply: (status: number, body: unknown) => Response) => Promise<Response>
	) => {
		const requestId = crypto.randomUUID()
		const reply = (status: number, body: unknown) => {
			log({ requestId, route, status, ...details })
			return new Response(JSON.stringify(body), {
				status,
				headers: { 'content-type': 'application/json; charset=UTF-8', 'x-request-id': requestId }
			})
		}
		try {
			return await run(reply)
		} catch (error) {
			const mapped = publicError(error)
			return reply(mapped.status, { error: { code: mapped.code, message: mapped.message } })
		}
	}

	return new Hono()
		.get('/', (_c) =>
			handle('GET /api/v1/apps', {}, async (reply) => reply(200, await deps.controller().list()))
		)
		.get('/:appId', (c) => {
			const details: { appId?: string } = {}
			return handle('GET /api/v1/apps/:appId', details, async (reply) => {
				const appId = decodeSegment(c.req.raw, 1)
				details.appId = appId
				return reply(200, await deps.controller().inspect(appId))
			})
		})
		.post('/:appId/actions/:action', (c) => {
			const details: { appId?: string; action?: string } = {}
			return handle('POST /api/v1/apps/:appId/actions/:action', details, async (reply) => {
				const appId = decodeSegment(c.req.raw, 3)
				details.appId = appId
				const action = decodeSegment(c.req.raw, 1)
				details.action = action
				const params = await readParams(c.req.raw)
				const controller = deps.controller()
				const inspection = await controller.inspect(appId)
				if (!Object.hasOwn(inspection.actions, action))
					return reply(404, {
						error: { code: 'action_not_found', message: 'action was not found' }
					})
				const result = await controller.run(appId, action, params)
				return reply(200, { result: result ?? null })
			})
		})
		.all('*', (_c) =>
			handle('INVALID /api/v1/apps', {}, async (reply) =>
				reply(400, {
					error: { code: 'invalid_request', message: 'malformed app action path' }
				})
			)
		)
}

async function readParams(request: Request): Promise<Record<string, unknown>> {
	const type = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
	if (type !== 'application/json')
		throw new Error('invalid request: content type must be application/json')

	const declaredLength = request.headers.get('content-length')
	if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES))
		throw new Error('invalid request: body exceeds 1 MiB')

	const reader = request.body?.getReader()
	if (!reader) throw new Error('invalid request: body must be a JSON object')
	const decoder = new TextDecoder()
	let bytes = 0
	let body = ''
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		bytes += value.byteLength
		if (bytes > MAX_BODY_BYTES) {
			await reader.cancel()
			throw new Error('invalid request: body exceeds 1 MiB')
		}
		body += decoder.decode(value, { stream: true })
	}
	body += decoder.decode()

	let parsed: unknown
	try {
		parsed = JSON.parse(body)
	} catch {
		throw new Error('invalid request: body must be valid JSON')
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
		throw new Error('invalid request: body must be a JSON object')
	return parsed as Record<string, unknown>
}

function decodeSegment(request: Request, fromEnd: number): string {
	const raw = new URL(request.url).pathname.split('/').at(-fromEnd)
	if (!raw) throw new Error('invalid request: path contains an empty segment')
	try {
		const decoded = decodeURIComponent(raw)
		if (!decoded) throw new Error()
		return decoded
	} catch {
		throw new Error('invalid request: path contains invalid encoding')
	}
}

function publicError(error: unknown): { status: number; code: ErrorCode; message: string } {
	const message = error instanceof Error ? error.message : ''
	if (message.startsWith('invalid request:'))
		return { status: 400, code: 'invalid_request', message: message.slice(17).trim() }
	if (message.startsWith('invalid params')) return { status: 400, code: 'invalid_params', message }
	if (message.startsWith('app not found'))
		return { status: 404, code: 'app_not_installed', message: 'app is not installed' }
	if (message.startsWith('unknown procedure'))
		return { status: 404, code: 'action_not_found', message: 'action was not found' }
	return { status: 500, code: 'action_failed', message: 'action failed' }
}
