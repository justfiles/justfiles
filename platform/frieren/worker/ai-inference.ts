import type { Context } from '@earendil-works/pi-ai'
import type { AgentBackend } from '@justfiles/agent'
import { describeBackend, failureMessage, inferenceRequest } from '@justfiles/agent/remote'
import type { AiSelection } from '@justfiles/app/capabilities/accounts/host'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { stream } from 'hono/streaming'

type Resolved = { backend: AgentBackend; selection: AiSelection }

// Authentication and user-to-DO routing come from worker/index.ts.
export function createAiInference(resolve: (selection?: AiSelection) => Promise<Resolved>) {
	return new Hono()
		.get('/backend', async (c) => {
			const { backend, selection } = await resolve()
			c.header('cache-control', 'no-store')
			return c.json(describeBackend(backend, selection))
		})
		.post('/infer', bodyLimit({ maxSize: 16 * 1024 * 1024 }), async (c) => {
			const parsed = inferenceRequest.safeParse(await c.req.json().catch(() => null))
			if (!parsed.success) return c.json({ error: 'Invalid inference request' }, 400)
			const { selection, context, options } = parsed.data
			let resolved: Resolved
			try {
				resolved = await resolve(selection)
			} catch {
				return c.json(
					{ error: 'AI account changed or is unavailable. Check Settings and retry.' },
					409
				)
			}
			const { backend } = resolved
			c.header('content-type', 'application/x-ndjson')
			c.header('cache-control', 'no-store')
			return stream(c, async (out) => {
				const abort = new AbortController()
				out.onAbort(() => abort.abort())
				const signal = AbortSignal.any([
					abort.signal,
					c.req.raw.signal,
					AbortSignal.timeout(5 * 60_000)
				])
				try {
					const events = await backend.streamFn(backend.model, context as unknown as Context, {
						...options,
						signal
					})
					for await (const event of events) {
						await out.writeln(JSON.stringify(event))
						if (event.type === 'done' || event.type === 'error') return
					}
					throw new Error('AI stream ended before completing. Please retry.')
				} catch (error) {
					if (!signal.aborted)
						await out.writeln(
							JSON.stringify({
								type: 'error',
								reason: 'error',
								error: failureMessage(backend.model, error)
							})
						)
				} finally {
					abort.abort()
				}
			})
		})
}
