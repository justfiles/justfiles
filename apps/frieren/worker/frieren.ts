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
	type LLMText,
	modelsBackend,
	parseFrontmatter,
	resolveTimezone,
	SOUL_GENERATION_PROMPT,
	type SoulGenerationInput,
	text
} from '@justfiles/agent'
import { ensureAgentDefaults, PROFILE_PATH, SOUL_PATH } from '@justfiles/agent/defaults'
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
	type ResetBody,
	type ResetResult,
	readGenerationState,
	resetVolume
} from '@justfiles/core'
import { type Volume, volume } from '@justfiles/fs'
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
import { ensureUsageSchema, readUsage } from './usage.ts'

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
	private vol: Volume
	private session?: AgentSession
	private text?: LLMText
	// The image engine, kept from the last `reset()` so the face endpoint can reach it.
	private generateImage?: (prompt: string, source?: GeneratedImage) => Promise<GeneratedImage[]>
	// In-flight face generations, keyed `${hash}:${expression}` — a second tab (or a repeat
	// of the same expression) joins the running call instead of paying for a second image.
	private readonly facesInFlight = new Map<string, Promise<GeneratedImage | null>>()
	private cfTimezone?: string
	private apps?: FrierenApps
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
		this.vol = volume(fs)
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
		// network call), so one `aiRuntime()` call here is enough to wire the route; `reset()`
		// below calls it again for the agent's own backend — cheap and unchanged.
		const { model: gatewayModel, apiKey: gatewayApiKey } = this.aiRuntime()
		this.app = new Hono()
			.post('/api/agent/soul', async (c) => {
				const body = await c.req.json<SoulGenerationInput>()
				if (!body?.agentName || !body?.archetype) {
					return c.json({ error: 'agentName and archetype are required' }, 400)
				}
				const generated = await this.generateSoul(body)
				return c.json(generated)
			})
			.post('/api/agent/face', async (c) => {
				const body = await c.req.json<{ expression?: string; hash?: string }>()
				const expression = EXPRESSIONS.find((name) => name === body?.expression)
				if (!expression || !body?.hash) {
					return c.json({ error: 'expression and hash are required' }, 400)
				}
				const face = await generateFace(
					{
						volume: this.vol,
						storage: ctx.storage,
						generate: this.generateImage,
						inFlight: this.facesInFlight
					},
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
			resetId: req.resetId,
			// adopt-mine carries the client's expected lineage so the CAS also fences identity
			// (a stale endpoint swap can't truncate a different volume at the same generation).
			lineageId: req.mode === 'adopt-mine' ? req.lineageId : undefined
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
		const report = await readUsage(this.db, this.ctx.storage.sql.databaseSize)
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
		this.generateImage = generateImage
		await migrateCF(this.ctx.storage)
		await ensureUsageSchema(this.db)
		// Seed a default soul + empty profile so the agent works with no onboarding.
		// Idempotent — a personalized soul (synced from the client) is left untouched.
		await ensureAgentDefaults(this.vol)
		// The built-in AI account: the platform-provided, always-on default backend. Seeded with
		// `ai` enabled, and re-claimed as the active AI whenever the selection names an account
		// this host doesn't have (a retired id, or one connected on another host — the credential
		// lane is host-only), so a signed-in user is never left with no backend. A returning
		// user's real choice — another AI account, or AI switched off — is left untouched.
		await ensureAccount(
			this.vol,
			{
				accountId: 'frieren',
				providerId: 'frieren',
				enabled: ['ai']
			},
			{ secretCodec: this.secretCodec }
		)
		// Anything still in the clear (written before the key existed, or while it was missing)
		// gets sealed now — nothing else would ever rewrite a credential that doesn't rotate.
		await sealAccounts(this.vol, { secretCodec: this.secretCodec })
		this.session?.abort()
		this.text = text(this.meteredBackend(models, model))
		// Accounts live on the Volume; the factory hands back the capabilities. frieren keeps
		// its own env-keyed `ai` (agent backend + soul generation), so the factory's `ai` is
		// ignored. email/calendar are guarded (audit + rate-limit) and wired into the APPS —
		// the agent no longer reaches them directly (that returns as capability-provided agent
		// tools; see the plan's Step 3.5).
		const providers = buildProviders({ text: this.text, generateImage })
		const caps = accountsCapabilities(providers, this.vol, { secretCodec: this.secretCodec })
		const audit = new AuditLog(this.ctx.storage)
		const rateLimit = new TokenBucket({ capacity: 60, windowMs: 60_000 })
		const email = guardCapability(caps.email, { capability: 'email', audit, rateLimit })
		const calendar = guardCapability(caps.calendar, { capability: 'calendar', audit, rateLimit })
		this.apps = frierenApps({
			fs: this.vol,
			loader: this.env.LOADER,
			acceptWebSocket: (ws) => this.ctx.acceptWebSocket(ws),
			text: this.text,
			broadcast: (msg) => this.broadcast(msg),
			image: caps.image,
			email,
			calendar,
			// The host admin surface Settings talks to. Both halves are served here: the
			// browser half delegates `accounts.*` (credentials never replicate) and
			// `host.usage` (the meter lives with the DO) to this one.
			settings: settingsHost({
				accounts: caps.accounts,
				usage: () => this.usageSnapshot()
			})
		})
		// The agent's LLM backend resolves from the enabled `ai` account (single-active):
		// the built-in AI → the platform env backend; nothing enabled → no backend, so a turn
		// fails with a clear "turn on AI in Settings" the chat surfaces. Re-resolved per
		// turn, so toggling AI in Settings takes effect on the next prompt.
		const agentName = (await readFrontmatter(this.vol, SOUL_PATH)).agent_name || 'Kodama'
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
				const backend = await resolveAiAccount(
					this.vol,
					({ providerId }) =>
						providerId === 'frieren' ? this.meteredBackend(models, model) : null,
					{ secretCodec: this.secretCodec }
				)
				if (!backend) throw new Error('AI is turned off — enable an AI provider in Settings.')
				return backend
			},
			apps: this.requireApps().controller,
			osState: async () => ({ windows: await this.requireApps().windows() }),
			timezone: this.getTimezone,
			// The frieren delivery channel: broadcast the agent's ping to every tab's
			// omnibar (mirrors `broadcast`). Producer code is untouched — passing a
			// channel is all it takes to light up notifications.
			notify: (notification) => this.broadcast({ type: 'notification', notification }),
			// The avatar's expression channel: the agent tags each sentence, the client strips the
			// tags off the token stream and swaps the face (see @justfiles/agent/expression).
			expressions: true,
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
	// is absent and the platform backs no image capability there. The api key is supplied
	// through a small CredentialStore (a stored key wins over ambient env), so the
	// token never rides on the backend — `modelsBackend` seals it inside `Models`.
	private aiRuntime(): {
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
		// The DO owns the synced fs, so daily trash retention and content collection
		// run without an open tab. Both are best-effort and retry on the next alarm.
		await runDailyMaintenance(this.fs, this.vol)
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
			agentName: soul.agent_name || 'Kodama'
		}
	}
}

async function readFrontmatter(vol: Volume, path: string): Promise<Record<string, string>> {
	if (!(await vol.exists(path))) return {}
	return parseFrontmatter(new TextDecoder().decode(await vol.readFile(path)))
}
