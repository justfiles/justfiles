import { DurableObject } from 'cloudflare:workers'
import {
	type Action,
	type AppBundle,
	type AppManifest,
	kernel,
	safeBundlePath
} from '@justfiles/app/kernel'
import { createFsApi } from '@justfiles/core'
import { chroot, type Volume, volume } from '@justfiles/fs'
import type { AgentEvent } from '@mariozechner/pi-agent-core'
import { getModel } from '@mariozechner/pi-ai'
import { unzipSync } from 'fflate'
import { Hono } from 'hono'
import { type AppController, createAppCommand } from './bash/commands/app.ts'
import { cp, mv, rm } from './bash/commands/fs.ts'
import { createNowCommand } from './bash/commands/now.ts'
import { createBashTool } from './bash/index.ts'
import { CommandRegistry } from './bash/registry.ts'
import type { CompactionSettings } from './compaction'
import { scheduleDailyAlarm } from './daily-alarm.ts'
import { cfFsStorage, migrateCF } from './db.do.ts'
import { type Runtime, runtime } from './frieren.runtime'
import { integrationRoutes } from './integrations/api.ts'
import { AuditLog } from './integrations/audit.ts'
import { Coalescer } from './integrations/coalescer.ts'
import { fastmailIntegration } from './integrations/fastmail/index.ts'
import { icloudCalendarIntegration } from './integrations/icloud-calendar/index.ts'
import { TokenBucket } from './integrations/rate-limit.ts'
import { Integrations } from './integrations/registry.ts'
import { ConnectionStore } from './integrations/storage.ts'
import { workerSandbox } from './kernel.sandbox.ts'
import { createAgent } from './llm.agent'
import { type LLMText, text } from './llm.text'
import { parseFrontmatter } from './markdown'
import { SOUL_GENERATION_PROMPT, type SoulGenerationInput } from './prompts'
import type { SessionEntry } from './session.manager.ts'
import { resolveTimezone } from './timezone'
import { createFetchTool, createFsTools, createSearchTool } from './tools.ts'

interface ClientMessage {
	type:
		| 'prompt'
		| 'abort'
		| 'kernel_app_open'
		| 'kernel_app_close'
	text?: string
	id?: string
}

interface DisplayToolCall {
	name: string
	args: unknown
	result?: unknown
	isError?: boolean
}

interface DisplayMessage {
	readonly role: 'user' | 'assistant'
	readonly content: string
	readonly source?: 'user' | 'app'
	readonly thinking?: string
	readonly toolCalls?: ReadonlyArray<DisplayToolCall>
}

interface DisplayParticipants {
	readonly userName: string
	readonly agentName: string
}

interface DisplayApp {
	readonly id: string
	readonly name: string
	readonly description: string
	readonly iconUrl?: string
	readonly kind: 'builtin' | 'app'
}

type ServerMessage =
	| { type: 'ready'; participants?: DisplayParticipants; apps?: ReadonlyArray<DisplayApp> }
	| { type: 'history'; messages: ReadonlyArray<DisplayMessage>; participants?: DisplayParticipants }
	| { type: 'event'; event: AgentEvent }
	| { type: 'error'; message: string }
	// TODO: remove debug
	| { type: 'debug'; message: string }
	| { type: 'kernel_app_open'; id: string }
	| { type: 'kernel_app_close' }

const DEBUG_COMMAND = '/debug'
const CURRENT_KERNEL_APP_STORAGE_KEY = 'current_kernel_app'

const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000
}

export class Frieren extends DurableObject<Env> {
	private readonly app: Hono
	private readonly vol: Volume
	private runtime?: Runtime
	private text?: LLMText
	private cfTimezone?: string
	private integrations?: Integrations
	private readonly coalescer = new Coalescer()
	private kernelOnce?: Promise<ReturnType<typeof kernel>>
	private kernelSubscribed = false

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		const namespace = ctx.id.toString()
		const fs = cfFsStorage(ctx.storage, namespace, env.FS_BLOBS)
		this.vol = volume(fs)


