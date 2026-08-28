// C1 (#297): the platform's metered inference gateway. Two routes mounted at `/api/ai` in the
// DO's Hono app (auth + per-user routing are inherited from `worker/index.ts`'s `/api/*`
// clerkMiddleware — this sub-app trusts its caller exactly like `/api/agent/*` already does,
// so it does not re-check auth):
//
//   GET  /model               the descriptor of THE platform model, for this account
//   POST /v1/chat/completions OpenAI-shaped passthrough, metered
//
// The point is a client that never buffers a whole response before billing it: bytes stream to
// the caller untouched while a side channel watches for the terminal usage object OpenRouter
// (or an OpenAI-compatible server with `stream_options.include_usage`) reports, and bills from
// THAT, never from what the client claims it received.
//
// The meter is CHECK-THEN-ADD, not a reservation (see usage.ts): calls admitted concurrently
// all see the same committed spend, so a window can end up over its cap by whatever was in
// flight, and the next call is then refused. Accepted, not overlooked — the caller is one
// agent turn loop, not a fan-out, so "in flight" is a couple of calls rather than an arbitrary
// number, and a pre-flight reservation would have to guess a cost it cannot know and refund the
// difference on every completion.
//
// There is no model CHOICE here, by design: the platform AI is one model, picked server-side.
// `/model` exists because pi needs the model's limits BEFORE it can build a request —
// `contextWindow` drives compaction, `maxTokens`/`input`/`compat` shape the body — and none of
// that can ride on an inference response. A client feeds this straight into pi-ai's dynamic
// provider hook (`createProvider({ fetchModels })`), which persists it and keeps the
// last-known copy when offline, so the client pins no model facts of its own and a
// server-side model swap lands on the next refresh.
import { type Api, calculateCost, type Model, type Usage } from '@earendil-works/pi-ai'
import { Hono } from 'hono'
import { type AiMeter, QuotaExceededError } from './quota.ts'

// The upstream statuses that mean "the caller's request itself is wrong" — a bad param or an
// unsupported option. Everything else non-2xx (401/402 — OUR key is invalid or the platform's
// OpenRouter account is out of credit, not something the caller ever supplied — 404, 429, 5xx)
// is a PLATFORM problem: relaying it would tell an authenticated caller their auth/request
// failed when the outage is ours, and could leak provider-account details from the body.
const CALLER_ACTIONABLE_STATUS = new Set([400, 422])

// 403 is the one status that is BOTH: OpenRouter documents it as "your chosen model requires
// moderation and your input was flagged" — the caller's own prompt, and their fix (rephrase),
// so the refusal and its `reasons` are worth relaying verbatim rather than flattened into a 502
// that reads as "retry later" for a request that will stay blocked. But 403 is equally what a
// policy/edge layer in front of the upstream would answer about OUR account, which the caller
// must never see. So a 403 is relayed only when the body actually carries the moderation shape.
function isCallerActionable(status: number, body: string): boolean {
	if (CALLER_ACTIONABLE_STATUS.has(status)) return true
	if (status !== 403) return false
	try {
		const parsed = JSON.parse(body) as unknown
		const error = isRecord(parsed) ? parsed.error : undefined
		const metadata = isRecord(error) ? error.metadata : undefined
		return isRecord(metadata) && Array.isArray(metadata.reasons)
	} catch {
		return false
	}
}

// OpenRouter's own alternate-routing and paid add-on fields, dropped from every forwarded
// body. `models`/`fallbacks` pick a DIFFERENT model when the primary errors or moderates —
// which would execute a model we never priced this call against; `provider` pins a specific
// (possibly pricier) upstream variant; `plugins`/`transforms`/`route` bill add-ons outside the
// model's per-token price. Spend is still capped by the meter either way, so this is about
// keeping "one model at one known price" true rather than about a leak.
//
// Deliberately a denylist, not an allowlist of permitted params: pi's own request shape is
// compat-dependent and grows (`reasoning_effort`, `thinking`, `chat_template_kwargs`,
// `prompt_cache_key`, `tool_stream`, `store`… see pi-ai's openai-completions `buildParams`).
// An allowlist would silently DISABLE reasoning or caching on a pi upgrade — a quiet
// functional regression for every user — whereas a missed OpenRouter knob costs one caller
// more of their OWN quota, bounded and visible in the meter.
const STRIPPED_FIELDS = ['models', 'fallbacks', 'provider', 'plugins', 'transforms', 'route']

