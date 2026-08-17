/**
 * The seam over HTTP: a `Store` whose one table lives behind a URL.
 *
 * There is no protocol here beyond the seam — five node calls, three content
 * calls, one route each, rows verbatim. A cursor does travel, and rule 5 is not
 * bent by it: the cursor this client sends is one this very store minted, handed
 * back to the only store that means anything by it. A handle has exactly one
 * feed, so the two sides cannot be mixed up.
 *
 * The file owns the wire FORMAT in both directions, because the two halves of a
 * codec must not drift: the server (`packages/core/src/store.api.ts`) imports
 * the halves it needs from here rather than restating the shape. What the server
 * owns is routing and status codes.
 *
 * `fetch` and nothing else, so this runs in a browser, a worker, or node.
 */

import {
	ForeignCursorError,
	type Guard,
	GuardError,
	type Hash,
	type Node,
	type Page,
	type Store
} from './store'

/**
 * A `Node` as JSON. Two fields change shape and no others do: the 64-bit counts
 * become decimal strings, since JSON has no bigint, and an xattr value becomes
 * base64, since JSON has no bytes. Absent fields stay absent — a row must come
 * back EQUAL to the row that was sent (rule 3), and `{}` is not nothing.
 */
export type WireNode = Omit<Node, 'mtimeNs' | 'size' | 'xattrs'> & {
	mtimeNs: string
	size: string
	xattrs?: Record<string, string>
}

export const encodeNode = ({ mtimeNs, size, xattrs, ...rest }: Node): WireNode => {
	const wire: WireNode = { ...rest, mtimeNs: String(mtimeNs), size: String(size) }
	if (xattrs !== undefined)
		wire.xattrs = Object.fromEntries(
			Object.entries(xattrs).map(([name, value]) => [name, base64(value)])
		)
	return wire
}

/**
 * The untrusting direction, and both sides use it. The server because a peer's
 * rows are the one way a malformed row could enter the table every replica
 * converges on — nothing under it type-checks a row, since the authority checks
 * the TREE and a store just stores — and the client because a wire answering
 * something other than this API should say so where it happened.
 */
export const decodeNode = (value: unknown): Node => {
	const row = fields(value, 'a node')
	const node: Node = {
		id: text(row.id, 'id'),
		parent: text(row.parent, 'parent'),
		name: text(row.name, 'name'),
		type: kind(row.type),
		mode: whole(row.mode, 'mode'),
		mtimeNs: digits(row.mtimeNs, 'mtimeNs'),
		size: digits(row.size, 'size'),
		version: text(row.version, 'version')
	}
	if (row.xattrs !== undefined)
		node.xattrs = Object.fromEntries(
			Object.entries(fields(row.xattrs, 'xattrs')).map(([name, value]) => [
				name,
				unbase64(text(value, `xattr ${name}`))
			])
		)
	if (row.content !== undefined) node.content = text(row.content, 'content')
	if (row.link !== undefined) node.link = text(row.link, 'link')
	// Rule 8: a tombstone is `true` or the field is not there. Nothing else.
	if (row.deleted !== undefined) node.deleted = row.deleted === true ? true : bad('deleted')
	return node
}

/** The one body this API takes: what a commit writes, and what it stands on. */
export const decodeCommit = (value: unknown): { writes: Node[]; guards?: Guard[] } => {
	const body = fields(value, 'a commit')
	const writes = list(body.writes, 'writes').map(decodeNode)
	if (body.guards === undefined) return { writes }
	return { writes, guards: list(body.guards, 'guards').map(decodeGuard) }
}

