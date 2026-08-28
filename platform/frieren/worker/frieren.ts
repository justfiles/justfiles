import { DurableObject } from 'cloudflare:workers'
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
	type AgentSessionOptions,
	type AgentSessions,
	createAgentSessions,
	generateSoul as generateAgentSoul,
	type LLMText,
	modelsBackend,
	parseFrontmatter,
	resolveTimezone,
	type SoulGenerationInput,
	text
} from '@justfiles/agent'
import {
	IDENTITY_DEFAULTS,
	IDENTITY_PATHS,
	readAgentName,
	readProfile
} from '@justfiles/agent/defaults'
import { EXPRESSIONS } from '@justfiles/agent/expression'
import {
	promptReply,
	type SessionClientMessage,
	type SessionServerMessage,
	sessionEntriesToTranscriptItems,
	snapshotMessage,
	updateMessages
} from '@justfiles/agent/protocol'
import { capabilityRegistry } from '@justfiles/app/capabilities'
import {
	aesGcmSecretCodec,
	type HostAccounts,
	hostAccounts,
	type SecretCodec
} from '@justfiles/app/capabilities/accounts/host'
import { type GeneratedImage, imageAgentTools } from '@justfiles/app/capabilities/image'
import type { Notification } from '@justfiles/app/capabilities/notify'
import type { UsageSnapshot } from '@justfiles/app/capabilities/settings'
import { settingsHost } from '@justfiles/app/capabilities/settings/host'
import {
	clearReset,
	createDoAdapter,
	createDoSyncDb,
	createFsApi,
	type DbAdapter,
	type DestructiveResetBody,
	fileApi,
	migrateSqlite,
	migrateSync,
	type ResetResult,
	type ResetStatus,
	readGenerationState,
	readResetStatus,
	resetStore,
	type SyncDb,
	scopedBlobs,
	sqliteStore,
	storeApi
} from '@justfiles/core'
import { coreMigrations } from '@justfiles/core/migrations'
import { announceMount, type Volume, volume } from '@justfiles/fs'
import { authority } from '@justfiles/fs/authority'
import { ROOT, type Store } from '@justfiles/fs/store'
import { Hono } from 'hono'
import { PRIVATE_MOUNT } from '../shared/private.ts'
import { guardCapability } from './accounts/guard.ts'
import { buildProviders } from './accounts/providers.ts'
import { createAiGateway } from './ai-gateway.ts'
import { scheduleDailyAlarm } from './daily-alarm.ts'
import { runDailyMaintenance } from './daily-maintenance.ts'
import { generateFace } from './faces.ts'
import { type FrierenApps, frierenApps } from './frieren.app.ts'
import { createServerPoke, notifying } from './frieren.poke.ts'
import { AuditLog } from './integrations/audit.ts'
import { TokenBucket } from './integrations/rate-limit.ts'
import { type AiMeter, createAiMeter, evaluate, readTier } from './quota.ts'
import { commitReset } from './reset-instance.ts'

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

type ControlClientMessage = { type: 'app_open'; id: string } | { type: 'app_close'; id?: string }

interface DisplayParticipants {
	readonly userName: string
	readonly agentName: string
}

type AgentServerMessage =
	| SessionServerMessage
	| { type: 'debug'; message: string }
	| { type: 'error'; message: string }

type ControlServerMessage =
	| {
			type: 'ready'
			participants?: DisplayParticipants
			apps?: Awaited<ReturnType<FrierenApps['list']>>
	  }
	| { type: 'error'; message: string }
	| { type: 'app_open'; id: string }
	| { type: 'app_close'; id: string }
	// The frieren notification channel: the agent's turn pings / classified errors /
	// questions, broadcast to every open tab (the browser projects them onto the
	// omnibar pill + center). Producer code is shared; only this delivery is frieren's.
	| { type: 'notification'; notification: Notification }
	// Server->client volume poke: "the server volume changed, pull now".
	| { type: 'sync' }

type SocketAttachment = { caps: true } | { type: 'control' } | { type: 'agent'; agentId?: string }

const CONTROL_SOCKET_TAG = 'control'
const agentSocketTag = (agentId?: string): string => `agent:${agentId ?? 'main'}`

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

