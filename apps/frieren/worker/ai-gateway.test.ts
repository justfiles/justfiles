import { DatabaseSync } from 'node:sqlite'
import type { Api, Model, Usage } from '@earendil-works/pi-ai'
import type { DbAdapter, SqlValue } from '@justfiles/core'
import { describe, expect, test, vi } from 'vitest'
import { createAiGateway, meterSseStream } from './ai-gateway.ts'
import type { KvStorage } from './integrations/storage.ts'
import { type AiMeter, createAiMeter, QuotaExceededError } from './quota.ts'
import { type AdmitHandle, ensureUsageSchema, readAiUsage } from './usage.ts'

// ── Shared fixtures ─────────────────────────────────────────────────────────

// A real in-memory SQLite DbAdapter (mirrors usage.test.ts's realDb) — the "real store"
// tests exercise `createAiMeter` over the actual admit/record SQL, not a fake.
function realDb(): DbAdapter {
	const db = new DatabaseSync(':memory:')
	const adapter: DbAdapter = {
		async query<T extends Record<string, unknown>>(sql: string, args: SqlValue[] = []) {
			return db.prepare(sql).all(...(args as (string | number | bigint | null)[])) as unknown as T[]
		},
		async run(sql: string, args: SqlValue[] = []) {
			db.prepare(sql).run(...(args as (string | number | bigint | null)[]))
		},
		async transaction(fn) {
			await fn(adapter)
		}
	}
	return adapter
}

function memKv(): KvStorage {
	const map = new Map<string, unknown>()
	return {
		async get<T>(key: string) {
			return map.get(key) as T | undefined
		},
		async put<T>(key: string, value: T) {
			map.set(key, value)
		},
		async delete(key: string) {
			return map.delete(key)
		},
		async list<T>() {
			return new Map(map) as Map<string, T>
		}
	}
}

async function realMeter(): Promise<{ meter: AiMeter; db: DbAdapter }> {
	const db = realDb()
	await ensureUsageSchema(db)
	return { meter: createAiMeter(db, memKv()), db }
}

// A stand-in for the platform catalogue's one model. `cost` backs the abort-time estimate;
// values are USD per 1M tokens, same shape `aiRuntime()`'s real models carry.
function testModel(id = 'test/model'): Model<Api> {
	return {
		id,
		name: 'Test Model',
		api: 'openai-completions',
		provider: 'openrouter',
		baseUrl: 'https://example.test/v1',
		reasoning: false,
		input: ['text'],
		cost: { input: 1, output: 4, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192
	}
}

function fakeMeter(): AiMeter & {
	handles: AdmitHandle[]
	records: { handle: AdmitHandle; usage: unknown }[]
} {
	const handles: AdmitHandle[] = []
	const records: { handle: AdmitHandle; usage: unknown }[] = []
	return {
		handles,
		records,
		async admitOrThrow() {
			const handle: AdmitHandle = { burstExpires: 1, weeklyKey: 1 }
			handles.push(handle)
			return handle
		},
		async record(handle, usage) {
			records.push({ handle, usage })
		}
	}
}

function pending(deps: { waitUntil: (p: Promise<unknown>) => void }) {
	const list: Promise<unknown>[] = []
	deps.waitUntil = (p) => list.push(p)
	return list
}

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array | undefined) => new TextDecoder().decode(b)

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(enc(chunk))
			controller.close()
		}
	})
}

// ── meterSseStream — the tee that never buffers the response ───────────────

