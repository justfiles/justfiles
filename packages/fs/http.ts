/**
 * A peer `Store` over HTTP. Each operation carries the receiver's signed feed
 * cursor without widening the seam.
 *
 * `wire.internal.ts` owns the wire format in both directions, so its two halves
 * cannot drift. This file owns the client transport.
 *
 * `fetch` and nothing else, so this runs in a browser, a worker, or node.
 */

import { BootstrapRequiredError } from './peer'
import { type SyncCursor, syncCursor } from './peer.internal'
import { type Guard, GuardError, type Hash, type Node, type Store } from './store'
import { decodeNode, decodePage, encodeNode } from './wire.internal'

export type HttpStoreOptions = {
	/** Sent with every request. An authorization header is the expected use. */
	headers?: Record<string, string>
	/**
	 * The fetch to use, defaulting to the platform's. Injectable because the
	 * server is itself a fetch handler: a hub in the same worker, or in the same
	 * test, needs no socket to be talked to over its own wire.
	 */
	fetch?: (url: string, init?: RequestInit) => Promise<Response>
}

export function httpStore(baseUrl: string, opts: HttpStoreOptions = {}): Store {
	const base = baseUrl.replace(/\/+$/, '')
	const send = opts.fetch ?? ((url, init) => fetch(url, init))

	/**
	 * One request, and the one place a refusal becomes the error the seam names
	 * for it. Everything else is left to the caller: the blob routes have a
	 * status of their own to read.
	 */
	const call = async (path: string, init?: Init): Promise<Response> => {
		const headers: Record<string, string> = { ...opts.headers }
		if (init?.type !== undefined) headers['content-type'] = init.type
		if (init?.cursor !== undefined) headers['x-sync-cursor'] = init.cursor
		const res = await send(base + path, {
			method: init?.method,
			body: init?.body,
			headers,
			cache: 'no-store'
		})
		// A refusal, not a failure: a guard did not hold, and the body says which.
		if (res.status === 409) throw new GuardError(await refusal(res))
		// Expired, swept, malformed, and wrong-lineage cursors have one public answer.
		if (res.status === 410) {
			const body = (await res.json().catch(() => null)) as { peerId?: unknown } | null
			throw new BootstrapRequiredError(typeof body?.peerId === 'string' ? body.peerId : undefined)
		}
		return res
	}

	/** A call that has to have succeeded, and its JSON. `null` for a 204. */
	const answer = async (path: string, init?: Init): Promise<unknown> => {
		const res = await call(path, init)
		if (!res.ok) throw await failed(res, init?.method, path)
		return res.status === 204 ? null : res.json()
	}

	/** A blob route's answer, or `null` for the 404 that means "not here". */
	const blob = async (hash: Hash, method?: string, cursor?: string): Promise<Response | null> => {
		const res = await call(blobPath(hash), { method, cursor })
		// Rule 7's ordinary miss, which a lazy replica meets on every stub it has
		// not fetched yet. It is the only 404 this API gives.
		if (res.status === 404) return null
		if (!res.ok) throw await failed(res, method, blobPath(hash))
		return res
	}

	const relationship = (source?: SyncCursor): Store => {
		let readCursor: string | undefined
		const readToken = async (): Promise<string | undefined> => readCursor ?? (await source?.load())
		const writeToken = (): Promise<string | undefined> =>
			source ? source.load() : Promise.resolve(readCursor)

		const peer: Store & { [syncCursor]: (cursor: SyncCursor) => Store } = {
			[syncCursor]: (cursor) => relationship(cursor),
			get: async (id) =>
				nodeOrNull(await answer(`/node/${encodeURIComponent(id)}`, { cursor: await readToken() })),
			child: async (parent, name) =>
				nodeOrNull(
					await answer(`/child?${query({ parent, name })}`, { cursor: await readToken() })
				),
			children: async (parent, cursor) =>
				decodePage(
					await answer(`/children?${query({ parent, cursor })}`, {
						cursor: await readToken()
					})
				),
			async since(cursor) {
				const found = decodePage(await answer(`/since?${query({ cursor })}`, { cursor }))
				readCursor = found.next
				return found
			},
			async commit(writes, guards) {
				// Rule 3: the batch is taken at the CALL. `JSON.stringify` runs before
				// this function's first await, which is where the caller gets control back
				// and may edit a row it just handed over.
				const body = JSON.stringify({ writes: writes.map(encodeNode), guards })
				await answer('/commit', {
					method: 'POST',
					body,
					type: 'application/json',
					cursor: await writeToken()
				})
			},

			blobs: {
				// A HEAD, so the question the engine actually asks — is this content
				// there? — does not drag the bytes across to be thrown away.
				has: async (hash) => (await blob(hash, 'HEAD', await readToken())) !== null,
				async get(hash) {
					const res = await blob(hash, undefined, await readToken())
					return res === null ? null : new Uint8Array(await res.arrayBuffer())
				},
				async put(hash, data) {
					// Held before the first await, for the reason `commit` stringifies early.
					const body = new Uint8Array(data).buffer
					await answer(blobPath(hash), {
						method: 'PUT',
						body,
						type: 'application/octet-stream',
						cursor: await writeToken()
					})
				}
			}

			// No `subscribe`: rule 8 makes it optional, and a client that polls `since`
			// sees every writer's commits.
		}
		return peer
	}

	return relationship()
}

/**
 * The two bodies this wire sends: a JSON document, and blob bytes. Named exactly
 * rather than as `BodyInit`, which is a DOM name — this package is `platform:
 * neutral` and its consumers compile it under whatever lib they have.
 */
type Init = { method?: string; body?: string | ArrayBuffer; type?: string; cursor?: string }

const blobPath = (hash: Hash): string => `/blob/${encodeURIComponent(hash)}`

/**
 * `encodeURIComponent` per value, rather than `URLSearchParams`, which writes a
 * space as `+` and so needs a decoder that knows the form-encoding rule. A
 * cursor or a name may hold any byte at all, including NUL, and this is the
 * escaping every URL decoder agrees on.
 */
const query = (params: Record<string, string | undefined>): string =>
	Object.entries(params)
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => `${key}=${encodeURIComponent(value as string)}`)
		.join('&')

const nodeOrNull = (value: unknown): Node | null => (value === null ? null : decodeNode(value))

/** Which guard the peer refused on. A 409 that names none is still a refusal. */
const refusal = async (res: Response): Promise<Guard | string> => {
	const body = (await res.json().catch(() => null)) as { reason?: Guard | string } | null
	return body?.reason ?? 'the peer refused the commit without naming a guard'
}

const failed = async (res: Response, method: string | undefined, path: string): Promise<Error> =>
	new Error(
		`store: ${method ?? 'GET'} ${path} answered ${res.status} ${(await res.text()).slice(0, 200)}`
	)
