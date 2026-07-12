import { DurableObject } from 'cloudflare:workers'
import {
	type AgentSession,
	apiKeyBackend,
	createAgentSession,
	type LLMText,
	parseFrontmatter,
	resolveTimezone,
	SOUL_GENERATION_PROMPT,
	type SoulGenerationInput,
	text
} from '@justfiles/agent'
import { accountsCapabilities } from '@justfiles/app/capabilities/accounts/host'
import {
	clearReset,
	createFsApi,
	type DbAdapter,
	type ResetBody,
	type ResetResult,
	readGenerationState,
	resetVolume
} from '@justfiles/core'
import { type Volume, volume } from '@justfiles/fs'
import type { AgentEvent } from '@mariozechner/pi-agent-core'
import { getModel } from '@mariozechner/pi-ai'
import { Hono } from 'hono'
import { ensureAgentDefaults } from '../shared/agent-defaults.ts'
import { guardCapability } from './accounts/guard.ts'
import { buildProviders } from './accounts/providers.ts'
import { scheduleDailyAlarm } from './daily-alarm.ts'
import { cfFsStorage, createDOSqliteAdapter, migrateCF } from './db.do.ts'
import { type FrierenApps, frierenApps } from './frieren.app.ts'
import { AuditLog } from './integrations/audit.ts'
import { TokenBucket } from './integrations/rate-limit.ts'

// Only the first-party Settings app may reach the `accounts` admin facet.
const ACCOUNTS_FIRST_PARTY = ['app.frieren.settings']

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

export class Frieren extends DurableObject<Env> {
	private readonly app: Hono
	private readonly db: DbAdapter
	private readonly fs: ReturnType<typeof cfFsStorage>
	private vol: Volume
	private session?: AgentSession
	private text?: LLMText
	private cfTimezone?: string
	private apps?: FrierenApps

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		const namespace = ctx.id.toString()
		const adapter = createDOSqliteAdapter(ctx.storage)
		const fs = cfFsStorage(adapter, namespace, env.FS_BLOBS)
		this.db = adapter
		this.fs = fs
		this.vol = volume(fs)

		this.app = new Hono()
			.post('/api/agent/soul', async (c) => {
				const body = await c.req.json<SoulGenerationInput>()
				if (!body?.agentName || !body?.archetype) {
					return c.json({ error: 'agentName and archetype are required' }, 400)
				}
				const generated = await this.generateSoul(body)
				return c.json({ text: generated })
			})
			.route(
				'/fs',
				createFsApi(fs, {
					// The two sides of the server volume's lineage: read the epoch, and
					// mutate it. Both need the DO's raw store (and, for reset, a cache
					// rebuild), so they are injected; createFsApi owns the routes.
					lineage: () => readGenerationState(this.db),
					reset: (req) => this.handleReset(req)
				})
			)

		ctx.blockConcurrencyWhile(async () => {
			await this.reset()
		})
	}

	// The lineage-mutation capability behind POST /fs/reset (createFsApi validates
	// the body and owns the HTTP envelope; this is the DO-level body it calls).
	// `adopt-mine`/`wipe` — CAS + truncate + bump. `complete` — advisory: the
	// initiator's republish drained, so clear the in-progress flag.
	private async handleReset(req: ResetBody): Promise<ResetResult> {
		if (req.mode === 'complete') {
			const state = await clearReset(this.db, req.resetId)
			// The republish is durable — rebuild the volume + agent session against it.
			this.vol = volume(this.fs)
			await this.reset()
			return { ok: true, generation: state.generation }
		}
		const decision = await resetVolume(this.db, {
			mode: req.mode,
			fromGeneration: req.fromGeneration,
			resetId: req.resetId
		})
		if (!decision.ok) return decision
		// The reset wrote the DB directly, so the cached volume is stale — rebuild it.
		// `wipe` reseeds agent defaults + rebuilds the session now; `adopt-mine` leaves
		// the empty volume for the initiator to republish over ordinary sync (the next
		// DO restart reseeds any still-missing defaults).
		this.vol = volume(this.fs)
		if (req.mode === 'wipe') await this.reset()
		return { ok: true, generation: decision.next.generation }
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
		await migrateCF(this.db)
		// Seed a default soul + empty profile so the agent works with no onboarding.
		// Idempotent — a personalized soul (synced from the client) is left untouched.
		await ensureAgentDefaults(this.vol)
		this.session?.abort()
		this.text = text({ model, apiKey })
		// Accounts live on the Volume; the factory hands back the capabilities. frieren keeps
		// its own env-keyed `ai` (agent backend + soul generation), so the factory's `ai` is
		// ignored. email/calendar are guarded (audit + rate-limit) and wired into the APPS —
		// the agent no longer reaches them directly (that returns as capability-provided agent
		// tools; see the plan's Step 3.5).
		const providers = buildProviders()
		const caps = accountsCapabilities(providers, this.vol, { firstParty: ACCOUNTS_FIRST_PARTY })
		const audit = new AuditLog(this.ctx.storage)
		const rateLimit = new TokenBucket({ capacity: 60, windowMs: 60_000 })
		const email = guardCapability(caps.email, { capability: 'email', audit, rateLimit })
		const calendar = guardCapability(caps.calendar, { capability: 'calendar', audit, rateLimit })
		this.apps = frierenApps({
			fs: this.vol,
			loader: this.env.LOADER,
			sockets: () => this.ctx.getWebSockets(),
			acceptWebSocket: (ws) => this.ctx.acceptWebSocket(ws),
			text: this.text,
			broadcast: (msg) => this.broadcast(msg),
			email,
			calendar,
			accounts: caps.accounts
		})
		// The agent PRODUCT: turn runner + tools (bash/fetch/search/ask_user + the `app`
		// command over the kernel) + compaction + classified errors. frieren's backend is
		// env-keyed (no rotation), so a static `apiKeyBackend` suffices.
		this.session = createAgentSession({
			volume: this.vol,
			backend: apiKeyBackend({ model, apiKey }),
			apps: this.requireApps().controller,
			timezone: this.getTimezone
		})
		// Surface classified turn errors to every open tab (the raw stream carries the tokens;
		// this carries the failure body and resets the client's streaming flag).
		this.session.subscribe((event) => {
			if (event.type === 'error') this.broadcast({ type: 'error', message: event.message })
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
			this.session?.abort()
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
			const trimmed = parsed.text.trim()
			if (trimmed === DEBUG_COMMAND) {
				ws.send(
					JSON.stringify({
						type: 'debug',
						message: (await this.session?.systemPrompt()) ?? ''
					} satisfies ServerMessage)
				)
				return
			}

			// Stream the raw turn events (live token/tool deltas) to this socket. The session's
			// turn runner catches + classifies failures (surfaced via the `error` subscription
			// wired in reset), so this never rejects.
			await this.session?.prompt(parsed.text, 'user', (event) =>
				ws.send(JSON.stringify({ type: 'event', event } satisfies ServerMessage))
			)
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
		await this.session?.runMaintenance()
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
			const history = sessionEntries2DisplayMessages((await this.session?.history()) ?? [])
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
