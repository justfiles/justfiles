import { DurableObject } from 'cloudflare:workers'
import {
	CommandRegistry,
	type CompactionSettings,
	cp,
	createAgent,
	createAppCommand,
	createBashTool,
	createFetchTool,
	createFsTools,
	createNowCommand,
	createSearchTool,
	type LLMText,
	mv,
	parseFrontmatter,
	type Runtime,
	resolveTimezone,
	rm,
	runtime,
	SOUL_GENERATION_PROMPT,
	type SoulGenerationInput,
	text
} from '@justfiles/agent'
import type { AccountsStore, ProviderRegistry } from '@justfiles/app/capabilities/accounts/host'
import { createFsApi } from '@justfiles/core'
import { type Volume, volume } from '@justfiles/fs'
import type { AgentEvent } from '@mariozechner/pi-agent-core'
import { getModel } from '@mariozechner/pi-ai'
import { Hono } from 'hono'
import { activatingStore, CommandActivator } from './accounts/commands.ts'
import { buildProviders } from './accounts/providers.ts'
import { accountsStore } from './accounts/store.ts'
import { scheduleDailyAlarm } from './daily-alarm.ts'
import { cfFsStorage, migrateCF } from './db.do.ts'
import { type FrierenApps, frierenApps } from './frieren.app.ts'
import { AuditLog } from './integrations/audit.ts'
import { Coalescer } from './integrations/coalescer.ts'
import { TokenBucket } from './integrations/rate-limit.ts'

interface ClientMessage {
	type: 'prompt' | 'abort' | 'app_open' | 'app_close'
	text?: string
	id?: string
}

import { type DisplayMessage, sessionEntries2DisplayMessages } from './display'

interface DisplayParticipants {
	readonly userName: string
	readonly agentName: string
}

type ServerMessage =
	| {
			type: 'ready'
			participants?: DisplayParticipants
			apps?: Awaited<ReturnType<FrierenApps['list']>>
	  }
	| { type: 'history'; messages: ReadonlyArray<DisplayMessage>; participants?: DisplayParticipants }
	| { type: 'event'; event: AgentEvent }
	| { type: 'error'; message: string }
	// TODO: remove debug
	| { type: 'debug'; message: string }
	| { type: 'app_open'; id: string }
	| { type: 'app_close'; id: string }

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
	private accounts?: { providers: ProviderRegistry; store: AccountsStore }
	private readonly coalescer = new Coalescer()
	private apps?: FrierenApps

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
			.post('/api/apps/install', async (c) => {
				try {
					const form = await c.req.formData()
					const bundle = form.get('bundle')
					if (!(bundle instanceof File)) throw new Error('bundle file is required')
					const apps = this.requireApps()
					const id = await apps.kernel.install(
						apps.bundleFromZip(new Uint8Array(await bundle.arrayBuffer()))
					)
					return c.json({ id, apps: await apps.list() })
				} catch (error) {
					return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
				}
			})
			.delete('/api/apps/:id', async (c) => {
				try {
					await this.requireApps().kernel.uninstall(c.req.param('id'))
					return c.body(null, 204)
				} catch (error) {
					return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
				}
			})
			.get('/api/apps/:appId/*', (c) =>
				this.requireApps().asset(
					c.req.param('appId'),
					c.req.path.split('/').slice(4).join('/'),
					c.req.query('v')
				)
			)
			.route('/fs', createFsApi(fs))

		ctx.blockConcurrencyWhile(async () => {
			await this.reset()
		})
	}

	private requireAccounts(): { providers: ProviderRegistry; store: AccountsStore } {
		if (!this.accounts) throw new Error('accounts not initialised')
		return this.accounts
	}

	private requireApps(): FrierenApps {
		if (!this.apps) throw new Error('apps not initialised')
		return this.apps
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
		this.apps = frierenApps({
			fs: this.vol,
			loader: this.env.LOADER,
			assets: this.env.ASSETS,
			sockets: () => this.ctx.getWebSockets(),
			acceptWebSocket: (ws) => this.ctx.acceptWebSocket(ws),
			text: this.text,
			broadcast: (msg) => this.broadcast(msg),
			accounts: () => this.requireAccounts()
		})
		const { agent, accounts, activator } = this.buildAgent()
		this.accounts = accounts
		await activator.hydrate(accounts.store)
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
			createAppCommand(this.requireApps().controller)
		])
			bashRegistry.register(command)
		const bash = createBashTool(bashRegistry, { vol: this.vol })
		const agent = createAgent(this.getBackendConfig())
		agent.state.tools = [...fs.tools, createFetchTool(), createSearchTool(), bash]

		// Accounts back both the use-facet capabilities (email/calendar) and the
		// agent's per-account commands; the activator keeps the latter in sync with
		// the store (rate-limited + audited).
		const { registry: providers, commands: factories } = buildProviders({
			getTimezone: this.getTimezone
		})
		const activator = new CommandActivator({
			commands: bashRegistry,
			factories,
			audit: new AuditLog(this.ctx.storage),
			rateLimit: new TokenBucket({ capacity: 60, windowMs: 60_000 }),
			coalescer: this.coalescer
		})
		const store = activatingStore(
			accountsStore(this.ctx.storage, this.env.INTEGRATION_KEY),
			activator
		)
		return { agent, accounts: { providers, store }, activator }
	}

	// ── WebSocket handlers ────────────────────────────────────────────────

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		// The shared capability-proxy socket carries {caps:true}; agent sockets
		// carry neither.
		const attachment = ws.deserializeAttachment() as { caps?: boolean } | null
		if (attachment?.caps) {
			await this.requireApps().handleMessage(ws, undefined, message)
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

		if (parsed.type === 'app_open' && parsed.id) {
			await this.requireApps().open(parsed.id)
			return
		}

		if (parsed.type === 'app_close') {
			await this.requireApps().close(parsed.id)
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
			const appRoute = new URL(request.url).pathname.match(/^\/api\/apps\/([^/]+)\/ws$/)
			if (appRoute) return this.requireApps().acceptWebSocket(appRoute[1])

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
					apps: await this.requireApps().list()
				} satisfies ServerMessage)
			)

			return new Response(null, {
				status: 101,
				webSocket: client
			})
		}

		return this.app.fetch(request)
	}

	private async loadParticipants(): Promise<DisplayParticipants> {
		const [profile, soul] = await Promise.all([
			readFrontmatter(this.vol, '/system/profiles/user.md'),
			readFrontmatter(this.vol, '/system/soul.md')
		])

		return {
			userName: profile.name || 'You',
			agentName: soul.agent_name || 'Frieren'
		}
	}
}

async function readFrontmatter(vol: Volume, path: string): Promise<Record<string, string>> {
	if (!(await vol.exists(path))) return {}
	return parseFrontmatter(new TextDecoder().decode(await vol.readFile(path)))
}