		this.app = new Hono()
			.post('/api/nuke', async (c) => {
				await ctx.storage.deleteAll()
				await ctx.blockConcurrencyWhile(() => this.reset())
				return c.body(null, 204)
			})
			.post('/api/onboarding/soul', async (c) => {
				const body = await c.req.json<SoulGenerationInput>()
				if (!body?.agentName || !body?.archetype) {
					return c.json({ error: 'agentName and archetype are required' }, 400)
				}
				const generated = await this.generateSoul(body)
				return c.json({ text: generated })
			})
			.route(
				'/',
				integrationRoutes(() => this.requireIntegrations())
			)
			.post('/api/apps/install', async (c) => {
				try {
					const form = await c.req.formData()
					const bundle = form.get('bundle')
					if (!(bundle instanceof File)) throw new Error('bundle file is required')
					const id = await (await this.kernel()).install(
						bundleFromUploadedZip(new Uint8Array(await bundle.arrayBuffer()))
					)
					return c.json({ id, apps: await this.kernelApps() })
				} catch (error) {
					return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
				}
			})
			.delete('/api/apps/:id', async (c) => {
				try {
					await (await this.kernel()).uninstall(c.req.param('id'))
					return c.body(null, 204)
				} catch (error) {
					return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
				}
			})
			.get('/api/kernel/:appId/*', async (c) => {
				const appId = c.req.param('appId')
				let path: string
				try {
					path = safeBundlePath(c.req.path.split('/').slice(4).join('/'))
				} catch {
					return c.notFound()
				}
				try {
					const installed = await (await this.kernel()).app(appId)
					const data = await installed.read(path)
					const body = new ArrayBuffer(data.byteLength)
					new Uint8Array(body).set(data)
					return new Response(body, { headers: { 'content-type': mimeFor(path) } })
				} catch {
					return c.notFound()
				}
			})
			.route('/fs', createFsApi(fs))