describe('meterSseStream', () => {
	test('passes chunks through untouched and in order', async () => {
		const source = streamOf(['data: {"a":1}\n\n', 'data: {"b":2}\n\n', 'data: [DONE]\n\n'])
		const out = meterSseStream(source, vi.fn(), vi.fn())
		const chunks: string[] = []
		for await (const chunk of out as unknown as AsyncIterable<Uint8Array>) chunks.push(dec(chunk))
		expect(chunks).toEqual(['data: {"a":1}\n\n', 'data: {"b":2}\n\n', 'data: [DONE]\n\n'])
	})

	test('reports the terminal usage frame exactly once, ignoring [DONE]', async () => {
		const onUsage = vi.fn()
		const onNoUsage = vi.fn()
		const source = streamOf([
			'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
			'data: {"choices":[],"usage":{"cost":0.002}}\n\n',
			'data: [DONE]\n\n'
		])
		const out = meterSseStream(source, onUsage, onNoUsage)
		for await (const _ of out as unknown as AsyncIterable<Uint8Array>);
		expect(onUsage).toHaveBeenCalledTimes(1)
		expect(onUsage).toHaveBeenCalledWith({ cost: 0.002 })
		expect(onNoUsage).not.toHaveBeenCalled()
	})

	test('double-record guard: two usage frames in one stream settle once', async () => {
		const onUsage = vi.fn()
		const source = streamOf([
			'data: {"usage":{"cost":0.001}}\n\n',
			'data: {"usage":{"cost":0.999}}\n\n'
		])
		const out = meterSseStream(source, onUsage, vi.fn())
		for await (const _ of out as unknown as AsyncIterable<Uint8Array>);
		expect(onUsage).toHaveBeenCalledTimes(1)
		expect(onUsage).toHaveBeenCalledWith({ cost: 0.001 })
	})

	test('cancelling the output (client aborts) cancels the source and reports bytes seen, no usage', async () => {
		let sourceCancelled = false
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(enc('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'))
			},
			cancel() {
				sourceCancelled = true
			}
		})
		const onUsage = vi.fn()
		const onNoUsage = vi.fn()
		const out = meterSseStream(source, onUsage, onNoUsage)
		const reader = out.getReader()
		await reader.read()
		await reader.cancel()
		// `reader.cancel()` resolves once OUR transformer's cancel algorithm runs; propagating
		// the cancel further upstream (erroring the transform's writable, which makes the
		// internal pipeTo cancel `source`) is a separate, unawaited chain — give it a tick.
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(sourceCancelled).toBe(true)
		expect(onUsage).not.toHaveBeenCalled()
		expect(onNoUsage).toHaveBeenCalledWith(expect.any(Number))
		expect(onNoUsage.mock.calls[0][0]).toBeGreaterThan(0)
	})
})

// ── createAiGateway — the two HTTP routes ───────────────────────────────────