// What the platform AI is CALLED, whatever it currently runs on. The real model id still rides
// on `id` (and in every response body) — identity is visible, it just isn't selectable.
const PLATFORM_MODEL_NAME = 'Just Computer AI'

// The `/model` wire shape: pi's own model config minus the fields the CLIENT owns — `provider`
// and `baseUrl` (its local provider id + this gateway's URL) and `api` (always
// `openai-completions`, the shape this gateway proxies). A client fills those in and has a
// complete pi `Model`.
export interface AiModelDescriptor {
	id: string
	name: string
	reasoning: boolean
	input: Model<Api>['input']
	contextWindow: number
	maxTokens: number
	cost: Model<Api>['cost']
	thinkingLevelMap?: Model<Api>['thinkingLevelMap']
	compat?: Model<Api>['compat']
}

export interface AiGatewayDeps {
	meter: Pick<AiMeter, 'admitOrThrow' | 'record'>
	// THE platform model — the same `Model` object `createPlatformAi()` builds for the in-process agent
	// backend, so the descriptor and the metered upstream can never drift from what the agent
	// itself runs. Its `.cost` also backs the abort-time estimate below.
	model: Model<Api>
	// The raw upstream call: an OpenAI-shaped request body in, the raw (streamed or not)
	// upstream `Response` out. Injected so tests never touch the network — production points
	// it at whichever backend `createPlatformAi()` selected (OpenRouter in prod, LM Studio in dev).
	upstream: (body: Record<string, unknown>, signal: AbortSignal) => Promise<Response>
	waitUntil: (promise: Promise<unknown>) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

// Pull the `usage` object out of one decoded SSE frame ("data: {...}"), if the frame carries
// one. `undefined` covers both "not a data frame" and "a data frame with no usage" — the
// caller can't bill either. `[DONE]` never parses as JSON and falls through the same way.
function usageFromSseFrame(frame: string): unknown {
	for (const line of frame.split('\n')) {
		const trimmed = line.trim()
		if (!trimmed.startsWith('data:')) continue
		const payload = trimmed.slice(5).trim()
		if (payload === '[DONE]' || payload === '') continue
		try {
			const parsed = JSON.parse(payload) as unknown
			if (isRecord(parsed) && parsed.usage != null) return parsed.usage
		} catch {
			// Not JSON (or a partial frame) — not a usage frame.
		}
	}
	return undefined
}

// OpenRouter's own usage shape (`usage.include: true`) carries `cost` in USD directly — the
// reason we force that flag. When it's absent (a plain OpenAI-compatible server that only
// reports tokens, or a response where the flag was dropped upstream) the reported TOKENS are
// still priced through the model's own rates rather than billed as zero: billing nothing for a
// real call is the revenue leak this gateway exists to close, and pricing from the model we
// know we ran is a better answer than the byte estimate below. Only a usage object with
// neither a cost nor any tokens has nothing billable in it.
function usageFromUpstream(model: Model<Api>, raw: unknown): Usage | null {
	if (!isRecord(raw)) return null
	const input = Number(raw.prompt_tokens ?? 0)
	const output = Number(raw.completion_tokens ?? 0)
	const usage: Usage = {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: Number(raw.total_tokens ?? input + output),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
	}
	if (typeof raw.cost === 'number') {
		usage.cost.total = raw.cost
		return usage
	}
	if (usage.totalTokens <= 0) return null
	calculateCost(model, usage)
	return usage
}

// A rough abort-time estimate, priced through the model's own rates (`calculateCost` mutates
// and returns `usage.cost`). 4 chars/token on BOTH sides: the prompt we sent is the dominant
// cost of an aborted turn — a caller that submits a huge context, reads one chunk and
// disconnects has already had its input processed and billed to the platform, so estimating
// output alone would bill pennies for dollars. Deliberately crude either way; the alternative
// is recording nothing for a partially-served turn, which is the leak this issue exists to
// close. Priced from the forwarded body's own size, so it can't be understated by the caller.
function estimateUsage(model: Model<Api>, promptChars: number, outputBytes: number): Usage {
	const input = Math.ceil(promptChars / 4)
	const output = Math.ceil(outputBytes / 4)
	const usage: Usage = {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
	}
	calculateCost(model, usage)
	return usage
}

// Tee the upstream SSE body: every chunk is enqueued to the caller FIRST (so the response is
// never buffered — the first chunk reaches the client before the terminal one arrives), then
// scanned for a usage frame. `onUsage` fires at most once, on whichever comes first: a usage
// frame, or the stream ending/being cancelled with none seen (`onNoUsage`, for the abort/short
// -upstream case). Cancelling the returned stream (the client disconnecting) propagates to
// `source` per the streams spec, so the upstream fetch aborts too — no orphaned spend.
export function meterSseStream(
	source: ReadableStream<Uint8Array>,
	onUsage: (raw: unknown) => void,
	onNoUsage: (bytesSeen: number) => void
): ReadableStream<Uint8Array> {
	let buffered = ''
	let bytesSeen = 0
	let settled = false
	const decoder = new TextDecoder()
	const settle = (raw: unknown) => {
		if (settled) return
		settled = true
		onUsage(raw)
	}
	// Same one-shot flag, so "record at most once per admitted call" holds by construction
	// rather than by `flush` and `cancel` being mutually exclusive per spec.
	const settleWithout = () => {
		if (settled) return
		settled = true
		onNoUsage(bytesSeen)
	}
	return source.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				controller.enqueue(chunk)
				bytesSeen += chunk.byteLength
				if (settled) return
				// Normalise CRLF so the frame separator is always exactly one blank line.
				buffered += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n')
				const frames = buffered.split('\n\n')
				buffered = frames.pop() ?? '' // the trailing partial frame carries to the next chunk
				for (const frame of frames) {
					const usage = usageFromSseFrame(frame)
					if (usage !== undefined) {
						settle(usage)
						break
					}
				}
			},
			flush() {
				if (!settled) {
					const usage = usageFromSseFrame(buffered)
					if (usage !== undefined) settle(usage)
				}
				settleWithout()
			},
			cancel() {
				settleWithout()
			}
		})
	)
}