		ctx.blockConcurrencyWhile(async () => {
			await this.reset()
		})
	}

	private requireIntegrations(): Integrations {
		if (!this.integrations) throw new Error('integrations not initialised')
		return this.integrations
	}

	private getTimezone = () => resolveTimezone(this.vol, this.cfTimezone)

	private async generateSoul(input: SoulGenerationInput): Promise<string> {
		if (!this.text) {
			const { model, apiKey } = this.getBackendConfig()
			this.text = text({ model, apiKey })
		}
		const lines: string[] = [`agent name: ${input.agentName}`, `archetype: ${input.archetype}`]
		if (input.agentGender) lines.push(`agent gender: ${input.agentGender}`)
		if (input.userAge !== undefined) lines.push(`user age: ${input.userAge}`)
		if (input.userGender) lines.push(`user gender: ${input.userGender}`)
		return this.text.gen(SOUL_GENERATION_PROMPT, lines.join('\n'))
	}

	private async reset() {
		const { model, apiKey } = this.getBackendConfig()
		await migrateCF(this.ctx.storage)
		this.runtime?.shutdown()
		this.text = text({ model, apiKey })
		const { agent, integrations } = this.buildAgent()
		this.integrations = integrations
		await integrations.hydrate()
		this.runtime = await runtime({
			volume: this.vol,
			agent,
			text: this.text,
			compaction: DEFAULT_COMPACTION_SETTINGS,
			getTimezone: this.getTimezone
		})
	}

	private getBackendConfig() {
		const openaiModel = getModel('openai', 'gpt-5.4-mini')

		// Local LM Studio backend — OpenAI-compatible /v1/chat/completions.
		// No real auth, but the OpenAI SDK requires a non-empty apiKey string.
		const localModel = {
			id: 'google/gemma-4-e4b',
			name: 'Gemma 4 (local)',
			api: 'openai-completions',
			provider: 'lm-studio',
			baseUrl: 'http://127.0.0.1:1234/v1',
			reasoning: false,
			input: ['text'],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192
		} as unknown as typeof openaiModel

		const backend = this.env.FRIEREN_BACKEND === 'local' ? 'local' : 'openai'

		if (backend === 'local') {
			return { model: localModel, apiKey: 'lm-studio' }
		}

		const apiKey = this.env.OPENAI_API_KEY
		if (!apiKey) {
			throw new Error(
				'OPENAI_API_KEY is not set. Add it to apps/frieren/.dev.vars (local) or as a Cloudflare secret (deployed), and declare it in wrangler.jsonc `secrets.required`.'
			)
		}
		return { model: openaiModel, apiKey }
	}

	private buildAgent() {
		const fs = createFsTools(this.vol)
		const bashRegistry = new CommandRegistry()
		for (const command of [
			cp,
			mv,
			rm,
			createNowCommand({ getTimezone: this.getTimezone }),
			createAppCommand(this.kernelAppController())
		])
			bashRegistry.register(command)
		const bash = createBashTool(bashRegistry, { vol: this.vol })
		const agent = createAgent(this.getBackendConfig())
		agent.state.tools = [...fs.tools, createFetchTool(), createSearchTool(), bash]

		const connections = new ConnectionStore(this.ctx.storage, this.env.INTEGRATION_KEY)
		const integrations = new Integrations({
			commands: bashRegistry,
			connections,
			audit: new AuditLog(this.ctx.storage),
			rateLimit: new TokenBucket({ capacity: 60, windowMs: 60_000 }),
			coalescer: this.coalescer
		})
		integrations.define(fastmailIntegration())
		integrations.define(icloudCalendarIntegration({ getTimezone: this.getTimezone }))
		return { agent, integrations }
	}

	// ── WebSocket handlers ────────────────────────────────────────────────

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		// Kernel sockets carry an {appId} attachment; chat sockets never do.
		const attachment = ws.deserializeAttachment() as { appId?: string } | null
		if (attachment?.appId) {
			await this.handleKernelMessage(ws, attachment.appId, message)
			return
		}

		await scheduleDailyAlarm(this.ctx, this.vol, this.cfTimezone)
		if (typeof message !== 'string') return

		let parsed: ClientMessage
		try {
			parsed = JSON.parse(message)
		} catch {
			ws.send(
				JSON.stringify({
					type: 'error',
					message: 'Invalid JSON'
				} satisfies ServerMessage)
			)
			return
		}


		if (parsed.type === 'abort') {
			this.runtime?.shutdown()
			return
		}

		if (parsed.type === 'kernel_app_open' && parsed.id) {
			await this.ctx.storage.put(CURRENT_KERNEL_APP_STORAGE_KEY, { id: parsed.id })
			this.broadcast({ type: 'kernel_app_open', id: parsed.id })
			return
		}

		if (parsed.type === 'kernel_app_close') {
			await this.ctx.storage.delete(CURRENT_KERNEL_APP_STORAGE_KEY)
			this.broadcast({ type: 'kernel_app_close' })
			return
		}

		if (parsed.type === 'prompt' && parsed.text) {
			const sp = this.runtime?.systemPrompt()
			const trimmed = parsed.text.trim()
			if (trimmed === DEBUG_COMMAND) {
				ws.send(
					JSON.stringify({
						type: 'debug',
						message: sp ?? ''
					} satisfies ServerMessage)
				)
				return
			}

			const unsubscribe = this.runtime?.subscribe((event, _signal) => {
				ws.send(
					JSON.stringify({
						type: 'event',
						event
					} satisfies ServerMessage)
				)
			})
			try {
				const promptText = parsed.text
				await this.coalescer.during(async () => {
					await this.runtime?.prompt(promptText, 'user')
				})
			} catch (error) {
				ws.send(
					JSON.stringify({
						type: 'error',
						message: error instanceof Error ? error.message : String(error)
					} satisfies ServerMessage)
				)
			} finally {
				unsubscribe?.()
			}
		}
	}

	private broadcast(message: ServerMessage): void {
		const payload = JSON.stringify(message)
		for (const client of this.ctx.getWebSockets()) client.send(payload)
	}

	// ── Kernel app transport ─────────────────────────────────────────────
	//
	// One per-user WebSocket carries the SDK `Transport` both ways:
	//   C→S  {"id":string,"action":{"type":string,"params":unknown}}
	//   S→C  {"type":"state","state":unknown}                 (push)
	//        {"type":"result","id":string,"result":unknown}   (invoke reply)
	//        {"type":"error","id"?:string,"message":string}
	// State is push-only (kernel.subscribe → app.update); the `result` frame
	// only resolves the correlated `invoke` promise — same contract the dev
	// server proves over REST+SSE, here over a single hibernatable socket.

	private kernelAppController(): AppController {
		return {
			list: async () =>
				(await this.kernelApps()).map(({ id, name, description }) => ({ id, name, description })),
			launch: async (id) => {
				const app = await this.inspectKernelApp(id)
				await this.ctx.storage.put(CURRENT_KERNEL_APP_STORAGE_KEY, { id })
				this.broadcast({ type: 'kernel_app_open', id })
				return app
			},
			close: async () => {
				await this.ctx.storage.delete(CURRENT_KERNEL_APP_STORAGE_KEY)
				this.broadcast({ type: 'kernel_app_close' })
			},
			current: async () => {
				const saved = await this.ctx.storage.get<{ id: string }>(CURRENT_KERNEL_APP_STORAGE_KEY)
				return saved ? await this.inspectKernelApp(saved.id).catch(() => undefined) : undefined
			},
			inspect: (id) => this.inspectKernelApp(id),
			state: async (id) => await (await this.kernel()).state(id),
			run: async (id, action, params) => {
				await this.ensureSubscribed()
				return await (await this.kernel()).dispatch(id, { type: action, params, actor: 'agent' })
			}
		}
	}

	private async inspectKernelApp(appId: string) {
		const k = await this.kernel()
		const installed = await k.app(appId)
		const [state, actions] = await Promise.all([
			k.state(appId).catch(() => undefined),
			k.actions(appId)
		])
		return {
			id: installed.manifest.id,
			name: installed.manifest.name,
			description: '',
			state: state ?? null,
			actions
		}
	}

	private async currentKernelAppId(): Promise<string | undefined> {
		return (await this.ctx.storage.get<{ id: string }>(CURRENT_KERNEL_APP_STORAGE_KEY))?.id
	}

	private async kernelApps(): Promise<ReadonlyArray<DisplayApp>> {
		try {
			const manifests = await (await this.kernel()).list()
			return manifests.map((m) => ({
				id: m.id,
				name: m.name,
				description: m.description ?? '',
				iconUrl: m.icon ? `/api/kernel/${m.id}/${m.icon}` : undefined,
				kind: 'app'
			}))
		} catch {
			return []
		}
	}

	private kernel(): Promise<ReturnType<typeof kernel>> {
		this.kernelOnce ??= (async () => {
			if (!this.env.LOADER) throw new Error('LOADER binding unavailable')
			return kernel({
				fs: chroot(this.vol, '/kernel'),
				sandbox: workerSandbox(this.env.LOADER, {
					capabilities: (req) => this.invokeKernelCapability(req)
				}),
				clock: {}
			})
		})()
		return this.kernelOnce
	}

	private async invokeKernelCapability(req: {
		capability: string
		method: string
		input: unknown
		appId: string
		actor?: string
	}): Promise<unknown> {
		if (req.capability !== 'ai' || req.method !== 'generateText') {
			throw capabilityError('CAPABILITY_UNAVAILABLE', req.capability, req.method)
		}
		const input = req.input as { system?: unknown; prompt?: unknown }
		if (!input || typeof input !== 'object' || typeof input.prompt !== 'string') {
			throw capabilityError('CAPABILITY_INVALID_INPUT', req.capability, req.method)
		}
		if (!this.text) {
			const { model, apiKey } = this.getBackendConfig()
			this.text = text({ model, apiKey })
		}
		return {
			text: await this.text.gen(typeof input.system === 'string' ? input.system : '', input.prompt)
		}
	}

	// kernel.subscribe's handler is in-memory, so it dies with the DO on
	// hibernation. Re-registered lazily per instance; it fans `app.update`
	// to every live socket whose attachment appId matches the event.
	private async ensureSubscribed(): Promise<void> {
		if (this.kernelSubscribed) return
		this.kernelSubscribed = true
		const k = await this.kernel()
		k.subscribe((event) => {
			if (event.type !== 'app.update') return
			const frame = JSON.stringify({ type: 'state', state: event.state })
			for (const socket of this.ctx.getWebSockets()) {
				const attachment = socket.deserializeAttachment() as { appId?: string } | null
				if (attachment?.appId === event.appId) socket.send(frame)
			}
		})
	}

	private async kernelWebSocket(appId: string): Promise<Response> {
		const k = await this.kernel()
		const { 0: client, 1: server } = new WebSocketPair()
		this.ctx.acceptWebSocket(server)
		server.serializeAttachment({ appId })
		await this.ensureSubscribed()
		// Always emit a snapshot frame on connect — both as the reconciliation
		// snapshot for a reload and as the "ready to mount" signal for a fresh
		// GUI. State may be `null` for never-dispatched apps; the GUI passes
		// that through to its mount() and renders whatever bootstrap it wants.
		const snapshot = await k.state(appId).catch(() => undefined)
		server.send(JSON.stringify({ type: 'state', state: snapshot ?? null }))
		return new Response(null, { status: 101, webSocket: client })
	}

	private async handleKernelMessage(
		ws: WebSocket,
		appId: string,
		message: string | ArrayBuffer
	): Promise<void> {
		if (typeof message !== 'string') return
		let request: { id?: string; action?: Action }
		try {
			request = JSON.parse(message)
		} catch {
			ws.send(JSON.stringify({ type: 'error', message: 'invalid JSON' }))
			return
		}
		await this.ensureSubscribed()
		try {
			const k = await this.kernel()
			const result = await k.dispatch(appId, request.action as Action)
			ws.send(JSON.stringify({ type: 'result', id: request.id, result }))
		} catch (error) {
			ws.send(
				JSON.stringify({
					type: 'error',
					id: request.id,
					message: error instanceof Error ? error.message : String(error)
				})
			)
		}
	}

	async webSocketClose(
		ws: WebSocket,
		code: number,
		_reason: string,
		_wasClean: boolean
	): Promise<void> {
		ws.close(code, 'Durable Object is closing WebSocket')
	}

	async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
		ws.close(1011, 'WebSocket error')
	}

	// Do not reschedule here — only WebSocket interactions set the next alarm,
	// so a silent day naturally stops the daily routine.
	async alarm(): Promise<void> {
		await this.runtime?.consolidateMemory()
	}

	async fetch(request: Request): Promise<Response> {
		this.cfTimezone = (request.cf as { timezone?: string } | undefined)?.timezone

		// Handle WebSocket upgrade
		const upgradeHeader = request.headers.get('Upgrade')
		if (upgradeHeader === 'websocket') {
			const kernelRoute = new URL(request.url).pathname.match(/^\/api\/kernel\/([^/]+)\/ws$/)
			if (kernelRoute) return this.kernelWebSocket(kernelRoute[1])

			// Agent is long-lived — transformContext re-reads soul.md every turn,
			// so there is no need to recreate the agent on reconnect.
			const pair = new WebSocketPair()
			const [client, server] = Object.values(pair)

			this.ctx.acceptWebSocket(server)
			await scheduleDailyAlarm(this.ctx, this.vol, this.cfTimezone)

			const participants = await this.loadParticipants()
			const history = sessionEntries2DisplayMessages((await this.runtime?.history()) ?? [])
			if (history.length > 0) {
				server.send(
					JSON.stringify({
						type: 'history',
						messages: history,
						participants
					} satisfies ServerMessage)
				)
			}

			// Send ready signal
			server.send(
				JSON.stringify({
					type: 'ready',
					participants,
					apps: await this.kernelApps()
				} satisfies ServerMessage)
			)

			const kernelAppId = await this.currentKernelAppId()
			if (kernelAppId) server.send(JSON.stringify({ type: 'kernel_app_open', id: kernelAppId }))

			return new Response(null, {
				status: 101,
				webSocket: client
			})
		}

		return this.app.fetch(request)
	}

	private async loadParticipants(): Promise<DisplayParticipants> {
		const [profile, soul] = await Promise.all([
			readFrontmatter(this.vol, '/profiles/user.md'),
			readFrontmatter(this.vol, '/soul.md')
		])

		return {
			userName: profile.name || 'You',
			agentName: soul.agent_name || 'Frieren'
		}
	}
}

