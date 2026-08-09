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
	type Models
} from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all'
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter'
import { openrouterImagesProvider } from '@earendil-works/pi-ai/providers/openrouter-images'
import {
	type AgentBackend,
	type AgentSession,
	createAgentSession,
	generateSoul as generateAgentSoul,
	type LLMText,
	modelsBackend,
	parseFrontmatter,
	resolveTimezone,
	type SoulGenerationInput,
	text
} from '@justfiles/agent'
import { IDENTITY_PATHS, PROFILE_PATH, readAgentName } from '@justfiles/agent/defaults'
import { EXPRESSIONS } from '@justfiles/agent/expression'
import { capabilityRegistry } from '@justfiles/app/capabilities'
import {
	accountsCapabilities,
	aesGcmSecretCodec,
	ensureAccount,
	resolveAiAccount,
	type SecretCodec,
	sealAccounts
} from '@justfiles/app/capabilities/accounts/host'
import { type GeneratedImage, imageAgentTools } from '@justfiles/app/capabilities/image'
import type { Notification } from '@justfiles/app/capabilities/notify'
import type { UsageSnapshot } from '@justfiles/app/capabilities/settings'
import { settingsHost } from '@justfiles/app/capabilities/settings/host'
import {
	clearReset,
	createFsApi,
	type DbAdapter,
	type GenerationState,
	type ResetBody,
	type ResetResult,
	readGenerationState,
	resetVolume
} from '@justfiles/core'
import type { Volume } from '@justfiles/fs'
import { Hono } from 'hono'
import { guardCapability } from './accounts/guard.ts'
import { buildProviders } from './accounts/providers.ts'
import { createAiGateway } from './ai-gateway.ts'
import { scheduleDailyAlarm } from './daily-alarm.ts'
import { runDailyMaintenance } from './daily-maintenance.ts'
import { cfFsStorage, createDOSqliteAdapter, migrateCF } from './db.do.ts'
import { generateFace } from './faces.ts'
import { type FrierenApps, frierenApps } from './frieren.app.ts'
import { createServerPoke } from './frieren.poke.ts'
import { AuditLog } from './integrations/audit.ts'
import { TokenBucket } from './integrations/rate-limit.ts'
import { type AiMeter, createAiMeter, evaluate, readTier } from './quota.ts'
import { createVolumeScopeOwner, type VolumeScope, type VolumeScopeOwner } from './volume-scope.ts'

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
	// Server->client volume poke: "the server volume changed, pull now" — delivered
	// to the always-on session sockets (not the lazy `_caps` capability socket).
	| { type: 'sync' }

const DEBUG_COMMAND = '/debug'

// The platform's image engine, picked from pi's OpenRouter images catalog. Fixed for now —
// a Settings picker (its own selection, separate from the text model) comes with
// the active-image work (#194).
const IMAGE_MODEL = 'google/gemini-3.1-flash-image'

// Local dev runs on the developer's own OpenRouter key, so the platform AI cap — a
// shared-key protection — is lifted by resolving the tier as `unlimited`. `import.meta.env.DEV`
// is statically `true` under `vite` (dev) and `false` under `vite build` (the deploy path),
// so production is always metered. `undefined` in prod ⇒ the tier resolves from stored state.
const DEV_TIER_OVERRIDE = import.meta.env.DEV ? 'unlimited' : undefined

// Image cost is per-image, not token-based, so a usage-less image result records nothing
// (there's no reliable amount to charge); a result that reports usage is recorded normally.

export class Frieren extends DurableObject<Env> {
	private readonly app: Hono
	private readonly db: DbAdapter
	private readonly fs: ReturnType<typeof cfFsStorage>
	private scopes?: VolumeScopeOwner<AgentSession, FrierenApps>
	// The image engine is env-derived and independent of a filesystem scope.
	private generateImage?: (prompt: string, source?: GeneratedImage) => Promise<GeneratedImage[]>
	// In-flight face generations, keyed `${hash}:${expression}` — a second tab (or a repeat
	// of the same expression) joins the running call instead of paying for a second image.
	private readonly facesInFlight = new Map<string, Promise<GeneratedImage | null>>()
	private cfTimezone?: string
	// Seals account creds at rest, keyed by this host's root secret — so the key never lives in
	// the Volume it protects (a DO SQLite dump / R2 object / backup carries only envelopes).
	// Absent locally ⇒ clear, so dev without the secret still runs.
	private readonly secretCodec?: SecretCodec
	// The one admit->run->record seam `meteredBackend` and the `/api/ai` gateway both bill
	// through (quota.ts) — so a platform-key call can never be metered two different ways.
	private readonly meter: AiMeter

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		if (env.ENCRYPTION_KEY) this.secretCodec = aesGcmSecretCodec(env.ENCRYPTION_KEY)
		else console.warn('ENCRYPTION_KEY is not set — account credentials are stored in the clear')
		const namespace = ctx.id.toString()
		const adapter = createDOSqliteAdapter(ctx.storage)
		const fs = cfFsStorage(adapter, namespace, env.FS_BLOBS)
		this.db = adapter
		this.fs = fs
		this.meter = createAiMeter(this.db, ctx.storage, DEV_TIER_OVERRIDE)