/**
 * Where the one-time pass from the old tables to the store model is recorded.
 *
 * Durable and outside SQLite on purpose: the pass is idempotent and resumable, so a
 * crash before this lands costs a re-read and nothing else — but a pass that ran AGAIN
 * after clients started writing would copy stale rows over live ones, since rule 3 only
 * makes an IDENTICAL row a no-op. Everything between the migration and this marker runs
 * inside `blockConcurrencyWhile`, so no request can be served in that window.
 */
const ADOPTED_KEY = 'store:adopted'

export class Frieren extends DurableObject<Env> {
	private readonly app: Hono
	private readonly db: DbAdapter
	// The same database, synchronously: what an atomic transaction needs.
	private readonly sync: SyncDb
	// The synced tree, raw — the store the migration writes into and the mount row is
	// announced in. Every SERVED path goes through `tree` instead, which is this behind
	// the authority: rule 9's invariants, one commit at a time, and the poke.
	private readonly store: Store
	private readonly tree: Store
	// The DO's own local store, joined at `/private`. It is not `storeApi`'s, so no
	// request can name a row in it — the credentials and the sealed provider records are
	// simply not in the table a client pulls.
	private readonly local: Store
	// THE filesystem of this instance. A destructive reset commits and then terminates the
	// Durable Object (reset-instance.ts), so an instance never spans two generations and
	// nothing ever swaps this out — which is why it needs no fence, no lifetime, and no
	// readiness gate. The next instance builds its own over the same durable storage.
	private readonly volume: Volume
	// The platform AI stack — env-derived, no network call, so it is built once for the
	// instance and shared by the `/api/ai` gateway, the app `ai` capability, and the agent.
	private readonly models: Models
	private readonly model: Model<Api>
	private readonly platformText: LLMText
	private readonly generateImage?: (
		prompt: string,
		source?: GeneratedImage
	) => Promise<GeneratedImage[]>
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
	// Filesystem-derived resources, built on first use and kept for the instance's lifetime.
	private accounts?: HostAccounts
	private apps?: FrierenApps
	private readonly agents: AgentSessions
	private readonly agentSubscriptions = new Map<string, () => void>()
	private readonly agentMessages = new Map<string, Promise<void>>()

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		if (env.ENCRYPTION_KEY) this.secretCodec = aesGcmSecretCodec(env.ENCRYPTION_KEY)
		else console.warn('ENCRYPTION_KEY is not set — account credentials are stored in the clear')
		const namespace = ctx.id.toString()
		// The async seam, for the two readers that are not the store: the generation row,
		// and the one pass that reads the old tables.
		const adapter = createDoAdapter(ctx.storage)
		this.db = adapter
		this.sync = createDoSyncDb(ctx.storage)

		// Proactive server->client sync: any committed write to the server volume
		// (agent turn, cron alarm, or an applied client push) nudges every connected
		// tab to pull now. Coalesced so a burst folds into one poke. Registered per
		// instance — the in-memory listener dies on hibernation and re-arms on wake.
		const poke = createServerPoke(() => {
			this.broadcastControl({ type: 'sync' })
		})

		// TWO stores over the one database, and the whole of what keeps `/private` off
		// the wire. `storeApi` below is handed the synced one alone, so no request can
		// name a row in the other; the mount row announced at `(ROOT, 'private')` (see
		// `adoptStore`) then reserves that name on every replica, and `holdsRows` makes a
		// subtree under it unspellable in the synced store on any client, buggy or not.
		// Bytes too big for a row go to R2, because a Workers SQLite ROW is capped at
		// 2 MB — hard — so a store that inlined everything could not hold a file bigger
		// than that at all. The old backend sent every binary there for the same reason.
		// Absent locally (no bucket bound), so dev runs on rows alone.
		const blobs = env.FS_BLOBS && scopedBlobs(env.FS_BLOBS, namespace)
		this.store = sqliteStore(this.sync, undefined, { blobs })
		this.local = notifying(sqliteStore(this.sync, PRIVATE_MOUNT, { blobs }))
		this.tree = notifying(authority(this.store))
		this.tree.subscribe?.(poke)
		// Constructing a Volume touches no storage; the migration barrier below still runs
		// before any request can call a method on it.
		this.volume = volume(this.tree, {
			bindings: new Map([[ROOT, new Map([[PRIVATE_MOUNT, this.local]])]])
		})
		this.meter = createAiMeter(this.db, ctx.storage, DEV_TIER_OVERRIDE)