function bundleFromUploadedZip(zip: Uint8Array): AppBundle {
	const rawEntries = Object.entries(unzipSync(zip))
	const entries = rawEntries.filter(
		([path]) => !path.endsWith('/') && !rawEntries.some(([other]) => other.startsWith(`${path}/`))
	)
	const prefix = entries.some(([path]) => path === 'manifest.json')
		? ''
		: commonTopLevelPrefix(entries.map(([path]) => path))
	const map = new Map<string, Uint8Array>()
	for (const [path, bytes] of entries)
		map.set(safeBundlePath(prefix ? path.slice(prefix.length) : path), bytes)
	return {
		async manifest() {
			const bytes = map.get('manifest.json')
			if (!bytes) throw new Error('missing manifest.json')
			return JSON.parse(new TextDecoder().decode(bytes)) as AppManifest
		},
		async *list() {
			yield* map.keys()
		},
		async read(path) {
			const bytes = map.get(safeBundlePath(path))
			if (!bytes) throw new Error(`file not found: ${path}`)
			return bytes
		}
	}
}

function commonTopLevelPrefix(paths: string[]): string {
	const roots = new Set(paths.map((path) => path.split('/')[0]).filter(Boolean))
	if (roots.size !== 1) return ''
	const prefix = `${[...roots][0]}/`
	return paths.includes(`${prefix}manifest.json`) ? prefix : ''
}

