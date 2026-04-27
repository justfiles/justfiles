import { DurableObject } from 'cloudflare:workers'
import { createFsApi } from '@justfiles/core'
import { type Volume, volume } from '@justfiles/fs'
import type { AgentEvent, AgentTool } from '@mariozechner/pi-agent-core'
import { getModel } from '@mariozechner/pi-ai'
import { Hono } from 'hono'
import type { Action, Actor } from '../apps/engine'
import type { CompactionSettings } from './compaction'
import { scheduleDailyAlarm } from './daily-alarm.ts'
import { cfFsStorage, migrateCF } from './db.do.ts'
import { type AppFacet, buildAppTools, hasApp, loadAppFacet } from './frieren.app'
import { type Runtime, runtime } from './frieren.runtime'
import { createAgent } from './llm.agent'
import { type LLMText, text } from './llm.text'
import { parseFrontmatter } from './markdown'
import { SOUL_GENERATION_PROMPT, type SoulGenerationInput } from './prompts'
import type { SessionEntry } from './session.manager.ts'
import { createFetchTool, createFsTools, createSearchTool } from './tools.ts'

interface ClientMessage {
	type: 'prompt' | 'abort' | 'app_action'
	text?: string
	action?: Action
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
	readonly thinking?: string
	readonly toolCalls?: ReadonlyArray<DisplayToolCall>
}

interface DisplayParticipants {
	readonly userName: string
	readonly agentName: string
}

type ServerMessage =
	| { type: 'ready'; participants?: DisplayParticipants }
	| { type: 'history'; messages: ReadonlyArray<DisplayMessage>; participants?: DisplayParticipants }
	| { type: 'event'; event: AgentEvent }
	| { type: 'error'; message: string }
	// TODO: remove debug
	| { type: 'debug'; message: string }
	| { type: 'app_open'; id: string; ui: { url: string }; state: unknown }
	| { type: 'app_state'; id: string; state: unknown }
	| { type: 'app_close' }

const DEBUG_COMMAND = '/debug'
const CLOSE_COMMAND = '/close'
const AGENT_ID = 'agent'
const USER_ID = 'user'
const APP_STORAGE_KEY = 'active_app'

type DispatchResult =
	| { ok: true; view: unknown; narration?: string | null; availableActions?: readonly Action[] }
	| { ok: false; error: string }
type Dispatcher = (action: Action, actor: Actor) => Promise<DispatchResult>

interface ActiveApp {
	id: string
	facet: AppFacet
	tools: AgentTool[]
	userActor: Actor
	agentActor: Actor
	dispatch: Dispatcher
}

