import { DurableObject } from 'cloudflare:workers'
import type { AgentEvent } from '@earendil-works/pi-agent-core'
import {
	type Api,
	type CredentialStore,
	createImagesModels,
	createModels,
	createProvider,
	envApiKeyAuth,
	type Model,
	type Models,
	type Usage
} from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all'
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter'
import { openrouterImagesProvider } from '@earendil-works/pi-ai/providers/openrouter-images'
import {
	type AgentBackend,
	type AgentSession,
	createAgentSession,
	type LLMText,
	meterBackend,
	modelsBackend,
	parseFrontmatter,
	resolveTimezone,
	SOUL_GENERATION_PROMPT,
	type SoulGenerationInput,
	text
} from '@justfiles/agent'
import { ensureAgentDefaults, PROFILE_PATH, SOUL_PATH } from '@justfiles/agent/defaults'
import { sweepTrash } from '@justfiles/app'
import { capabilityRegistry } from '@justfiles/app/capabilities'
import {
	accountsCapabilities,
	ensureAccount,
	resolveAiAccount
} from '@justfiles/app/capabilities/accounts/host'
import { type GeneratedImage, imageAgentTools } from '@justfiles/app/capabilities/image'
import type { Notification } from '@justfiles/app/capabilities/notify'
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
import { Hono } from 'hono'
import { guardCapability } from './accounts/guard.ts'
import { buildProviders } from './accounts/providers.ts'
import { scheduleDailyAlarm } from './daily-alarm.ts'
import { cfFsStorage, createDOSqliteAdapter, migrateCF } from './db.do.ts'
import { type FrierenApps, frierenApps } from './frieren.app.ts'
import { AuditLog } from './integrations/audit.ts'
import { TokenBucket } from './integrations/rate-limit.ts'
import { accrueAi, readUsage } from './usage.ts'

// Only the first-party Settings app may reach the `accounts` admin facet.
const ACCOUNTS_FIRST_PARTY = ['computer.spud.settings']

// A one-entry CredentialStore over a static api key. `Models` prefers a stored key
// over ambient env, so this pins the platform key without touching process.env (absent
// in the Worker). No refresh path — the key doesn't rotate.
function apiKeyStore(providerId: string, key: string): CredentialStore {
	const credential = { type: 'api_key', key } as const
	return {
		read: async (pid) => (pid === providerId ? credential : undefined),
		list: async () => [{ providerId, type: 'api_key' }],
		modify: async (_pid, fn) => fn(credential),
		delete: async () => {}
	}
}

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
	// The frieren notification channel: the agent's turn pings / classified errors /
	// questions, broadcast to every open tab (the browser projects them onto the
	// omnibar pill + center). Producer code is shared; only this delivery is frieren's.
	| { type: 'notification'; notification: Notification }

const DEBUG_COMMAND = '/debug'

// Spud's image engine, picked from pi's OpenRouter images catalog. Fixed for now —
// a Settings picker (its own selection, separate from the text model) comes with
// the active-image work (#194).
const IMAGE_MODEL = 'google/gemini-3.1-flash-image'

