/**
 * The server's own protocol, and only that.
 *
 * The seam is `store.api.ts` — one route per seam call, over one table — and it says
 * nothing about a LINEAGE, because a lineage lives in the cursors and rule 11 is what
 * fences a replica that outlived one. Two things still need saying, and neither is the
 * seam's:
 *
 * - **The epoch.** An app-level factory reset CASes against a generation, and
 *   `synced.ts`'s `generation()` only ever reports what its injected `reset()` returned
 *   — which is nothing on a replica that never ran `takeMine`. So the epoch is READ, not
 *   remembered, and this is where it is read from.
 * - **The reset.** `adopt-mine` and `wipe` truncate, so they have to be ordered against
 *   every write the host is serving, which no capability called from a request handler
 *   can promise. A host that supports them owns this URL upstream and answers ahead of
 *   this app (frieren commits the reset and then terminates the instance that made it,
 *   which is what orders it). What is left here is the NON-destructive half: clearing the
 *   advisory in-progress marker once the initiator's republish drained.
 *
 * The route stays in the chain either way, so the typed client carries the whole shape of
 * this URL — including the 200/409 the host's own destructive handler answers with.
 */

import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { GenerationState } from './reset'

/**
 * The lineage-mutation request (POST /reset). `adopt-mine` / `wipe` CAS on
 * `fromGeneration` (truncate + bump); `complete` is advisory — the initiator's
 * republish drained, so clear the in-progress flag.
 */
export const ResetBody = z.discriminatedUnion('mode', [
	z.object({
		mode: z.literal('adopt-mine'),
		fromGeneration: z.number().int(),
		operationId: z.string().min(1),
		// Optional, because a republish that needs no marker may say so. The store
		// model's `takeMine` is one: interrupted anywhere it leaves an emptied
		// authority and a volume still whole here, so running it again is both the
		// retry and the recovery — there is no half-state for a flag to name.
		resetId: z.string().optional(),
		// The volume identity the client believes it is republishing onto. The reset
		// capability validates it atomically with the generation CAS (see reset.ts), so a
		// stale endpoint swap can't truncate a different volume at the same generation.
		lineageId: z.string().optional()
	}),
	z.object({
		mode: z.literal('wipe'),
		fromGeneration: z.number().int(),
		operationId: z.string().min(1),
		lineageId: z.string().optional()
	}),
	z.object({ mode: z.literal('complete'), resetId: z.string() })
])
export type ResetBody = z.infer<typeof ResetBody>
export type DestructiveResetBody = Exclude<ResetBody, { mode: 'complete' }>

export type ResetResult =
	| { ok: true; generation: number; replayed?: true }
	| { ok: false; error: 'generation_stale' | 'lineage_stale'; generation: number }

export function createFsApi(opts: {
	/**
	 * The server volume's lineage: the epoch `generation`, the volume's stable
	 * `lineageId`, and the advisory `resetId`. Injected by the host, because reading it
	 * is a query against the host's own database.
	 */
	lineage: () => GenerationState | Promise<GenerationState>
	/**
	 * The NON-destructive half of POST /reset. It changes no generation and truncates
	 * nothing, so it is safe to serve from inside this app, alongside live writes.
	 */
	complete: (resetId: string) => Promise<ResetResult>
}) {
	return (
		new Hono()
			// The one non-seam read: the authority's lineage, for the two callers that need
			// an epoch — the app's factory reset, and the `reset()` closure `syncedVolume`
			// calls to start a new one.
			.get('/', async (c) => {
				const lineage = await opts.lineage()
				return c.json({
					generation: lineage.generation,
					resetId: lineage.resetId,
					lineageId: lineage.lineageId
				})
			})

			.post('/reset', zValidator('json', ResetBody), async (c) => {
				const body = c.req.valid('json')
				// A destructive mode never reaches here on a host that supports one: it owns
				// this URL upstream. On a host that does not, saying so is the answer.
				if (body.mode !== 'complete') return c.json({ error: 'reset not supported' }, 501)
				const result = await opts.complete(body.resetId)
				return result.ok
					? c.json({ generation: result.generation })
					: c.json({ error: result.error, generation: result.generation }, 409)
			})
	)
}