export function createAiGateway(deps: AiGatewayDeps): Hono {
	const model = deps.model
	const descriptor: AiModelDescriptor = {
		id: model.id,
		name: PLATFORM_MODEL_NAME,
		reasoning: model.reasoning,
		input: model.input,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		// Zero on purpose. This is the number a CLIENT would display, and the platform bills a
		// quota, not tokens — real rates here would show a dollar figure nobody is charged, and a
		// second number to disagree with the meter. The server keeps `model.cost` for its own
		// pricing (the abort estimate); what's used is read back from the meter, not computed here.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...(model.thinkingLevelMap && { thinkingLevelMap: model.thinkingLevelMap }),
		// Compat quirks belong to whatever we run UPSTREAM, and pi auto-detects them from the
		// baseUrl when unset — which for a client pointed at this gateway detects nothing. So the
		// server states them; the alternative (rewriting request fields here) would end the
		// untouched-bytes property this whole design rests on.
		...(model.compat && { compat: model.compat })
	}

	return new Hono()
		.get('/model', (c) => c.json(descriptor))
		.post('/v1/chat/completions', async (c) => {
			let body: Record<string, unknown>
			try {
				const parsed = await c.req.json()
				if (!isRecord(parsed)) throw new TypeError('body must be a JSON object')
				body = parsed
			} catch {
				return c.json(
					{ error: { code: 'invalid_request', message: 'body must be a JSON object' } },
					400
				)
			}
			const streaming = Boolean(body.stream)

			let handle: Awaited<ReturnType<AiMeter['admitOrThrow']>>
			try {
				handle = await deps.meter.admitOrThrow()
			} catch (err) {
				// Only the INTENTIONAL case — the cap is genuinely spent — is the caller's to act on.
				// Anything else (the tier read or the SQLite admit statement failing operationally,
				// e.g. storage unavailable) is ours, not theirs: reporting it as "you're over quota"
				// would tell a client to upgrade or wait out a window that was never the problem, and
				// leaks our exception message to them besides.
				if (!(err instanceof QuotaExceededError)) {
					return c.json(
						{ error: { code: 'meter_unavailable', message: 'the usage meter is unavailable' } },
						502
					)
				}
				// `resetsAt` so a client can say when the AI is back instead of polling to find out.
				return c.json(
					{ error: { code: 'quota_exceeded', message: err.message, resetsAt: err.resetsAt } },
					429
				)
			}

			// The model is NOT the caller's decision: whatever they named is overwritten with the
			// platform's one model. No allowlist, because there is nothing to choose from — a client
			// that hard-codes a stale id keeps working, and a server-side model swap needs no client
			// release. Usage reporting is forced too, regardless of what the caller asked for:
			// without it the terminal chunk (streaming) or the body (non-streaming) carries no cost.
			// `stream_options` is streaming-only — a strict OpenAI-compatible upstream rejects it on a
			// non-streaming request, which would surface as a 400 the caller can't fix because WE
			// added the field.
			const forwardBody: Record<string, unknown> = {
				...body,
				model: model.id,
				usage: { include: true }
			}
			for (const field of STRIPPED_FIELDS) delete forwardBody[field]
			if (streaming) {
				forwardBody.stream_options = {
					...(isRecord(body.stream_options) ? body.stream_options : {}),
					include_usage: true
				}
			} else {
				delete forwardBody.stream_options
			}

			let upstreamRes: Response
			// The size of what we actually SENT, for the abort estimate below: the prompt is billed
			// to the platform the moment the upstream processes it, whether or not the caller stays
			// to read the answer. Measured here, off the forwarded body, so it reflects the request
			// as sent (tools and system prompt included) rather than anything the caller claims.
			const promptChars = JSON.stringify(forwardBody).length
			try {
				upstreamRes = await deps.upstream(forwardBody, c.req.raw.signal)
			} catch {
				return c.json(
					{ error: { code: 'upstream_error', message: 'the model backend failed to respond' } },
					502
				)
			}
			if (!upstreamRes.ok) {
				// Admit checks caps up front but adds no cost of its own (only `record` does), so a
				// failed call leaves the counters exactly where admit found them — nothing to refund.
				// Error bodies are small, so buffering one to classify it costs nothing.
				const text = await upstreamRes.text().catch(() => '')
				if (isCallerActionable(upstreamRes.status, text)) {
					// Relayed verbatim, but under OUR headers: the upstream's carry provider/account and
					// rate-limit detail the caller never asked about, and scrubbing the body while copying
					// every header would be scrubbing nothing.
					return new Response(text, {
						status: upstreamRes.status,
						headers: {
							'content-type': upstreamRes.headers.get('content-type') ?? 'application/json'
						}
					})
				}
				return c.json(
					{
						error: { code: 'upstream_error', message: `upstream responded ${upstreamRes.status}` }
					},
					502
				)
			}

			if (!streaming) {
				let json: unknown
				try {
					json = await upstreamRes.json()
				} catch {
					// A 2xx that isn't JSON (or a body that died mid-read) is not something the caller
					// can act on, and there is no usage in it to bill.
					return c.json(
						{ error: { code: 'upstream_error', message: 'upstream sent an unreadable body' } },
						502
					)
				}
				const usage = usageFromUpstream(model, isRecord(json) ? json.usage : undefined)
				if (usage) deps.waitUntil(deps.meter.record(handle, usage))
				return c.json(json)
			}

			if (!upstreamRes.body) {
				return c.json(
					{ error: { code: 'upstream_error', message: 'upstream sent no stream body' } },
					502
				)
			}

			const stream = meterSseStream(
				upstreamRes.body,
				(raw) => {
					const usage = usageFromUpstream(model, raw)
					if (usage) deps.waitUntil(deps.meter.record(handle, usage))
				},
				(bytesSeen) => {
					// No usage frame arrived — an abort, or an upstream that ignored the forced flag.
					// Bill the rough estimate rather than nothing. A zero-byte stream (nothing was ever
					// served) is left alone: charging a full prompt for a turn that produced no output
					// invites the opposite complaint, and there is no incentive to abort for nothing.
					if (bytesSeen === 0) return
					deps.waitUntil(deps.meter.record(handle, estimateUsage(model, promptChars, bytesSeen)))
				}
			)
			return new Response(stream, {
				headers: { 'content-type': 'text/event-stream; charset=utf-8' }
			})
		})
}