export class Frieren extends DurableObject<Env> {
	private readonly app: Hono
	private readonly db: DbAdapter
	private readonly fs: ReturnType<typeof cfFsStorage>
	private vol: Volume
	private session?: AgentSession
	private text?: LLMText
	private cfTimezone?: string
	private apps?: FrierenApps
	// Usage accrual runs off the model-call stream, so concurrent calls could interleave a
	// read-modify-write of the KV counter. Serialize them through this chain so no
	// increment is lost; `ctx.waitUntil` keeps the DO alive until the write lands.
	private accrual: Promise<void> = Promise.resolve()

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
				return c.json(generated)
			})
			.get('/api/usage', async (c) =>
				c.json(await readUsage(ctx.storage, this.db, ctx.storage.sql.databaseSize))
			)
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

	// Wrap the platform backend with the passive usage meter so every text model call
	// (agent turns, soul generation, daily maintenance) accrues into the per-user counter.
	private meteredBackend(models: Models, model: Model<Api>): AgentBackend {
		return meterBackend(modelsBackend(models, model), (usage) => this.trackUsage(usage))
	}

	// Accrue one completed model call. Serialized through a promise chain to avoid a lost
	// read-modify-write, kept alive past the response via waitUntil, and best-effort (a
	// metering failure never surfaces to the caller).
	private trackUsage(usage: Usage): void {
		this.accrual = this.accrual.then(() => accrueAi(this.ctx.storage, usage)).catch(() => {})
		this.ctx.waitUntil(this.accrual)
	}

	private async generateSoul(
		input: SoulGenerationInput
	): Promise<{ text: string; firstWords: string }> {
		if (!this.text) {
			const { models, model } = this.aiRuntime()
			this.text = text(this.meteredBackend(models, model))
		}
		const lines: string[] = [`agent name: ${input.agentName}`, `archetype: ${input.archetype}`]
		if (input.agentGender) lines.push(`agent gender: ${input.agentGender}`)
		if (input.userAge !== undefined) lines.push(`user age: ${input.userAge}`)
		if (input.userGender) lines.push(`user gender: ${input.userGender}`)
		const context = lines.join('\n')
		const soul = await this.text.gen(SOUL_GENERATION_PROMPT, context)
		const firstWords = await this.text.gen(
			'Return one short opening sentence spoken by this agent. No label, explanation, or quotation marks.',
			`${context}\n\nsoul:\n${soul}`
		)
		return { text: soul, firstWords: firstWords.trim() }
	}

	private async reset() {
		const { models, model, generateImage } = this.aiRuntime()
		await migrateCF(this.db)
		// Seed a default soul + empty profile so the agent works with no onboarding.
		// Idempotent — a personalized soul (synced from the client) is left untouched.
		await ensureAgentDefaults(this.vol)
		// Spud AI: the platform-provided, always-on default backend. Seed it once with
		// `ai` enabled so a fresh user has a working agent; a returning user's toggle
		// (they may have turned it off or switched to another AI) is left untouched.
		await ensureAccount(this.vol, { accountId: 'spud', providerId: 'spud', enabled: ['ai'] })
		this.session?.abort()
		this.text = text(this.meteredBackend(models, model))
		// Accounts live on the Volume; the factory hands back the capabilities. frieren keeps
		// its own env-keyed `ai` (agent backend + soul generation), so the factory's `ai` is
		// ignored. email/calendar are guarded (audit + rate-limit) and wired into the APPS —
		// the agent no longer reaches them directly (that returns as capability-provided agent
		// tools; see the plan's Step 3.5).
		const providers = buildProviders({ text: this.text, generateImage })
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
			image: caps.image,
			email,
			calendar,
			accounts: caps.accounts
		})
		// The agent's LLM backend resolves from the enabled `ai` account (single-active):
		// Spud AI → the platform env backend; nothing enabled → no backend, so a turn
		// fails with a clear "turn on AI in Settings" the chat surfaces. Re-resolved per
		// turn, so toggling AI in Settings takes effect on the next prompt.
		const agentName = (await readFrontmatter(this.vol, SOUL_PATH)).agent_name || 'Frieren'
		// Capability-provided agent tools (Step 3.5): expose `image` to the agent when
		// the platform has an image engine (local LM Studio dev has none). Availability
		// still resolves per call through the active-AI account.
		const agentCaps = generateImage
			? {
					invoke: capabilityRegistry({ image: caps.image }).invoke,
					tools: [imageAgentTools]
				}
			: undefined
		this.session = createAgentSession({
			volume: this.vol,
			capabilities: agentCaps,
			backend: async () => {
				const backend = await resolveAiAccount(this.vol, ({ providerId }) =>
					providerId === 'spud' ? this.meteredBackend(models, model) : null
				)
				if (!backend) throw new Error('AI is turned off — enable an AI provider in Settings.')
				return backend
			},
			apps: this.requireApps().controller,
			timezone: this.getTimezone,
			// The frieren delivery channel: broadcast the agent's ping to every tab's
			// omnibar (mirrors `broadcast`). Producer code is untouched — passing a
			// channel is all it takes to light up notifications.
			notify: (notification) => this.broadcast({ type: 'notification', notification }),
			title: agentName
		})
		// Surface classified turn errors to every open tab (the raw stream carries the tokens;
		// this carries the failure body and resets the client's streaming flag).
		this.session.subscribe((event) => {
			if (event.type === 'error') this.broadcast({ type: 'error', message: event.message })
		})
	}

	// The platform AI runtime: a pi `Models` + selected model, plus (production only)
	// an image-generation fn over pi's parallel `ImagesModels` stack — same OpenRouter
	// key, its own model. Local dev (LM Studio) has no image engine, so `generateImage`
	// is absent and Spud backs no image capability there. The api key is supplied
	// through a small CredentialStore (a stored key wins over ambient env), so the
	// token never rides on the backend — `modelsBackend` seals it inside `Models`.
	private aiRuntime(): {
		models: Models
		model: Model<Api>
		generateImage?: (prompt: string) => Promise<GeneratedImage[]>
	} {
		if (this.env.FRIEREN_BACKEND === 'local') {
			// Local LM Studio — OpenAI-compatible /v1/chat/completions. No real auth, but the
			// client needs a non-empty key string (provided via the credential store below).
			const model: Model<'openai-completions'> = {
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
			}
			const models = createModels({ credentials: apiKeyStore('lm-studio', 'lm-studio') })
			models.setProvider(
				createProvider({
					id: 'lm-studio',
					name: 'LM Studio',
					baseUrl: 'http://127.0.0.1:1234/v1',
					auth: { apiKey: envApiKeyAuth('LM Studio', ['LM_STUDIO_API_KEY']) },
					models: [model],
					api: openAICompletionsApi()
				})
			)
			return { models, model: model as Model<Api> }
		}

		const apiKey = this.env.OPENROUTER_API_KEY
		if (!apiKey) {
			throw new Error(
				'OPENROUTER_API_KEY is not set. Add it to apps/frieren/.dev.vars (local) or as a Cloudflare secret (deployed), and declare it in wrangler.jsonc `secrets.required`.'
			)
		}
		const models = createModels({ credentials: apiKeyStore('openrouter', apiKey) })
		models.setProvider(openrouterProvider())
		const images = createImagesModels({ credentials: apiKeyStore('openrouter', apiKey) })
		images.setProvider(openrouterImagesProvider())
		const imageModel = images.getModel('openrouter', IMAGE_MODEL)
		return {
			models,
			model: getBuiltinModel('openrouter', 'openai/gpt-5.4-mini') as Model<Api>,
			generateImage: imageModel
				? async (prompt) => {
						const res = await images.generateImages(imageModel, {
							input: [{ type: 'text', text: prompt }]
						})
						if (res.stopReason !== 'stop')
							throw new Error(res.errorMessage ?? 'image generation failed')
						// Image generation runs on the parallel ImagesModels stack, so the backend
						// meter can't see it — accrue its usage here (when the provider reports it).
						if (res.usage) this.trackUsage(res.usage)
						return res.output.flatMap((b) =>
							b.type === 'image' ? [{ data: b.data, mimeType: b.mimeType }] : []
						)
					}
				: undefined
		}
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
		// Authoritative trash retention: the DO owns the synced fs, so sweeping here
		// (daily, no open tab required) is more reliable than the client — the deletes
		// just sync down. Best-effort; a failure retries on the next alarm.
		await sweepTrash(this.vol).catch(() => {})
		await this.session?.runMaintenance()
	}

	async fetch(request: Request): Promise<Response> {
		this.cfTimezone = (request.cf as { timezone?: string } | undefined)?.timezone

		// Handle WebSocket upgrade
		const upgradeHeader = request.headers.get('Upgrade')
		if (upgradeHeader === 'websocket') {
			const appRoute = new URL(request.url).pathname.match(/^\/api\/apps\/([^/]+)\/ws$/)
			if (appRoute)
				return this.requireApps().acceptWebSocket(
					appRoute[1],
					request.headers.get('Sec-WebSocket-Protocol')
				)

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
			readFrontmatter(this.vol, PROFILE_PATH),
			readFrontmatter(this.vol, SOUL_PATH)
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