		const { models, model, apiKey, generateImage } = this.createPlatformAi()
		this.models = models
		this.model = model
		this.generateImage = generateImage
		this.platformText = text(this.meteredBackend(models, model))
		this.agents = createAgentSessions(() => this.agentOptions())
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
				const face = await generateFace(
					{
						volume: this.volume,
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
					model,
					upstream: (body, signal) =>
						fetch(`${model.baseUrl}/chat/completions`, {
							method: 'POST',
							headers: {
								'content-type': 'application/json',
								authorization: `Bearer ${apiKey}`
							},
							body: JSON.stringify(body),
							signal
						}),
					waitUntil: (p) => this.ctx.waitUntil(p)
				})
			)
			// The seam, as routes, over the synced store alone.
			.route('/store', storeApi(this.tree))
			// The one route beside it, for the callers that are not replicas: a CLI
			// reading one file, for which the seam is a walk and a fetch. Over the synced
			// tree UNBOUND — not `this.volume` — for the same reason `storeApi` is handed
			// the synced store alone: a request may not name anything behind the mount,
			// and an unbound one reads as the empty directory it is.
			.route('/store', fileApi(volume(this.tree)))
			// What is left of `/fs`: the server's own protocol, which the seam does not
			// carry. The lineage epoch both the factory reset and `synced`'s
			// `reset()` closure READ from here, and the reset itself.
			.route(
				'/fs',
				createFsApi({
					lineage: () => readGenerationState(this.db),
					// Only the non-destructive marker clear — the destructive half is not
					// injectable, by design. A destructive reset is a commit-then-restart
					// handshake the authenticated Worker drives from OUTSIDE (reset-ack.ts),
					// and it intercepts POST /fs/reset ahead of this route — committing here
					// instead would leave THIS instance running at a generation it no longer
					// owns.
					complete: (resetId: string) => this.completeReset(resetId)
				})
			)

		// The DO's one initialization seam: no request runs until the schema exists and
		// the tree has been adopted, so nothing else needs a readiness gate.
		ctx.blockConcurrencyWhile(async () => {
			// Synchronous, so each migration's statements and its `schema_migrations` record
			// commit together — an interrupted one that half-applied would brick every later
			// one (a re-run `ALTER TABLE ADD COLUMN` failing as a duplicate).
			migrateSync(this.sync, coreMigrations)
			await this.adoptStore()
		})
	}

	/**
	 * The store model's tree, brought up before anything can be served over it: the
	 * mount point claimed, and — once — the old tables copied across.
	 *
	 * `announceMount` runs on EVERY boot rather than only after the copy. It is
	 * idempotent and costs one lookup when the row is already there, and it is the
	 * claim that makes `/private` uncollidable: a store whose row went missing (an
	 * older build, a hand-edited database) has to be able to claim it again.
	 *
	 * The copy goes into the RAW stores, past the authority. Nothing else is running —
	 * this is inside `blockConcurrencyWhile` — the rows come out of this same database
	 * rather than off a wire, and the pass writes every parent before its children, so
	 * rule 9 holds by construction. Through the authority it would instead re-hash every
	 * blob in the volume at boot, which is the one thing a boot barrier cannot afford.
	 */
	private async adoptStore(): Promise<void> {
		await announceMount(this.tree, ROOT, PRIVATE_MOUNT)
		if (await this.ctx.storage.get(ADOPTED_KEY)) return
		// `/private` is a root-level name in the old tree, and its subtree lands in the
		// local store hanging off that store's own root: what was `/private/accounts.json`
		// is `/accounts.json` there. Nothing of it is ever written into the synced store,
		// so no page, no tombstone and no blob request can name one.
		await migrateSqlite(this.db, this.store, {
			blobs: this.env.FS_BLOBS,
			mounts: new Map([[PRIVATE_MOUNT, this.local]])
		})
		await this.ctx.storage.put(ADOPTED_KEY, true)
	}

	// Commit a destructive reset and take this instance down with it. A successful commit
	// never answers — the abort destroys the isolate mid-call — so the caller proves what
	// happened by asking a fresh instance (reset-ack.ts). Only a decision this instance
	// survives to report, a stale CAS or an idempotent replay, comes back as a value.
	public async resetAndRestart(request: DestructiveResetBody): Promise<ResetResult> {
		return this.ctx.blockConcurrencyWhile(() =>
			commitReset(request, {
				// A wipe means "delete everything", so it names the bound store too; an
				// adopt-mine names only the synced tree, and the credentials survive by
				// never having been in it.
				reset: async (body) => resetStore(this.sync, body, { local: [PRIVATE_MOUNT] }),
				sync: () => this.ctx.storage.sync(),
				terminate: (reason) => {
					this.ctx.abort(reason)
					// Belt and braces: if `abort()` ever returns, throwing out of
					// `blockConcurrencyWhile` terminates and resets the object anyway, so the
					// instance cannot survive its own reset either way.
					throw new Error('DurableObjectState.abort() returned')
				}
			})
		)
	}

	// Did `operationId` commit? Asked of whatever instance exists now, which is how a caller
	// turns the disconnect it saw into an answer.
	public async resetStatus(operationId: string): Promise<ResetStatus> {
		return readResetStatus(this.db, operationId)
	}

	// Non-destructive: it only drops the advisory marker once the adopt-mine republish
	// drained, so the instance and everything it owns keep running.
	public async completeReset(resetId: string): Promise<ResetResult> {
		const state = await clearReset(this.db, resetId)
		return { ok: true, generation: state.generation }
	}

	// ── Instance-owned resources ──────────────────────────────────────────
	//
	// Built on first use and kept for the instance's lifetime. Eviction — or the restart a
	// destructive reset forces — throws them away with the instance, and the next instance
	// rebuilds them from the same durable filesystem, so none of them can outlive the
	// generation they were built over.

	// The one account module for this instance. It seeds nothing: the platform AI account
	// and the active-AI selection are derived from the providers below, so an empty
	// `/private` — a fresh sign-up, or the volume a wipe leaves behind — already resolves AI.
	private getAccounts(): HostAccounts {
		if (this.accounts) return this.accounts
		this.accounts = hostAccounts(
			buildProviders({ text: this.platformText, generateImage: this.generateImage }),
			this.volume,
			{
				secretCodec: this.secretCodec,
				origin: { kind: 'cloud' },
				// The credential reseal is the module's one piece of background work, and no
				// caller awaits it — so the request that built this module has to hold it open,
				// or the runtime may end the event before a record nothing else ever rewrites
				// gets sealed.
				waitUntil: (work) => this.ctx.waitUntil(work)
			}
		)
		return this.accounts
	}

	private getApps(): FrierenApps {
		if (this.apps) return this.apps
		const caps = this.getAccounts()
		const audit = new AuditLog(this.ctx.storage)
		const rateLimit = new TokenBucket({ capacity: 60, windowMs: 60_000 })
		this.apps = frierenApps({
			fs: this.volume,
			loader: this.env.LOADER,
			acceptWebSocket: (ws) => this.ctx.acceptWebSocket(ws),
			text: this.platformText,
			broadcast: (msg) => this.broadcastControl(msg),
			image: caps.image,
			email: guardCapability(caps.email, { capability: 'email', audit, rateLimit }),
			calendar: guardCapability(caps.calendar, { capability: 'calendar', audit, rateLimit }),
			settings: settingsHost({
				accounts: caps.admin,
				usage: () => this.usageSnapshot(),
				agent: {
					volume: this.volume,
					paths: IDENTITY_PATHS,
					defaults: IDENTITY_DEFAULTS,
					timezone: () => resolveTimezone(this.volume, this.cfTimezone),
					generateSoul: ({ name, gender, archetype, userAge, userGender }) =>
						this.generateSoul({
							agentName: name,
							agentGender: gender,
							archetype: archetype as SoulGenerationInput['archetype'],
							userAge,
							userGender
						})
				}
			})
		})
		return this.apps
	}

	private getSession(agentId?: string): AgentSession {
		const session = agentId ? this.agents.app(agentId) : this.agents.main()
		const key = agentId ?? ''
		if (!this.agentSubscriptions.has(key))
			this.agentSubscriptions.set(
				key,
				session.subscribe((update) => {
					void this.queueAgentMessage(agentId, () => {
						for (const message of updateMessages(update, projectTranscript))
							this.broadcastAgent(agentId, message)
					})
				})
			)
		return session
	}

	// State reads and pushes must leave in queue order.
	private queueAgentMessage(agentId: string | undefined, send: () => void | Promise<void>) {
		const key = agentId ?? ''
		const result = (this.agentMessages.get(key) ?? Promise.resolve()).then(send)
		this.agentMessages.set(
			key,
			result.catch((error) => console.error('[agent] message failed:', error))
		)
		return result
	}

	private sendAgentSnapshot(ws: WebSocket, agentId?: string): Promise<void> {
		const session = this.getSession(agentId)
		return this.queueAgentMessage(agentId, async () => {
			const snapshot = await session.snapshot()
			ws.send(
				JSON.stringify({
					...snapshotMessage(snapshot, projectTranscript)
				} satisfies AgentServerMessage)
			)
		})
	}

	private agentOptions(): AgentSessionOptions {
		const apps = this.getApps()
		const image = this.getAccounts().image
		// No image engine (local dev) ⇒ no image tools, rather than tools that always fail.
		const capabilities = this.generateImage
			? { invoke: capabilityRegistry({ image }).invoke, tools: [imageAgentTools] }
			: undefined
		return {
			volume: this.volume,
			capabilities,
			backend: async () => {
				const backend = await this.getAccounts().resolveAi(({ providerId }) =>
					providerId === 'frieren' ? this.meteredBackend(this.models, this.model) : null
				)
				if (!backend) throw new Error('AI is turned off — enable an AI provider in Settings.')
				return backend
			},
			apps: apps.controller,
			osState: async () => ({ windows: await apps.windows() }),
			timezone: () => resolveTimezone(this.volume, this.cfTimezone),
			notify: (notification) => this.broadcastControl({ type: 'notification', notification }),
			expressions: true
		}
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
		return generateAgentSoul(this.meteredBackend(this.models, this.model), input, {
			firstWords: true
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
				'OPENROUTER_API_KEY is not set. Add it to platform/frieren/.dev.vars (local) or as a Cloudflare secret (deployed), and declare it in wrangler.jsonc `secrets.required`.'
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
		const attachment = ws.deserializeAttachment() as SocketAttachment | null
		if (attachment && 'caps' in attachment) {
			await this.getApps().handleMessage(ws, undefined, message)
			return
		}
		if (typeof message !== 'string' || !attachment) return
		if (attachment.type === 'agent') {
			await this.handleAgentMessage(ws, attachment.agentId, message)
			return
		}
		if (attachment.type === 'control') await this.handleControlMessage(ws, message)
	}

	private async handleAgentMessage(
		ws: WebSocket,
		agentId: string | undefined,
		message: string
	): Promise<void> {
		let parsed: SessionClientMessage
		try {
			parsed = JSON.parse(message)
		} catch {
			ws.send(
				JSON.stringify({ type: 'error', message: 'Invalid JSON' } satisfies AgentServerMessage)
			)
			return
		}

		const session = this.getSession(agentId)
		const text = parsed.type === 'prompt' ? parsed.text : ''
		const trimmed = text.trim()
		if (parsed.type === 'abort') session.abort()
		const result =
			parsed.type === 'prompt' && trimmed.length > 0 && trimmed !== DEBUG_COMMAND
				? session.start(text)
				: null
		// Admission must precede terminal status; the client holds one pending prompt callback.
		if (result)
			await this.queueAgentMessage(agentId, () =>
				ws.send(JSON.stringify(promptReply(result) satisfies AgentServerMessage))
			)
		await scheduleDailyAlarm(this.ctx, this.getSession())
		if (parsed.type === 'abort') return
		if (parsed.type === 'activity_detail') {
			ws.send(
				JSON.stringify({
					type: 'activity_detail',
					requestId: parsed.requestId,
					result: await session.activityDetail(parsed.detailId)
				} satisfies AgentServerMessage)
			)
			return
		}

		if (parsed.type === 'snapshot') {
			await this.sendAgentSnapshot(ws, agentId)
			return
		}

		if (trimmed === DEBUG_COMMAND) {
			ws.send(
				JSON.stringify({
					type: 'debug',
					message: await session.systemPrompt()
				} satisfies AgentServerMessage)
			)
			return
		}

		if (result?.accepted) await result.done
	}

	private async handleControlMessage(ws: WebSocket, message: string): Promise<void> {
		let parsed: ControlClientMessage
		try {
			parsed = JSON.parse(message)
		} catch {
			ws.send(
				JSON.stringify({ type: 'error', message: 'Invalid JSON' } satisfies ControlServerMessage)
			)
			return
		}

		await scheduleDailyAlarm(this.ctx, this.getSession())
		if (parsed.type === 'app_open') await this.getApps().open(parsed.id)
		else await this.getApps().close(parsed.id)
	}

	private broadcastAgent(agentId: string | undefined, message: AgentServerMessage): void {
		const payload = JSON.stringify(message)
		for (const client of this.ctx.getWebSockets(agentSocketTag(agentId))) client.send(payload)
	}

	private broadcastControl(message: ControlServerMessage): void {
		const payload = JSON.stringify(message)
		for (const client of this.ctx.getWebSockets(CONTROL_SOCKET_TAG)) client.send(payload)
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

	// Do not reschedule the DAILY routine here — only WebSocket interactions set that
	// alarm, so a silent day naturally stops it. The one exception is owned by
	// `runDailyMaintenance`: a storage sweep that ran out of budget re-arms itself, and
	// reports `daily: false` on the wake that resumes it.
	async alarm(): Promise<void> {
		// The DO owns the synced fs, so daily trash retention and content collection
		// run without an open tab. Both are best-effort and retry on the next alarm.
		const { daily } = await runDailyMaintenance(
			[this.store, this.local],
			this.volume,
			this.ctx.storage
		)
		if (daily) await this.getSession().runMaintenance()
		// A continuation OWNS the one alarm slot until it drains, so every interaction
		// during it called `scheduleDailyAlarm`, found the slot taken and gave up — and
		// the wake that ends the chain leaves the slot EMPTY. Without this, tomorrow's
		// maintenance waits for another interaction that may never come. While the chain
		// still has work the slot holds the sweep's own re-arm, which this leaves alone.
		else await scheduleDailyAlarm(this.ctx, this.getSession())
	}

	async fetch(request: Request): Promise<Response> {
		this.cfTimezone = (request.cf as { timezone?: string } | undefined)?.timezone

		// Handle WebSocket upgrade
		const upgradeHeader = request.headers.get('Upgrade')
		if (upgradeHeader === 'websocket') {
			const path = new URL(request.url).pathname
			const appRoute = path.match(/^\/api\/apps\/([^/]+)\/ws$/)
			if (appRoute)
				return this.getApps().acceptWebSocket(
					appRoute[1],
					request.headers.get('Sec-WebSocket-Protocol')
				)

			const agentRoute = path.match(/^\/api\/agents\/([^/]+)\/connect$/)
			if (agentRoute) {
				const id = decodeURIComponent(agentRoute[1])
				const agentId = id === 'main' ? undefined : id
				const pair = new WebSocketPair()
				const [client, server] = Object.values(pair)
				server.serializeAttachment({ type: 'agent', agentId } satisfies SocketAttachment)
				this.ctx.acceptWebSocket(server, [agentSocketTag(agentId)])
				await scheduleDailyAlarm(this.ctx, this.getSession())
				await this.sendAgentSnapshot(server, agentId)
				return new Response(null, { status: 101, webSocket: client })
			}

			if (path !== '/ws') return this.app.fetch(request)
			const pair = new WebSocketPair()
			const [client, server] = Object.values(pair)
			server.serializeAttachment({ type: 'control' } satisfies SocketAttachment)
			this.ctx.acceptWebSocket(server, [CONTROL_SOCKET_TAG])
			await scheduleDailyAlarm(this.ctx, this.getSession())

			const participants = await this.loadParticipants(this.volume)
			server.send(
				JSON.stringify({
					type: 'ready',
					participants,
					apps: await this.getApps().list()
				} satisfies ControlServerMessage)
			)

			return new Response(null, {
				status: 101,
				webSocket: client
			})
		}

		return this.app.fetch(request)
	}

	private async loadParticipants(volume: Volume): Promise<DisplayParticipants> {
		const [profile, agentName] = await Promise.all([readProfile(volume), readAgentName(volume)])

		return {
			userName: parseFrontmatter(profile).name || 'You',
			agentName
		}
	}
}

const projectTranscript = (entries: Parameters<typeof sessionEntriesToTranscriptItems>[0]) =>
	sessionEntriesToTranscriptItems(entries, { expressions: true })