const decodeGuard = (value: unknown): Guard => {
	const guard = fields(value, 'a guard')
	if (guard.free !== undefined) {
		const free = fields(guard.free, 'a free guard')
		return {
			free: { parent: text(free.parent, 'free.parent'), name: text(free.name, 'free.name') }
		}
	}
	const version = fields(guard.version, 'a version guard')
	return {
		version: {
			id: text(version.id, 'version.id'),
			// `null` is the guard that says "must not exist", so it is a value here
			// and not a missing field.
			is: version.is === null ? null : text(version.is, 'version.is')
		}
	}
}

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
		const res = await send(base + path, { method: init?.method, body: init?.body, headers })
		// A refusal, not a failure: a guard did not hold, and the body says which.
		if (res.status === 409) throw new GuardError(await refusal(res))
		// Rule 11: no position in that store will ever answer to that cursor.
		if (res.status === 410) throw new ForeignCursorError()
		return res
	}

	/** A call that has to have succeeded, and its JSON. `null` for a 204. */
	const answer = async (path: string, init?: Init): Promise<unknown> => {
		const res = await call(path, init)
		if (!res.ok) throw await failed(res, init?.method, path)
		return res.status === 204 ? null : res.json()
	}

	/** A blob route's answer, or `null` for the 404 that means "not here". */
	const blob = async (hash: Hash, method?: string): Promise<Response | null> => {
		const res = await call(blobPath(hash), { method })
		// Rule 7's ordinary miss, which a lazy replica meets on every stub it has
		// not fetched yet. It is the only 404 this API gives.
		if (res.status === 404) return null
		if (!res.ok) throw await failed(res, method, blobPath(hash))
		return res
	}

	return {
		get: async (id) => nodeOrNull(await answer(`/node/${encodeURIComponent(id)}`)),
		child: async (parent, name) => nodeOrNull(await answer(`/child?${query({ parent, name })}`)),
		children: async (parent, cursor) =>
			page(await answer(`/children?${query({ parent, cursor })}`)),
		since: async (cursor) => page(await answer(`/since?${query({ cursor })}`)),

		async commit(writes, guards) {
			// Rule 3: the batch is taken at the CALL. `JSON.stringify` runs before
			// this function's first await, which is where the caller gets control back
			// and may edit a row it just handed over.
			const body = JSON.stringify({ writes: writes.map(encodeNode), guards })
			await answer('/commit', { method: 'POST', body, type: 'application/json' })
		},

		blobs: {
			// A HEAD, so the question the engine actually asks — is this content
			// there? — does not drag the bytes across to be thrown away.
			has: async (hash) => (await blob(hash, 'HEAD')) !== null,
			async get(hash) {
				const res = await blob(hash)
				return res === null ? null : new Uint8Array(await res.arrayBuffer())
			},
			async put(hash, data) {
				// Held before the first await, for the reason `commit` stringifies early.
				const body = new Uint8Array(data)
				await answer(blobPath(hash), {
					method: 'PUT',
					body,
					type: 'application/octet-stream'
				})
			}
		}

		// No `subscribe`: rule 8 makes it optional, and a client that polls `since`
		// sees every writer's commits. A push channel is a latency optimization this
		// wire can grow later — with no seam change, which is the point of it being
		// optional.
	}
}

type Init = { method?: string; body?: BodyInit; type?: string }

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

const page = (value: unknown): Page => {
	const got = fields(value, 'a page')
	const nodes = list(got.nodes, 'nodes').map(decodeNode)
	return got.next === undefined ? { nodes } : { nodes, next: text(got.next, 'next') }
}

/** Which guard the peer refused on. A 409 that names none is still a refusal. */
const refusal = async (res: Response): Promise<Guard | string> => {
	const body = (await res.json().catch(() => null)) as { reason?: Guard | string } | null
	return body?.reason ?? 'the peer refused the commit without naming a guard'
}

const failed = async (res: Response, method: string | undefined, path: string): Promise<Error> =>
	new Error(
		`store: ${method ?? 'GET'} ${path} answered ${res.status} ${(await res.text()).slice(0, 200)}`
	)

const bad = (what: string): never => {
	throw new TypeError(`malformed ${what} on the wire`)
}

const fields = (value: unknown, what: string): Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: bad(what)

const list = (value: unknown, what: string): unknown[] => (Array.isArray(value) ? value : bad(what))

const text = (value: unknown, what: string): string =>
	typeof value === 'string' ? value : bad(what)

const whole = (value: unknown, what: string): number =>
	typeof value === 'number' && Number.isInteger(value) ? value : bad(what)

const digits = (value: unknown, what: string): bigint =>
	typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : bad(what)

const kind = (value: unknown): Node['type'] =>
	value === 'file' || value === 'dir' || value === 'symlink' || value === 'mount'
		? value
		: bad('type')

const base64 = (data: Uint8Array): string => {
	let binary = ''
	for (const byte of data) binary += String.fromCharCode(byte)
	return btoa(binary)
}

const unbase64 = (value: string): Uint8Array =>
	Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