interface PersistedApp {
	id: string
}

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
	private activeApp?: ActiveApp

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		const namespace = ctx.id.toString()
		const fs = cfFsStorage(ctx.storage, namespace)
		this.vol = volume(fs)

		this.app = new Hono()
			.post('/api/nuke', async (c) => {
				await ctx.storage.deleteAll()
				await this.reset()
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
			.route('/fs', createFsApi(fs))

		ctx.blockConcurrencyWhile(async () => {
			await this.reset()
		})
	}

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
		this.runtime = await runtime({
			volume: this.vol,
			agent: this.buildAgent(),
			text: this.text,
			compaction: DEFAULT_COMPACTION_SETTINGS
		})
	}

	private getBackendConfig() {
		const openaiModel = getModel('openai', 'gpt-4.1-mini')

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
		const agent = createAgent(this.getBackendConfig())
		agent.state.tools = [...fs.tools, createFetchTool(), createSearchTool()]
		return agent
	}

	// ── WebSocket handlers ────────────────────────────────────────────────

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		await scheduleDailyAlarm(this.ctx, this.vol, this.cfTimezone)
		await this.hydrateApp()
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

		if (parsed.type === 'app_action' && parsed.action) {
			if (!this.activeApp) {
				ws.send(JSON.stringify({ type: 'error', message: 'No active app' } satisfies ServerMessage))
				return
			}
			await this.handleAppAction(ws, parsed.action)
			return
		}

		if (parsed.type === 'prompt' && parsed.text) {
			const sp = this.runtime?._agent().state.systemPrompt
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

			if (trimmed === CLOSE_COMMAND) {
				await this.closeApp()
				return
			}

			// `/counter`, `/chess`, … — launch the matching registered app.
			if (trimmed.startsWith('/')) {
				const id = trimmed.slice(1)
				if (hasApp(id)) {
					await this.launchApp(ws, id)
					return
				}
			}

			const unsubscribe = this.runtime?.subscribe((event, _signal) => {
				ws.send(
					JSON.stringify({
						type: 'event',
						event
					} satisfies ServerMessage)
				)
			})
			await this.runtime?.prompt(parsed.text)
			unsubscribe?.()
		}
	}

	// ── App orchestration ──────────────────────────────────────────────
	//
	// At most one app is active at a time. The engine + state live in a
	// per-app dynamic-worker facet (own SQLite), reached over RPC. The
	// supervisor only holds the facet stub, the agent-tool wrappers, and a
	// dispatcher closure that broadcasts state on every transition.
	//
	// DOs can hibernate between WS messages, so the active-app object is
	// rebuilt from a persisted `{ id }` on each wake.

	private async hydrateApp(): Promise<void> {
		if (this.activeApp) return
		const saved = await this.ctx.storage.get<PersistedApp>(APP_STORAGE_KEY)
		if (!saved || !hasApp(saved.id)) return
		const facet = loadAppFacet(this.ctx, this.env, saved.id)
		if (await facet.done()) {
			await this.ctx.storage.delete(APP_STORAGE_KEY)
			return
		}
		await this.mountApp(saved.id)
	}

	private async mountApp(id: string): Promise<ActiveApp> {
		const userActor: Actor = { id: USER_ID, kind: 'human' }
		const agentActor: Actor = { id: AGENT_ID, kind: 'agent' }
		const facet = loadAppFacet(this.ctx, this.env, id)

		// Single dispatch path for both human (app_action) and agent (tool
		// execute). Always broadcasts new view on success.
		const dispatch: Dispatcher = async (action, actor) => {
			const result = (await facet.dispatch(action, actor)) as DispatchResult
			if (result.ok) this.broadcastState(id, result.view)
			return result
		}

		const tools = await buildAppTools(facet, id, agentActor, dispatch)
		const active: ActiveApp = { id, facet, tools, userActor, agentActor, dispatch }
		this.activeApp = active

		const agent = this.runtime?._agent()
		if (agent) agent.state.tools = [...agent.state.tools, ...tools]

		await this.ctx.storage.put<PersistedApp>(APP_STORAGE_KEY, { id })
		await this.broadcastOpen(active)
		return active
	}

	private broadcastState(id: string, state: unknown): void {
		const payload = JSON.stringify({ type: 'app_state', id, state } satisfies ServerMessage)
		for (const client of this.ctx.getWebSockets()) client.send(payload)
	}

	private async broadcastOpen(active: ActiveApp): Promise<void> {
		const payload = JSON.stringify(await this.openMessage(active))
		for (const client of this.ctx.getWebSockets()) client.send(payload)
	}

	private async openMessage(active: ActiveApp): Promise<ServerMessage> {
		const state: unknown = await active.facet.view(active.userActor)
		return {
			type: 'app_open',
			id: active.id,
			ui: { url: `/apps/${active.id}/` },
			state
		}
	}

	private async launchApp(ws: WebSocket, id: string): Promise<void> {
		if (!hasApp(id)) return
		if (this.activeApp) await this.closeApp()
		const active = await this.mountApp(id)
		const briefing = await active.facet.briefing()
		if (briefing) await this.promptAgent(ws, briefing)
	}

	private async closeApp(): Promise<void> {
		if (!this.activeApp) return
		const { tools } = this.activeApp
		const agent = this.runtime?._agent()
		if (agent) agent.state.tools = agent.state.tools.filter((t) => !tools.includes(t))
		this.activeApp = undefined
		await this.ctx.storage.delete(APP_STORAGE_KEY)
		const payload = JSON.stringify({ type: 'app_close' } satisfies ServerMessage)
		for (const client of this.ctx.getWebSockets()) client.send(payload)
	}

	private async handleAppAction(ws: WebSocket, action: Action): Promise<void> {
		if (!this.activeApp) return
		const result = await this.activeApp.dispatch(action, this.activeApp.userActor)
		if (!result.ok) {
			ws.send(
				JSON.stringify({
					type: 'error',
					message: `App action rejected: ${result.error}`
				} satisfies ServerMessage)
			)
			return
		}
		if (result.narration) await this.promptAgent(ws, result.narration)
	}

	private async promptAgent(ws: WebSocket, prompt: string): Promise<void> {
		const unsubscribe = this.runtime?.subscribe((event, _signal) => {
			ws.send(JSON.stringify({ type: 'event', event } satisfies ServerMessage))
		})
		await this.runtime?.prompt(prompt)
		unsubscribe?.()
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
			await this.hydrateApp()

			const participants = await this.loadParticipants()
			const history = ((await this.runtime?.history()) ?? []).map(sessionEntry2DisplayMessage)
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
			server.send(JSON.stringify({ type: 'ready', participants } satisfies ServerMessage))

			// If an app is already running, send the URL + current state so
			// this client can boot the iframe from scratch.
			if (this.activeApp) {
				server.send(JSON.stringify(await this.openMessage(this.activeApp)))
			}

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

function sessionEntry2DisplayMessage(entry: SessionEntry): DisplayMessage {
	switch (entry.type) {
		case 'message':
			switch (entry.role) {
				case 'user':
					return { role: 'user', content: entry.content }
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
