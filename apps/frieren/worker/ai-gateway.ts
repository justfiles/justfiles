// C1 (#297): the platform's metered inference gateway. Two routes mounted at `/api/ai` in the
// DO's Hono app (auth + per-user routing are inherited from `worker/index.ts`'s `/api/*`
// clerkMiddleware — this sub-app trusts its caller exactly like `/api/usage` and
// `/api/agent/*` already do, so it does not re-check auth):
//
//   GET  /models              the platform catalogue (ids + display names)
//   POST /v1/chat/completions OpenAI-shaped passthrough, metered
//
// The point is a client that never buffers a whole response before billing it: bytes stream to
// the caller untouched while a side channel watches for the terminal usage object OpenRouter
// (or an OpenAI-compatible server with `stream_options.include_usage`) reports, and bills from
// THAT, never from what the client claims it received.
import { type Api, calculateCost, type Model, type Usage } from '@earendil-works/pi-ai'
import { Hono } from 'hono'
import type { AiMeter } from './quota.ts'

export interface AiGatewayDeps {
	meter: AiMeter
	// The platform's model catalogue — the SAME `Model` objects `aiRuntime()` builds for the
	// in-process agent backend, so `/models` and the allowlist can never drift from what the
	// agent itself offers. Each model's own `.cost` also backs the abort-time estimate below.
	models: readonly Model<Api>[]
	// The raw upstream call: an OpenAI-shaped request body in, the raw (streamed or not)
	// upstream `Response` out. Injected so tests never touch the network — production points
	// it at whichever backend `aiRuntime()` selected (OpenRouter in prod, LM Studio in dev).
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
// reason we force that flag rather than relying on token counts alone. A usage object with no
// numeric `cost` (a plain OpenAI-compatible server that only reports tokens, e.g. local LM
// Studio) has nothing billable to extract; the caller skips recording rather than guessing.
export function orUsageToUsage(raw: unknown): Usage | null {
	if (!isRecord(raw) || typeof raw.cost !== 'number') return null
	const input = Number(raw.prompt_tokens ?? 0)
	const output = Number(raw.completion_tokens ?? 0)
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: Number(raw.total_tokens ?? input + output),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: raw.cost }
	}
}

// A rough abort-time estimate — 4 bytes/token, priced through the model's own per-token
// output rate (`calculateCost` mutates and returns `usage.cost`). Deliberately crude: the
// alternative is recording nothing for a partially-served turn, which is the actual revenue
// leak this issue exists to close.
function estimateUsage(model: Model<Api>, outputBytes: number): Usage {
	const outputTokens = Math.ceil(outputBytes / 4)
	const usage: Usage = {
		input: 0,
		output: outputTokens,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: outputTokens,
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
				if (!settled) onNoUsage(bytesSeen)
			},
			cancel() {
				if (!settled) onNoUsage(bytesSeen)
			}
		})
	)
}

export function createAiGateway(deps: AiGatewayDeps): Hono {
	const byId = new Map(deps.models.map((m) => [m.id, m] as const))

	return new Hono()
		.get('/models', (c) => c.json(deps.models.map((m) => ({ id: m.id, name: m.name }))))
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

			// Model allowlist: only ids from the platform catalogue. An unknown model is an
			// unknown price, so this never becomes a general-purpose OpenRouter passthrough.
			const model = typeof body.model === 'string' ? byId.get(body.model) : undefined
			if (!model) {
				return c.json(
					{ error: { code: 'unknown_model', message: `unknown model: ${String(body.model)}` } },
					400
				)
			}

			let handle: Awaited<ReturnType<AiMeter['admitOrThrow']>>
			try {
				handle = await deps.meter.admitOrThrow()
			} catch (err) {
				return c.json(
					{
						error: {
							code: 'quota_exceeded',
							message: err instanceof Error ? err.message : 'AI limit reached'
						}
					},
					429
				)
			}

			// Force usage reporting regardless of what the caller asked for — otherwise the
			// terminal chunk (streaming) or the body (non-streaming) carries no cost, and this
			// bills zero for a real call. `models`/`fallbacks` are OpenRouter's OWN alternate-model
			// routing fields (tried when the primary model errors, moderates, or rate-limits) —
			// stripped, never forwarded: honouring them would let a request that names an allowed
			// `model` still execute a DIFFERENT one we never validated (and never priced this
			// call's abort-time estimate against), turning one allowlist check into a bypassable
			// formality.
			const { models: _alternateModels, fallbacks: _fallbacks, ...safeBody } = body
			const forwardBody = {
				...safeBody,
				model: model.id,
				stream_options: {
					...(isRecord(body.stream_options) ? body.stream_options : {}),
					include_usage: true
				},
				usage: { include: true }
			}

			let upstreamRes: Response
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
				return c.json(
					{
						error: { code: 'upstream_error', message: `upstream responded ${upstreamRes.status}` }
					},
					502
				)
			}

			if (!body.stream) {
				const json = await upstreamRes.json()
				const usage = orUsageToUsage(isRecord(json) ? json.usage : undefined)
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
					const usage = orUsageToUsage(raw)
					if (usage) deps.waitUntil(deps.meter.record(handle, usage))
				},
				(bytesSeen) => {
					// No usage frame arrived — an abort, or an upstream that ignored the forced flag.
					// Bill the rough estimate rather than nothing; a zero-byte stream (aborted before
					// any content) has nothing to estimate from either.
					if (bytesSeen === 0) return
					deps.waitUntil(deps.meter.record(handle, estimateUsage(model, bytesSeen)))
				}
			)
			return new Response(stream, {
				headers: { 'content-type': 'text/event-stream; charset=utf-8' }
			})
		})
}
