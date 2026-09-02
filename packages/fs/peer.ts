import { type Cursor, HashMismatchError, type Page, type Store, sha256Hex } from './store'

const SEP = String.fromCharCode(0)

const days = (count: number): number => count * 24 * 60 * 60 * 1_000

export const DEFAULT_HISTORY_POLICY = {
	tombstoneRetentionMs: days(30),
	deleteBatch: 128
} as const

export type HistoryPolicy = {
	[key in keyof typeof DEFAULT_HISTORY_POLICY]: number
}

export function historyPolicy(overrides: Partial<HistoryPolicy> = {}): HistoryPolicy {
	const policy = { ...DEFAULT_HISTORY_POLICY, ...overrides }
	if (!Number.isFinite(policy.tombstoneRetentionMs) || policy.tombstoneRetentionMs <= 0)
		throw new TypeError('tombstoneRetentionMs must be positive')
	if (!Number.isInteger(policy.deleteBatch) || policy.deleteBatch < 1)
		throw new TypeError('deleteBatch must be a positive integer')
	return policy
}

const maxOfflineMs = (policy: HistoryPolicy): number => policy.tombstoneRetentionMs

type CursorClaims = {
	issuer: string
	lineage: string
	position: number
	expiresAt: number
	mode: 'resume' | 'bootstrap'
}

export type ReceiverState = {
	issuer: string
	lineage: string
	signingSecret: string
	feedHead: number
	feedFloor: number
}

export type ReceiverBackend = {
	state(): Promise<ReceiverState>
	observe(now: number): Promise<number>
	cursor(position: number): Cursor
	position(cursor: Cursor): number
	lock?: SyncStateLock
}

/** Private backend capability. It deliberately does not widen `Store`. */
export const receiverBackend = Symbol('receiver backend')

export type SyncStateLock = <T>(body: () => Promise<T>) => Promise<T>

export function syncStateLock(): SyncStateLock {
	let tail: Promise<unknown> = Promise.resolve()
	return <T>(body: () => Promise<T>): Promise<T> => {
		const next = tail.then(body)
		tail = next.catch(() => undefined)
		return next
	}
}

export class BootstrapRequiredError extends Error {
	readonly peerId?: string
	readonly winnerId?: string

	constructor(peerId?: string, winnerId?: string) {
		super('bootstrap required')
		this.name = 'BootstrapRequiredError'
		this.peerId = peerId
		this.winnerId = winnerId
	}
}

export type CursorSource = { load(): Promise<Cursor | undefined> }

const binders = new WeakMap<Store, (source: CursorSource) => Store>()

/** Bind a remote store to the durable cursor for one sync relationship. */
export const bindCursor = (store: Store, source: CursorSource): Store =>
	binders.get(store)?.(source) ?? store

/** Register transport plumbing for `bindCursor` without adding to `Store`. */
export const cursorBound = (store: Store, bind: (source: CursorSource) => Store): Store => {
	binders.set(store, bind)
	return store
}

/** Advance a short-lived direct client to a writable receiver cursor. */
export async function currentStore(store: Store): Promise<Store> {
	let cursor: Cursor | undefined
	for (;;) {
		const page = await store.since(cursor)
		if (page.next === undefined) throw new Error('receiver did not return a feed cursor')
		cursor = page.next
		if (page.nodes.length === 0) return store
	}
}

/** Protect a raw store with receiver-issued cursor tokens without widening `Store`. */
export type ReceiverOptions = {
	clock?: () => number
	issuer?: () => Promise<string>
	lock?: SyncStateLock
	policy?: Partial<HistoryPolicy>
}