function capabilityError(code: string, capability: string, method: string): Error {
	return Object.assign(new Error(code), { code, capability, method })
}

const MIME: Record<string, string> = {
	html: 'text/html; charset=utf-8',
	js: 'application/javascript; charset=utf-8',
	mjs: 'application/javascript; charset=utf-8',
	css: 'text/css; charset=utf-8',
	json: 'application/json; charset=utf-8',
	svg: 'image/svg+xml',
	wasm: 'application/wasm',
	wad: 'application/octet-stream',
	cfg: 'text/plain; charset=utf-8',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	webp: 'image/webp'
}

function mimeFor(path: string): string {
	const ext = path.split('.').pop()?.toLowerCase() ?? ''
	return MIME[ext] ?? 'application/octet-stream'
}

function sessionEntries2DisplayMessages(entries: readonly SessionEntry[]): DisplayMessage[] {
	const messages: DisplayMessage[] = []
	for (const entry of entries) {
		if (entry.type === 'message' && entry.role === 'tool_result') {
			const last = messages[messages.length - 1]
			const toolCalls = last?.toolCalls ? [...last.toolCalls] : []
			const index = toolCalls.findLastIndex(
				(toolCall) => toolCall.name === entry.tool_name && toolCall.result === undefined
			)
			if (last?.role === 'assistant' && index >= 0) {
				toolCalls[index] = { ...toolCalls[index], result: parseToolResult(entry.content) }
				messages[messages.length - 1] = { ...last, toolCalls }
				continue
			}
		}

		const message = sessionEntry2DisplayMessage(entry)
		if (!message) continue

		const last = messages[messages.length - 1]
		if (
			last?.role === 'assistant' &&
			!last.content &&
			last.toolCalls?.length &&
			message.role === 'assistant' &&
			message.toolCalls?.length
		) {
			messages[messages.length - 1] = {
				...last,
				toolCalls: [...last.toolCalls, ...message.toolCalls]
			}
			continue
		}

		messages.push(message)
	}
	return messages
}