describe('createAiGateway', () => {
	test('GET /model describes THE platform model: real id, branded name, zeroed cost', async () => {
		const app = createAiGateway({
			meter: fakeMeter(),
			model: { ...testModel('openai/gpt-5.4-mini'), compat: { supportsDeveloperRole: false } },
			upstream: vi.fn(),
			waitUntil: () => {}
		})
		const res = await app.request('/model')
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			// The id is the real upstream model — visible on the wire, just not selectable.
			id: 'openai/gpt-5.4-mini',
			name: 'Kodama AI',
			reasoning: false,
			input: ['text'],
			contextWindow: 128000,
			maxTokens: 8192,
			// A client displays this; the platform bills a quota, not tokens.
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			// pi auto-detects compat from the baseUrl, which for this gateway detects nothing —
			// so the server states the upstream's quirks.
			compat: { supportsDeveloperRole: false }
		})
	})

	test('a client-named model is overwritten, not rejected: there is nothing to choose', async () => {
		const meter = fakeMeter()
		let captured: Record<string, unknown> | undefined
		const upstream = vi.fn(async (body: Record<string, unknown>) => {
			captured = body
			return Response.json({ choices: [], usage: { cost: 0.0001 } })
		})
		const app = createAiGateway({ meter, model: testModel(), upstream, waitUntil: () => {} })
		const res = await app.request('/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({ model: 'anthropic/claude-opus-4-7', messages: [] })
		})
		expect(res.status).toBe(200)
		expect(captured?.model).toBe('test/model')
		expect(meter.handles).toHaveLength(1)
	})

	test('a non-object JSON body (null) is rejected as invalid_request, not a 500', async () => {
		const meter = fakeMeter()
		const upstream = vi.fn()
		const app = createAiGateway({ meter, model: testModel(), upstream, waitUntil: () => {} })
		const res = await app.request('/v1/chat/completions', {
			method: 'POST',
			body: 'null'
		})
		expect(res.status).toBe(400)
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_request')
		expect(upstream).not.toHaveBeenCalled()
	})

	test("strips OpenRouter's alternate-routing and paid add-on fields before forwarding", async () => {
		let captured: Record<string, unknown> | undefined
		const upstream = vi.fn(async (body: Record<string, unknown>) => {
			captured = body
			return Response.json({ choices: [], usage: { cost: 0.0001 } })
		})
		const app = createAiGateway({
			meter: fakeMeter(),
			model: testModel(),
			upstream,
			waitUntil: () => {}
		})
		await app.request('/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({
				model: 'test/model',
				messages: [],
				models: ['some/expensive-model'],
				fallbacks: [{ model: 'some/expensive-model' }],
				provider: { order: ['some-pricier-variant'] },
				plugins: [{ id: 'web' }],
				transforms: ['middle-out'],
				route: 'fallback',
				// A param pi itself sends must survive — the strip list is a denylist for a reason.
				reasoning_effort: 'high'
			})
		})
		expect(captured?.models).toBeUndefined()
		expect(captured?.fallbacks).toBeUndefined()
		expect(captured?.provider).toBeUndefined()
		expect(captured?.plugins).toBeUndefined()
		expect(captured?.transforms).toBeUndefined()
		expect(captured?.route).toBeUndefined()
		expect(captured?.reasoning_effort).toBe('high')
		expect(captured?.model).toBe('test/model')
	})

	test('over quota: 429, no upstream call', async () => {
		const meter: AiMeter = {
			admitOrThrow: () =>
				Promise.reject(new QuotaExceededError('AI limit reached — it resets soon.')),
			record: vi.fn()
		}
		const upstream = vi.fn()
		const app = createAiGateway({ meter, model: testModel(), upstream, waitUntil: () => {} })
		const res = await app.request('/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({ model: 'test/model', messages: [] })
		})
		expect(res.status).toBe(429)
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe('quota_exceeded')
		expect(upstream).not.toHaveBeenCalled()
	})

	test('a meter failure that is NOT quota exhaustion is a 502, not a 429', async () => {
		const meter: AiMeter = {
			admitOrThrow: () => Promise.reject(new Error('SQLITE_BUSY: database is locked')),
			record: vi.fn()
		}
		const upstream = vi.fn()
		const app = createAiGateway({ meter, model: testModel(), upstream, waitUntil: () => {} })
		const res = await app.request('/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({ model: 'test/model', messages: [] })
		})
		expect(res.status).toBe(502)
		const body = (await res.json()) as { error: { code: string; message: string } }
		expect(body.error.code).toBe('meter_unavailable')
		// The raw exception text never reaches the caller.
		expect(body.error.message).not.toContain('SQLITE_BUSY')
		expect(upstream).not.toHaveBeenCalled()
	})

	test('a spent quota reports WHEN it resets, so a client need not poll to find out', async () => {
		const resetsAt = Date.now() + 3_600_000
		const meter: AiMeter = {
			admitOrThrow: () => Promise.reject(new QuotaExceededError('AI limit reached.', resetsAt)),
			record: vi.fn()
		}
		const app = createAiGateway({
			meter,
			model: testModel(),
			upstream: vi.fn(),
			waitUntil: () => {}
		})
		const res = await app.request('/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({ model: 'test/model', messages: [] })
		})
		expect(res.status).toBe(429)
		expect(((await res.json()) as { error: { resetsAt: number } }).error.resetsAt).toBe(resetsAt)
	})

	test('the REAL meter reports the spent window’s reset instant on a 429', async () => {
		const { meter, db } = await realMeter()
		// Spend past the free tier's caps (burst $0.35, weekly $1) through the meter itself, so
		// the next admit is refused by the same SQL the gateway relies on.
		await meter.record(await meter.admitOrThrow(), {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 2 }
		})
		const upstream = vi.fn()
		const app = createAiGateway({ meter, model: testModel(), upstream, waitUntil: () => {} })
		const res = await app.request('/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({ model: 'test/model', messages: [] })
		})
		expect(res.status).toBe(429)
		const usage = await readAiUsage(db)
		const { resetsAt } = ((await res.json()) as { error: { resetsAt: number } }).error
		// Both windows are spent and admit needs BOTH under cap, so the reset a client is given
		// must not be earlier than EITHER of them — the earlier one sends it back to another 429.
		expect(resetsAt).toBeGreaterThanOrEqual(usage.burst.resetsAt ?? 0)
		expect(resetsAt).toBeGreaterThanOrEqual(usage.weekly.resetsAt ?? 0)
		expect(resetsAt).toBe(Math.max(usage.burst.resetsAt ?? 0, usage.weekly.resetsAt ?? 0))
		expect(resetsAt).toBeGreaterThan(Date.now())
		expect(upstream).not.toHaveBeenCalled()
	})

	test('forces include_usage when streaming, and omits stream_options when not', async () => {
		const captured: Record<string, unknown>[] = []
		const upstream = vi.fn(async (body: Record<string, unknown>) => {
			captured.push(body)
			return Response.json({ choices: [], usage: { cost: 0.0005 } })
		})
		const app = createAiGateway({
			meter: fakeMeter(),
			model: testModel(),
			upstream,
			waitUntil: () => {}
		})
		// Non-streaming: a strict OpenAI-compatible upstream 400s on `stream_options` here, and
		// that 400 would look like the CALLER's bad request — so it must not be added. The
		// non-streaming body carries usage on its own.
		await app.request('/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({ model: 'test/model', messages: [], stream_options: { foo: 1 } })
		})
		expect(captured[0].stream_options).toBeUndefined()
		expect(captured[0].usage).toEqual({ include: true })
		// Streaming: forced on, whatever the caller sent alongside it.
		await app.request('/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({
				model: 'test/model',
				messages: [],
				stream: true,
				stream_options: { include_usage: false }
			})
		})
		expect(captured[1].stream_options).toEqual({ include_usage: true })
	})

	test('a token-only usage frame (no cost) is priced from the model, never billed as zero', async () => {
		const meter = fakeMeter()
		// `usage.include` dropped upstream, or a server that only reports tokens. 1M output
		// tokens at the test model's $4/M rate = $4 exactly — pricing the tokens we KNOW we ran
		// beats recording nothing for a call that really happened.
		const deps = {
			meter,
			model: testModel(),
			upstream: vi.fn(async () =>
				Response.json({
					choices: [],
					usage: { prompt_tokens: 0, completion_tokens: 1_000_000, total_tokens: 1_000_000 }
				})
			),
			waitUntil: () => {}
		}
		const waits = pending(deps)
		const app = createAiGateway(deps)
		await app.request('/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({ model: 'test/model', messages: [] })
		})
		await Promise.all(waits)
		expect(meter.records).toHaveLength(1)
		expect((meter.records[0].usage as { cost: { total: number } }).cost.total).toBeCloseTo(4)
	})

	test('a streamed token-only usage frame is priced the same way', async () => {
		const meter = fakeMeter()
		const deps = {
			meter,
			model: testModel(),
			upstream: vi.fn(
				async () =>
					new Response(
						streamOf([
							'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
							'data: {"choices":[],"usage":{"completion_tokens":1000000,"total_tokens":1000000}}\n\n',
							'data: [DONE]\n\n'
						])
					)
			),
			waitUntil: () => {}
		}
		const waits = pending(deps)
		const app = createAiGateway(deps)
		const res = await app.request('/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({ model: 'test/model', stream: true, messages: [] })
		})
		await new Response(res.body).text()
		await Promise.all(waits)
		expect(meter.records).toHaveLength(1)
		expect((meter.records[0].usage as { cost: { total: number } }).cost.total).toBeCloseTo(4)
	})

	test('non-streaming happy path: response proxied verbatim, usage recorded once', async () => {
		const meter = fakeMeter()
		const upstream = vi.fn(async () =>
			Response.json({
				choices: [{ message: { role: 'assistant', content: 'hi' } }],
				usage: { cost: 0.002, prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
			})
		)
		const deps = { meter, model: testModel(), upstream, waitUntil: () => {} }
		const waits = pending(deps)
		const app = createAiGateway(deps)
		const res = await app.request('/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({ model: 'test/model', messages: [] })
		})
		expect(res.status).toBe(200)
		expect(
			((await res.json()) as { choices: { message: { content: string } }[] }).choices[0].message
				.content
		).toBe('hi')
		await Promise.all(waits)
		expect(meter.records).toHaveLength(1)
		expect(meter.records[0].usage).toMatchObject({ cost: { total: 0.002 }, totalTokens: 15 })
	})

	test('non-streaming happy path bills the REAL store: weekly_micros += 2000', async () => {
		const { meter, db } = await realMeter()
		const upstream = vi.fn(async () => Response.json({ choices: [], usage: { cost: 0.002 } }))
		const deps = { meter, model: testModel(), upstream, waitUntil: () => {} }
		const waits = pending(deps)
		const app = createAiGateway(deps)
		await app.request('/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({ model: 'test/model', messages: [] })
		})
		await Promise.all(waits)
		const usage = await readAiUsage(db)
		expect(usage.weekly.costUsd).toBeCloseTo(0.002)
	})

	test('streaming happy path: the first chunk arrives before upstream finishes; usage recorded once', async () => {
		let release: () => void = () => {}
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const source = new ReadableStream<Uint8Array>({
			async start(controller) {
				controller.enqueue(enc('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'))
				await gate // held open until the test proves the first chunk already arrived
				controller.enqueue(enc('data: {"choices":[],"usage":{"cost":0.002,"total_tokens":15}}\n\n'))
				controller.enqueue(enc('data: [DONE]\n\n'))
				controller.close()
			}
		})
		const meter = fakeMeter()
		const deps = {
			meter,
			model: testModel(),
			upstream: vi.fn(async () => new Response(source)),
			waitUntil: () => {}
		}
		const waits = pending(deps)
		const app = createAiGateway(deps)
		const res = await app.request('/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({ model: 'test/model', stream: true, messages: [] })
		})
		const reader = res.body?.getReader()
		if (!reader) throw new Error('expected a streamed body')
		const first = await reader.read()
		expect(dec(first.value)).toContain('"content":"hi"')
		release()
		for (;;) {
			const { done } = await reader.read()
			if (done) break
		}
		await Promise.all(waits)
		expect(meter.records).toHaveLength(1)
		expect(meter.records[0].usage).toMatchObject({ cost: { total: 0.002 } })
	})

	test('client abort mid-stream records a non-zero estimate and aborts the upstream source', async () => {
		let sourceCancelled = false
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(enc('data: {"choices":[{"delta":{"content":"partial reply"}}]}\n\n'))
			},
			cancel() {
				sourceCancelled = true
			}
		})
		const meter = fakeMeter()
		const deps = {
			meter,
			model: testModel(),
			upstream: vi.fn(async () => new Response(source)),
			waitUntil: () => {}
		}
		const waits = pending(deps)
		const app = createAiGateway(deps)
		const res = await app.request('/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({ model: 'test/model', stream: true, messages: [] })
		})
		const reader = res.body?.getReader()
		if (!reader) throw new Error('expected a streamed body')
		await reader.read()
		await reader.cancel()
		await Promise.all(waits)
		expect(sourceCancelled).toBe(true)
		expect(meter.records).toHaveLength(1)
		expect((meter.records[0].usage as { cost: { total: number } }).cost.total).toBeGreaterThan(0)
	})

	test('an aborted turn bills the PROMPT it already paid for, not just the bytes served', async () => {
		// The leak this closes: submit a huge context, read one chunk, disconnect. The upstream has
		// processed (and billed us for) the whole prompt either way, so an output-only estimate
		// charges pennies for dollars. Two identical aborts, one with a big prompt.
		const abortAfterFirstChunk = async (messages: unknown) => {
			const source = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(enc('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'))
				}
			})
			const meter = fakeMeter()
			const deps = {
				meter,
				model: testModel(),
				upstream: vi.fn(async () => new Response(source)),
				waitUntil: () => {}
			}
			const waits = pending(deps)
			const app = createAiGateway(deps)
			const res = await app.request('/v1/chat/completions', {
				method: 'POST',
				body: JSON.stringify({ model: 'test/model', stream: true, messages })
			})
			const reader = res.body?.getReader()
			if (!reader) throw new Error('expected a streamed body')
			await reader.read()
			await reader.cancel()
			await Promise.all(waits)
			expect(meter.records).toHaveLength(1)
			return meter.records[0].usage as Usage
		}
		// ~400k chars ≈ 100k tokens at the test model's $1/M input rate ≈ $0.10.
		const big = await abortAfterFirstChunk([{ role: 'user', content: 'x'.repeat(400_000) }])
		const small = await abortAfterFirstChunk([{ role: 'user', content: 'hi' }])
		expect(big.input).toBeGreaterThan(90_000)
		expect(big.cost.total).toBeGreaterThan(0.09)
		// Identical bytes served, so an output-only estimate would have billed these the same.
		expect(big.cost.total).toBeGreaterThan(small.cost.total * 100)
		expect(small.cost.total).toBeGreaterThan(0)
	})

	test('upstream 5xx surfaces as 502, records nothing, and leaves the real store unchanged', async () => {
		const { meter, db } = await realMeter()
		const upstream = vi.fn(async () => new Response('boom', { status: 500 }))
		const app = createAiGateway({ meter, model: testModel(), upstream, waitUntil: () => {} })
		const res = await app.request('/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({ model: 'test/model', messages: [] })
		})
		expect(res.status).toBe(502)
		const usage = await readAiUsage(db)
		expect(usage.weekly.costUsd).toBe(0)
		expect(usage.burst.costUsd).toBe(0)
	})

	test('upstream 4xx (a bad request the caller can fix) is passed through verbatim, not flattened to 502', async () => {
		const meter = fakeMeter()
		const upstream = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: { message: 'messages is required' } }), {
					status: 400,
					headers: {
						'content-type': 'application/json',
						// The upstream's own headers carry provider/account and rate-limit detail.
						'x-ratelimit-remaining': '3',
						'x-provider-account': 'acct_secret'
					}
				})
		)
		const app = createAiGateway({ meter, model: testModel(), upstream, waitUntil: () => {} })
		const res = await app.request('/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({ model: 'test/model', messages: [] })
		})
		expect(res.status).toBe(400)
		expect(await res.json()).toEqual({ error: { message: 'messages is required' } })
		expect(res.headers.get('content-type')).toContain('application/json')
		// Verbatim body, but not verbatim headers — scrubbing one while copying the other is
		// scrubbing nothing.
		expect(res.headers.get('x-provider-account')).toBeNull()
		expect(res.headers.get('x-ratelimit-remaining')).toBeNull()
		expect(meter.records).toHaveLength(0)
	})

	test('a moderation 403 is the CALLER’s to fix — relayed with its reasons, not hidden as a 502', async () => {
		// OpenRouter's documented 403: the prompt was flagged. Flattening it to 502 tells a client
		// to retry a request that will stay blocked, and hides why.
		const moderation = {
			error: {
				message: 'Input flagged by moderation',
				code: 403,
				metadata: { reasons: ['violence'], flagged_input: 'the caller’s own text' }
			}
		}
		const meter = fakeMeter()
		const app = createAiGateway({
			meter,
			model: testModel(),
			upstream: vi.fn(
				async () =>
					new Response(JSON.stringify(moderation), {
						status: 403,
						headers: { 'content-type': 'application/json' }
					})
			),
			waitUntil: () => {}
		})
		const res = await app.request('/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({ model: 'test/model', messages: [] })
		})
		expect(res.status).toBe(403)
		expect(await res.json()).toEqual(moderation)
		expect(meter.records).toHaveLength(0)
	})

	test('a 403 that is NOT moderation-shaped stays opaque — it is about OUR account', async () => {
		const meter = fakeMeter()
		const app = createAiGateway({
			meter,
			model: testModel(),
			upstream: vi.fn(
				async () =>
					new Response(JSON.stringify({ error: { message: 'account acct_secret suspended' } }), {
						status: 403,
						headers: { 'content-type': 'application/json' }
					})
			),
			waitUntil: () => {}
		})
		const res = await app.request('/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({ model: 'test/model', messages: [] })
		})
		expect(res.status).toBe(502)
		expect(await res.text()).not.toContain('acct_secret')
		expect(meter.records).toHaveLength(0)
	})

	test("upstream 401 (OUR key, not the caller's) is a 502, never relayed to the caller", async () => {
		const meter = fakeMeter()
		const upstream = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ error: { message: 'Invalid API key', account: 'acct_secret' } }),
					{
						status: 401,
						headers: { 'content-type': 'application/json' }
					}
				)
		)
		const app = createAiGateway({ meter, model: testModel(), upstream, waitUntil: () => {} })
		const res = await app.request('/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({ model: 'test/model', messages: [] })
		})
		expect(res.status).toBe(502)
		const text = await res.text()
		// The platform's own key/account details never reach the caller.
		expect(text).not.toContain('acct_secret')
		expect(text).not.toContain('Invalid API key')
		expect(meter.records).toHaveLength(0)
	})
})