export function receiver(store: Store, opts: ReceiverOptions = {}): Store {
	const backend = (store as Store & { [receiverBackend]?: ReceiverBackend })[receiverBackend]
	if (!backend) throw new TypeError('store does not provide receiver cursor state')
	const policy = historyPolicy(opts.policy)
	const clock = opts.clock ?? Date.now
	const lock = opts.lock ?? backend.lock ?? syncStateLock()
	const state = async (): Promise<ReceiverState> => {
		const current = await backend.state()
		return opts.issuer ? { ...current, issuer: await opts.issuer() } : current
	}

	const relationship = (source?: CursorSource): Store => {
		let readCursor: Cursor | undefined

		const readToken = async (): Promise<Cursor | undefined> => readCursor ?? (await source?.load())
		const writeToken = (): Promise<Cursor | undefined> =>
			source ? source.load() : Promise.resolve(readCursor)
		const read = async <T>(body: () => Promise<T>): Promise<T> => {
			await validate(await readToken(), 'read')
			return body()
		}
		const write = <T>(body: () => Promise<T>): Promise<T> =>
			lock(async () => {
				await validate(await writeToken(), 'write')
				return body()
			})

		const peer: Store = {
			get: (id) => read(() => store.get(id)),
			child: (parent, name) => read(() => store.child(parent, name)),
			children: (parent, cursor) => read(() => store.children(parent, cursor)),
			async since(cursor) {
				const page = await lock(() => scan(cursor))
				readCursor = page.next
				return page
			},
			commit: (writes, guards) => write(() => store.commit(writes, guards)),
			blobs: {
				has: (hash) => read(() => store.blobs.has(hash)),
				get: (hash) => read(() => store.blobs.get(hash)),
				async put(hash, data) {
					const held = new Uint8Array(data)
					if ((await sha256Hex(held)) !== hash) throw new HashMismatchError(hash)
					await write(() => store.blobs.put(hash, held))
				}
			}
		}
		return cursorBound(peer, (next) => relationship(next))
	}

	const scan = async (cursor?: Cursor): Promise<Page> => {
		const now = await backend.observe(clock())
		const before = await state()
		const claims =
			cursor === undefined
				? bootstrapClaims(before, now, policy)
				: await verifyCursor(cursor, before, now)
		const page = await store.since(
			claims.position === 0 ? undefined : backend.cursor(claims.position)
		)
		if (page.next === undefined) throw new Error('receiver store did not return a feed cursor')
		const after = await state()
		const position = backend.position(page.next)
		const next: CursorClaims =
			position >= after.feedHead
				? { ...bootstrapClaims(after, now, policy), position, mode: 'resume' }
				: { ...claims, position }
		return { nodes: page.nodes, next: await sign(next, after.signingSecret) }
	}

	const validate = async (token: Cursor | undefined, mode: 'read' | 'write'): Promise<void> => {
		const now = await backend.observe(clock())
		const current = await state()
		if (token === undefined) throw new BootstrapRequiredError(current.issuer)
		const claims = await verifyCursor(token, current, now)
		if (mode === 'write' && claims.mode !== 'resume')
			throw new BootstrapRequiredError(current.issuer)
	}

	return relationship()
}

const bootstrapClaims = (
	state: ReceiverState,
	now: number,
	policy: HistoryPolicy
): CursorClaims => ({
	issuer: state.issuer,
	lineage: state.lineage,
	position: 0,
	expiresAt: now + maxOfflineMs(policy),
	mode: 'bootstrap'
})

const verifyCursor = async (
	token: Cursor,
	state: ReceiverState,
	now: number
): Promise<CursorClaims> => {
	try {
		const claims = await verifiedClaims<CursorClaims>(token, state.signingSecret)
		if (
			claims.issuer !== state.issuer ||
			claims.lineage !== state.lineage ||
			!Number.isInteger(claims.position) ||
			claims.position < 0 ||
			claims.position > state.feedHead ||
			!Number.isFinite(claims.expiresAt) ||
			claims.expiresAt <= now ||
			(claims.mode !== 'resume' && claims.mode !== 'bootstrap') ||
			(claims.mode === 'resume' && claims.position < state.feedFloor)
		)
			throw new Error()
		return claims
	} catch {
		throw new BootstrapRequiredError(state.issuer)
	}
}

const sign = async (claims: CursorClaims, secret: string): Promise<string> => {
	const payload = base64url(new TextEncoder().encode(JSON.stringify(claims)))
	return `${payload}.${await signatureOf(payload, secret)}`
}

const verifiedClaims = async <T>(token: string, secret: string): Promise<T> => {
	const [payload, signature, extra] = token.split('.')
	if (!payload || !signature || extra !== undefined) throw new Error()
	const expected = await signatureOf(payload, secret)
	if (!sameText(signature, expected)) throw new Error()
	return JSON.parse(new TextDecoder().decode(unbase64url(payload))) as T
}

const signatureOf = async (payload: string, secret: string): Promise<string> => {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	)
	return base64url(
		new Uint8Array(
			await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`cursor${SEP}${payload}`))
		)
	)
}

const sameText = (a: string, b: string): boolean => {
	if (a.length !== b.length) return false
	let difference = 0
	for (let at = 0; at < a.length; at++) difference |= a.charCodeAt(at) ^ b.charCodeAt(at)
	return difference === 0
}

const base64url = (data: Uint8Array): string => {
	let binary = ''
	for (const byte of data) binary += String.fromCharCode(byte)
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const unbase64url = (value: string): Uint8Array => {
	const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
	const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
	return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

export const rawCursor = (lineage: string, position: number): Cursor =>
	`${lineage}${SEP}${position}`

export const rawPosition = (cursor: Cursor, lineage: string): number => {
	if (!cursor.startsWith(lineage + SEP)) throw new BootstrapRequiredError()
	return Number(cursor.slice(lineage.length + SEP.length))
}

export const cursorIssuer = (cursor: Cursor): string => {
	try {
		const payload = cursor.split('.')[0]
		if (!payload) throw new Error()
		const claims = JSON.parse(new TextDecoder().decode(unbase64url(payload))) as {
			issuer?: unknown
		}
		if (typeof claims.issuer !== 'string') throw new Error()
		return claims.issuer
	} catch {
		throw new BootstrapRequiredError()
	}
}