		// Proactive server->client sync: any committed write to the server volume
		// (agent turn, cron alarm, or an applied client push) nudges every connected
		// tab to pull now. Coalesced so a burst folds into one poke. Registered per
		// instance — the in-memory listener dies on hibernation and re-arms on wake.
		this.fs.caps?.subscribe?.(
			createServerPoke(() => {
				const payload = JSON.stringify({ type: 'sync' } satisfies ServerMessage)
				for (const ws of this.ctx.getWebSockets()) {
					const attachment = ws.deserializeAttachment() as { caps?: boolean } | null
					// `_caps` speaks Cap'n Web and may not be open; sync pokes use session sockets.
					if (!attachment?.caps) ws.send(payload)
				}
			})
		)

		// The gateway's model + upstream are fixed for this DO's lifetime (env-derived, no
		// network call). Scoped agent resources build their own equivalent AI stack lazily.
		const { model: gatewayModel, apiKey: gatewayApiKey, generateImage } = this.createPlatformAi()
		this.generateImage = generateImage
		this.app = new Hono()
			.post('/api/agent/face', async (c) => {
				const body = await c.req.json<{ avatar?: string; expression?: string; hash?: string }>()
				const expression = EXPRESSIONS.find((name) => name === body?.expression)
				// The avatar is an ID, so it is one path segment and never a way out of the avatars
				// directory. A `builtin/` ref cannot arrive here: its bytes are in the app bundle, so
				// the shell resolves it with no hash and never asks.
				const avatar = body?.avatar
				if (!expression || !body?.hash || !avatar || /[/\\]|^\./.test(avatar)) {
					return c.json({ error: 'avatar, expression and hash are required' }, 400)
				}
				const scope = await this.readyScope()
				const face = await generateFace(
					{
						volume: scope.volume,
						storage: ctx.storage,
						generate: this.generateImage,
						inFlight: this.facesInFlight
					},
					avatar,
					expression,
					body.hash
				)
				// A miss is never an error: the caller keeps showing the base avatar. A face is
				// cosmetic, so "you are out of AI budget" is not worth saying for it.
				return face ? c.json(face) : c.json({ skipped: true })
			})
			// The metered usage + plan caps are NOT an HTTP route: they are served as `host.usage`
			// on the settings capability (see `settingsHost` below), which is the contract the
			// Settings app renders on every host. A second, differently-shaped surface for the same
			// counters is how the two drift.
			// C1 (#297): the metered inference gateway a signed-in daemon (C2) hits directly,
			// same model + same meter the in-process agent backend uses below — one source of
			// truth for what "the platform's AI" means, on the web or on the Mac.
			.route(
				'/api/ai',
				createAiGateway({
					meter: this.meter,
					model: gatewayModel,
					upstream: (body, signal) =>
						fetch(`${gatewayModel.baseUrl}/chat/completions`, {
							method: 'POST',
							headers: {
								'content-type': 'application/json',
								authorization: `Bearer ${gatewayApiKey}`
							},
							body: JSON.stringify(body),
							signal
						}),
					waitUntil: (p) => this.ctx.waitUntil(p)
				})
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
			await migrateCF(this.ctx.storage)
			this.scopes = this.createScopes(await readGenerationState(this.db))
		})
	}

	// The lineage-mutation capability behind POST /fs/reset (createFsApi validates
	// the body and owns the HTTP envelope; this is the DO-level body it calls).
	// `adopt-mine`/`wipe` — CAS + truncate + bump. `complete` — advisory: the
	// initiator's republish drained, so clear the in-progress flag.
	private async handleReset(req: ResetBody): Promise<ResetResult> {
		return this.requireScopes().reset(req)
	}

	private requireScopes(): VolumeScopeOwner<AgentSession, FrierenApps> {
		if (!this.scopes) throw new Error('volume scopes not initialised')
		return this.scopes
	}

	private readyScope(): Promise<VolumeScope<AgentSession, FrierenApps>> {
		return this.requireScopes().ready()
	}

	// The platform backend, cap-gated + metered through `this.meter` (quota.ts) — the same seam
	// the `/api/ai` gateway bills through, so the two can't diverge. Every text call (agent
	// turns, soul gen, the app `ai` capability) goes through here. Only the platform backend is
	// wrapped — BYO backends are built plain, so they're never metered or capped.
	private meteredBackend(models: Models, model: Model<Api>): AgentBackend {
		const backend = modelsBackend(models, model)
		return {
			...backend,
			streamFn: async (m, context, options) => {
				const handle = await this.meter.admitOrThrow()
				const stream = await Promise.resolve(backend.streamFn(m, context, options))
				// The terminal AssistantMessage (done OR error) carries usage — record on it. A stream
				// that errors without one carries no usage, so there's nothing to record.
				stream
					.result()
					.then((msg) => this.ctx.waitUntil(this.meter.record(handle, msg.usage)))
					.catch(() => undefined)
				return stream
			},
			completeFn: async (m, context, options) => {
				const handle = await this.meter.admitOrThrow()
				const message = await backend.completeFn(m, context, options)
				this.ctx.waitUntil(this.meter.record(handle, message.usage))
				return message
			}
		}
	}

	// What `host.usage` reads: the per-user meter + quota, projected into the
	// host-agnostic snapshot the Settings app renders.
	private async usageSnapshot(): Promise<UsageSnapshot> {
		const report = await this.meter.readUsage(this.ctx.storage.sql.databaseSize)
		const q = evaluate(report, await readTier(this.ctx.storage, DEV_TIER_OVERRIDE))
		return {
			tier: q.tier,
			aiBurst: q.aiBurst,
			aiWeekly: q.aiWeekly,
			storage: q.storage,
			aiTokens: report.ai.totalTokens,
			aiRequests: report.ai.requests
		}
	}

	private async generateSoul(input: SoulGenerationInput): ReturnType<typeof generateAgentSoul> {
		const { models, model } = this.createPlatformAi()
		return generateAgentSoul(this.meteredBackend(models, model), input, { firstWords: true })
	}

	private createScopes(state: GenerationState): VolumeScopeOwner<AgentSession, FrierenApps> {
		type Scope = VolumeScope<AgentSession, FrierenApps>
		type ScopedAi = ReturnType<Frieren['createPlatformAi']> & { text: LLMText }
		const scopedAi = new WeakMap<Scope, ScopedAi>()
		const scopedImage = new WeakMap<Scope, ReturnType<typeof accountsCapabilities>['image']>()
		const stopSession = new WeakMap<AgentSession, () => void>()
		const getAi = (scope: Scope): ScopedAi => {
			let scoped = scopedAi.get(scope)
			if (!scoped) {
				const ai = this.createPlatformAi()
				scoped = { ...ai, text: text(this.meteredBackend(ai.models, ai.model)) }
				scopedAi.set(scope, scoped)
			}
			return scoped
		}

		return createVolumeScopeOwner({
			storage: this.fs,
			state,
			reset: {
				read: () => readGenerationState(this.db),
				apply: (request) => resetVolume(this.db, request),
				clear: (resetId) => clearReset(this.db, resetId)
			},
			factories: {
				ready: async (scope) => {
					await ensureAccount(
						scope.volume,
						{ accountId: 'frieren', providerId: 'frieren', enabled: ['ai'] },
						{ secretCodec: this.secretCodec }
					)
					await sealAccounts(scope.volume, { secretCodec: this.secretCodec })
				},
				apps: (scope) => {
					const { text, generateImage } = getAi(scope)
					const providers = buildProviders({ text, generateImage })
					const caps = accountsCapabilities(providers, scope.volume, {
						secretCodec: this.secretCodec,
						origin: { kind: 'cloud' }
					})
					scopedImage.set(scope, caps.image)
					const audit = new AuditLog(this.ctx.storage)
					const rateLimit = new TokenBucket({ capacity: 60, windowMs: 60_000 })
					const email = guardCapability(caps.email, { capability: 'email', audit, rateLimit })
					const calendar = guardCapability(caps.calendar, {
						capability: 'calendar',
						audit,
						rateLimit
					})
					return frierenApps({
						fs: scope.volume,
						loader: this.env.LOADER,
						acceptWebSocket: (ws) => this.ctx.acceptWebSocket(ws),
						text,
						broadcast: (msg) => this.broadcast(msg),
						image: caps.image,
						email,
						calendar,
						settings: settingsHost({
							accounts: caps.accounts,
							usage: () => this.usageSnapshot(),
							agent: {
								volume: scope.volume,
								paths: IDENTITY_PATHS,
								timezone: () => resolveTimezone(scope.volume, this.cfTimezone),
								generateSoul: async ({ name, gender, archetype, userAge, userGender }) => {
									return this.generateSoul({
										agentName: name,
										agentGender: gender,
										archetype: archetype as SoulGenerationInput['archetype'],
										userAge,
										userGender
									})
								}
							}
						})
					})
				},
				session: (scope, resetInProgress) => {
					const { models, model, generateImage } = getAi(scope)
					const apps = scope.apps()
					const image = scopedImage.get(scope)
					if (generateImage && !image) throw new Error('scoped image capability not initialised')
					const agentCaps =
						generateImage && image
							? {
									invoke: capabilityRegistry({ image }).invoke,
									tools: [imageAgentTools]
								}
							: undefined
					const session = createAgentSession({
						volume: scope.volume,
						identitySeedingSuppressed: resetInProgress,
						capabilities: agentCaps,
						backend: async () => {
							const backend = await resolveAiAccount(
								scope.volume,
								({ providerId }) =>
									providerId === 'frieren' ? this.meteredBackend(models, model) : null,
								{ secretCodec: this.secretCodec }
							)
							if (!backend) throw new Error('AI is turned off — enable an AI provider in Settings.')
							return backend
						},
						apps: apps.controller,
						osState: async () => ({ windows: await apps.windows() }),
						timezone: () => resolveTimezone(scope.volume, this.cfTimezone),
						notify: (notification) => this.broadcast({ type: 'notification', notification }),
						expressions: true
					})
					stopSession.set(
						session,
						session.subscribe((event) => {
							if (event.type === 'error') this.broadcast({ type: 'error', message: event.message })
						})
					)
					return session
				},
				disposeSession: (session) => {
					stopSession.get(session)?.()
					session.abort()
				},
				disposeApps: (apps) => apps.dispose()
			}
		})
	}

	// The platform AI stack: a pi `Models` + selected model, plus (production only)
	// an image-generation fn over pi's parallel `ImagesModels` stack — same OpenRouter
	// key, its own model. Local dev (LM Studio) has no image engine, so `generateImage`
	// is absent and the platform backs no image capability there. The api key is supplied
	// through a small CredentialStore (a stored key wins over ambient env), so the
	// token never rides on the backend — `modelsBackend` seals it inside `Models`.
	private createPlatformAi(): {
		models: Models
		model: Model<Api>
		// The gateway's own upstream key — kept alongside `model` so both routes forward to
		// whichever backend this call picked (LM Studio locally, OpenRouter in prod), never a
		// second hard-coded choice that could drift from the agent's own backend.
		apiKey: string
		generateImage?: (prompt: string, source?: GeneratedImage) => Promise<GeneratedImage[]>
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
			return { models, model: model as Model<Api>, apiKey: 'lm-studio' }
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
			apiKey,
			generateImage: imageModel
				? async (prompt, source) => {
						// Image generation runs on the parallel ImagesModels stack (not the text backend),
						// so admit/record explicitly. Record the reported usage even on a non-'stop' result
						// (a failed image can still be billable); a usage-less result records nothing.
						const handle = await this.meter.admitOrThrow()
						const res = await images.generateImages(imageModel, {
							// A `source` makes this an EDIT (the model is image-in/image-out): the avatar
							// plus "change only the expression" is how a face set is derived.
							input: source
								? [
										{ type: 'text', text: prompt },
										{ type: 'image', data: source.data, mimeType: source.mimeType }
									]
								: [{ type: 'text', text: prompt }]
						})
						if (res.usage) this.ctx.waitUntil(this.meter.record(handle, res.usage))
						if (res.stopReason !== 'stop')
							throw new Error(res.errorMessage ?? 'image generation failed')
						return res.output.flatMap((b) =>
							b.type === 'image' ? [{ data: b.data, mimeType: b.mimeType }] : []
						)
					}
				: undefined
		}
	}

	// ── WebSocket handlers ────────────────────────────────────────────────

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		const scope = await this.readyScope()
		// The shared capability-proxy socket carries {caps:true}; agent sockets
		// carry neither.
		const attachment = ws.deserializeAttachment() as { caps?: boolean } | null
		if (attachment?.caps) {
			await scope.apps().handleMessage(ws, undefined, message)
			return
		}

		await scheduleDailyAlarm(this.ctx, scope.session())
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
			scope.session().abort()
			return
		}

		if (parsed.type === 'app_open' && parsed.id) {
			await scope.apps().open(parsed.id)
			return
		}

		if (parsed.type === 'app_close') {
			await scope.apps().close(parsed.id)
			return
		}

		if (parsed.type === 'prompt' && parsed.text) {
			const trimmed = parsed.text.trim()
			if (trimmed === DEBUG_COMMAND) {
				ws.send(
					JSON.stringify({
						type: 'debug',
						message: await scope.session().systemPrompt()
					} satisfies ServerMessage)
				)
				return
			}

			// Stream the raw turn events (live token/tool deltas) to this socket. The session's
			// turn runner catches + classifies failures (surfaced via the `error` subscription
			// wired in reset), so this never rejects.
			await scope
				.session()
				.prompt(parsed.text, 'user', (event) =>
					ws.send(JSON.stringify({ type: 'event', event } satisfies ServerMessage))
				)
		}
	}

	private broadcast(message: ServerMessage): void {
		const payload = JSON.stringify(message)
		for (const client of this.ctx.getWebSockets()) client.send(payload)
	}

	// NO `webSocketClose`. Our compatibility date (2026-04-10) enables
	// `web_socket_auto_reply_to_close`, so the runtime sends the reciprocal Close frame
	// and marks the socket CLOSED *before* a handler would run — reciprocating is dead
	// code. It is also unsafe to reciprocate with the PEER's code: 1005 ("no status
	// received") and 1006 ("abnormal closure") are reserved, describing how a socket
	// died rather than anything that may be sent on the wire, so `close()` rejects them.
	// Echoing one back threw `Invalid WebSocket close code` on every abrupt disconnect —
	// a closed laptop, dropped wifi, a killed tab — which is ~99% of this Worker's error
	// volume in production (348 in one week). Handling a close needs a handler; merely
	// completing one does not.

	async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
		ws.close(1011, 'WebSocket error')
	}

	// Do not reschedule here — only WebSocket interactions set the next alarm,
	// so a silent day naturally stops the daily routine.
	async alarm(): Promise<void> {
		const scope = await this.readyScope()
		// The DO owns the synced fs, so daily trash retention and content collection
		// run without an open tab. Both are best-effort and retry on the next alarm.
		await runDailyMaintenance(this.fs, scope.volume)
		await scope.session().runMaintenance()
	}

	async fetch(request: Request): Promise<Response> {
		this.cfTimezone = (request.cf as { timezone?: string } | undefined)?.timezone

		// Handle WebSocket upgrade
		const upgradeHeader = request.headers.get('Upgrade')
		if (upgradeHeader === 'websocket') {
			const scope = await this.readyScope()
			const appRoute = new URL(request.url).pathname.match(/^\/api\/apps\/([^/]+)\/ws$/)
			if (appRoute)
				return scope
					.apps()
					.acceptWebSocket(appRoute[1], request.headers.get('Sec-WebSocket-Protocol'))

			// Agent is long-lived — transformContext re-reads soul.md every turn,
			// so there is no need to recreate the agent on reconnect.
			const pair = new WebSocketPair()
			const [client, server] = Object.values(pair)

			this.ctx.acceptWebSocket(server)
			await scheduleDailyAlarm(this.ctx, scope.session())

			const participants = await this.loadParticipants(scope.volume)
			const history = sessionEntries2DisplayMessages(await scope.session().history())
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
					apps: await scope.apps().list()
				} satisfies ServerMessage)
			)

			return new Response(null, {
				status: 101,
				webSocket: client
			})
		}

		return this.app.fetch(request)
	}

	private async loadParticipants(volume: Volume): Promise<DisplayParticipants> {
		const [profile, agentName] = await Promise.all([
			readFrontmatter(volume, PROFILE_PATH),
			readAgentName(volume)
		])

		return {
			userName: profile.name || 'You',
			agentName
		}
	}
}

async function readFrontmatter(vol: Volume, path: string): Promise<Record<string, string>> {
	if (!(await vol.exists(path))) return {}
	return parseFrontmatter(new TextDecoder().decode(await vol.readFile(path)))
}