function parseToolResult(content: string): unknown {
	try {
		return JSON.parse(content)
	} catch {
		return content
	}
}

function sessionEntry2DisplayMessage(entry: SessionEntry): DisplayMessage | null {
	switch (entry.type) {
		case 'message':
			switch (entry.role) {
				case 'user':
					return { role: 'user', content: entry.content, source: entry.source ?? 'user' }
				case 'assistant':
					return { role: 'assistant', content: entry.content }
				case 'assistant_thinking':
					return { role: 'assistant', content: '', thinking: entry.content }
				case 'tool_call':
					return {
						role: 'assistant',
						content: '',
						toolCalls: [{ name: entry.tool_name, args: entry.input }]
					}
				case 'tool_result':
					return {
						role: 'assistant',
						content: `[${entry.tool_name}]: ${entry.content}`
					}
				default:
					throw new Error('unsupported message role')
			}
		case 'compaction':
			return { role: 'assistant', content: entry.summary }
		case 'branch_summary':
			return { role: 'assistant', content: entry.summary }
		case 'label':
			return { role: 'assistant', content: `[${entry.label}]` }
	}
}

async function readFrontmatter(vol: Volume, path: string): Promise<Record<string, string>> {
	if (!(await vol.exists(path))) return {}
	return parseFrontmatter(new TextDecoder().decode(await vol.readFile(path)))
}
