import { DurableObject } from 'cloudflare:workers'
import type { AppRpcResponse, RequestId } from '@justfiles/app'
import type { CapabilityBridge } from '@justfiles/app/capabilities'
import { createFsApi } from '@justfiles/core'
import { type Volume, volume } from '@justfiles/fs'
import type { AgentEvent } from '@mariozechner/pi-agent-core'
import { getModel } from '@mariozechner/pi-ai'
import { Hono } from 'hono'
import { cp, mv, rm } from './bash/commands/fs.ts'
import { createNowCommand } from './bash/commands/now.ts'
import { createBashTool } from './bash/index.ts'
import { CommandRegistry } from './bash/registry.ts'
import type { CompactionSettings } from './compaction'
import { scheduleDailyAlarm } from './daily-alarm.ts'
import { cfFsStorage, migrateCF } from './db.do.ts'
import { AppHost, listApps } from './frieren.app'
import { type Runtime, runtime } from './frieren.runtime'
import { integrationRoutes } from './integrations/api.ts'
import { AuditLog } from './integrations/audit.ts'
import { Coalescer } from './integrations/coalescer.ts'
import { fastmailIntegration } from './integrations/fastmail/index.ts'
import { icloudCalendarIntegration } from './integrations/icloud-calendar/index.ts'
import { TokenBucket } from './integrations/rate-limit.ts'
import { Integrations } from './integrations/registry.ts'
import { ConnectionStore } from './integrations/storage.ts'
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
		| 'app_launch'
		| 'app_close'
		| 'app_rpc'
		| 'app_tool_result'
		| 'app_iframe_reload'
	text?: string
	id?: string
	frame?: { id: RequestId; method: string; params: unknown }
	callId?: string
	result?: unknown
	error?: { code: number; message: string }
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
}

type ServerMessage =
	| { type: 'ready'; participants?: DisplayParticipants; apps?: ReadonlyArray<DisplayApp> }
	| { type: 'history'; messages: ReadonlyArray<DisplayMessage>; participants?: DisplayParticipants }
	| { type: 'app_prompt'; text: string }
	| { type: 'event'; event: AgentEvent }
	| { type: 'error'; message: string }
	// TODO: remove debug
	| { type: 'debug'; message: string }
	| { type: 'app_open'; id: string; ui: { url: string } }
	| { type: 'app_close' }
	| { type: 'app_rpc'; frame: AppRpcResponse }
	| { type: 'app_tool_invoke'; callId: string; name: string; input: unknown }

const DEBUG_COMMAND = '/debug'

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
	private apps: AppHost
	private integrations?: Integrations
	private readonly coalescer = new Coalescer()

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		const namespace = ctx.id.toString()
		const fs = cfFsStorage(ctx.storage, namespace)
		this.vol = volume(fs)

		this.apps = new AppHost({
			storage: ctx.storage,
			volume: this.vol,
			websockets: () => ctx.getWebSockets(),
			runtime: () => this.runtime,
			capabilityBridge: this.capabilityBridge(),
			sendAgentPrompt: (ws, text) => this.promptAgent(ws, text, { throwOnError: true })
		})

		this.app = new Hono()
			.post('/api/nuke', async (c) => {
				await this.apps.clear()
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
		await this.apps.rebind()
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
		for (const command of [cp, mv, rm, createNowCommand({ getTimezone: this.getTimezone })])
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
		await scheduleDailyAlarm(this.ctx, this.vol, this.cfTimezone)
		await this.apps.hydrate()
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

		if (await this.apps.handleMessage(ws, parsed)) return

		if (parsed.type === 'abort') {
			this.runtime?.shutdown()
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

			if (await this.apps.handlePromptCommand(trimmed)) return

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

	// ── App RPC support ──────────────────────────────────────────────

	// Capability broker bridge handed to the RPC dispatcher. Until the
	// broker integration lands (#59) every capability call is denied with a
	// stable shape so apps fail loudly instead of silently.
	private capabilityBridge(): CapabilityBridge {
		return {
			async invoke(req) {
				throw {
					code: 'CAPABILITY_FAILED',
					message: 'no broker configured',
					capability: req.capability,
					method: req.method
				}
			}
		}
	}

	private async promptAgent(
		ws: WebSocket,
		prompt: string,
		options: { throwOnError?: boolean } = {}
	): Promise<string> {
		ws.send(JSON.stringify({ type: 'app_prompt', text: prompt } satisfies ServerMessage))
		const unsubscribe = this.runtime?.subscribe((event, _signal) => {
			ws.send(JSON.stringify({ type: 'event', event } satisfies ServerMessage))
		})
		try {
			let answer = ''
			await this.coalescer.during(async () => {
				answer = (await this.runtime?.prompt(prompt, 'app')) ?? ''
			})
			return answer
		} catch (error) {
			ws.send(
				JSON.stringify({
					type: 'error',
					message: error instanceof Error ? error.message : String(error)
				} satisfies ServerMessage)
			)
			if (options.throwOnError) throw error
			return ''
		} finally {
			unsubscribe?.()
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
			// Agent is long-lived — transformContext re-reads soul.md every turn,
			// so there is no need to recreate the agent on reconnect.
			const pair = new WebSocketPair()
			const [client, server] = Object.values(pair)

			this.ctx.acceptWebSocket(server)
			await scheduleDailyAlarm(this.ctx, this.vol, this.cfTimezone)
			await this.apps.hydrate()

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
				JSON.stringify({ type: 'ready', participants, apps: listApps() } satisfies ServerMessage)
			)

			// If an app is already running, send the URL so this client can
			// boot the iframe from scratch.
			const open = this.apps.openMessage()
			if (open) server.send(JSON.stringify(open))

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
