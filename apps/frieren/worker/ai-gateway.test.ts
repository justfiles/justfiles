import { DatabaseSync } from 'node:sqlite'
import type { Api, Model } from '@earendil-works/pi-ai'
import type { DbAdapter, SqlValue } from '@justfiles/core'
import { describe, expect, test, vi } from 'vitest'
import { createAiGateway, meterSseStream } from './ai-gateway.ts'
import type { KvStorage } from './integrations/storage.ts'
import { type AiMeter, createAiMeter } from './quota.ts'
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
	test('GET /models returns the platform catalogue', async () => {
		const app = createAiGateway({
			meter: fakeMeter(),
			models: [testModel('a/one'), testModel('b/two')],
			upstream: vi.fn(),
			waitUntil: () => {}
		})
		const res = await app.request('/models')
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([
			{ id: 'a/one', name: 'Test Model' },
			{ id: 'b/two', name: 'Test Model' }
		])
	})

	test('an unknown model is rejected before admitting anything', async () => {
		const meter = fakeMeter()
		const upstream = vi.fn()
		const app = createAiGateway({ meter, models: [testModel()], upstream, waitUntil: () => {} })
		const res = await app.request('/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({ model: 'nope', messages: [] })
		})
		expect(res.status).toBe(400)
		expect(meter.handles).toHaveLength(0)
		expect(upstream).not.toHaveBeenCalled()
	})

	test('a non-object JSON body (null) is rejected as invalid_request, not a 500', async () => {
		const meter = fakeMeter()
		const upstream = vi.fn()
		const app = createAiGateway({ meter, models: [testModel()], upstream, waitUntil: () => {} })
		const res = await app.request('/v1/chat/completions', {
			method: 'POST',
			body: 'null'
		})
		expect(res.status).toBe(400)
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_request')
		expect(upstream).not.toHaveBeenCalled()
	})

	test("strips OpenRouter's models/fallbacks alternate-routing fields before forwarding", async () => {
		let captured: Record<string, unknown> | undefined
		const upstream = vi.fn(async (body: Record<string, unknown>) => {
			captured = body
			return Response.json({ choices: [], usage: { cost: 0.0001 } })
		})
		const app = createAiGateway({
			meter: fakeMeter(),
			models: [testModel()],
			upstream,
			waitUntil: () => {}
		})
		await app.request('/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({
				model: 'test/model',
				messages: [],
				models: ['some/expensive-model'],
				fallbacks: [{ model: 'some/expensive-model' }]
			})
		})
		expect(captured?.models).toBeUndefined()
		expect(captured?.fallbacks).toBeUndefined()
		expect(captured?.model).toBe('test/model')
	})

	test('over quota: 429, no upstream call', async () => {
		const meter: AiMeter = {
			admitOrThrow: () => Promise.reject(new Error('AI limit reached — it resets soon.')),
			record: vi.fn()
		}
		const upstream = vi.fn()
		const app = createAiGateway({ meter, models: [testModel()], upstream, waitUntil: () => {} })
		const res = await app.request('/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({ model: 'test/model', messages: [] })
		})
		expect(res.status).toBe(429)
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe('quota_exceeded')
		expect(upstream).not.toHaveBeenCalled()
	})

	test('forces include_usage regardless of what the caller sent', async () => {
		let captured: Record<string, unknown> | undefined
		const upstream = vi.fn(async (body: Record<string, unknown>) => {
			captured = body
			return Response.json({ choices: [], usage: { cost: 0.0005 } })
		})
		const app = createAiGateway({
			meter: fakeMeter(),
			models: [testModel()],
			upstream,
			waitUntil: () => {}
		})
		await app.request('/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({ model: 'test/model', messages: [] }) // no stream_options at all
		})
		expect(captured?.stream_options).toEqual({ include_usage: true })
		expect(captured?.usage).toEqual({ include: true })
	})

	test('non-streaming happy path: response proxied verbatim, usage recorded once', async () => {
		const meter = fakeMeter()
		const upstream = vi.fn(async () =>
			Response.json({
				choices: [{ message: { role: 'assistant', content: 'hi' } }],
				usage: { cost: 0.002, prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
			})
		)
		const deps = { meter, models: [testModel()], upstream, waitUntil: () => {} }
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
		const deps = { meter, models: [testModel()], upstream, waitUntil: () => {} }
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
			models: [testModel()],
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
			models: [testModel()],
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

	test('upstream 5xx surfaces as 502, records nothing, and leaves the real store unchanged', async () => {
		const { meter, db } = await realMeter()
		const upstream = vi.fn(async () => new Response('boom', { status: 500 }))
		const app = createAiGateway({ meter, models: [testModel()], upstream, waitUntil: () => {} })
		const res = await app.request('/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({ model: 'test/model', messages: [] })
		})
		expect(res.status).toBe(502)
		const usage = await readAiUsage(db)
		expect(usage.weekly.costUsd).toBe(0)
		expect(usage.burst.costUsd).toBe(0)
	})
})
