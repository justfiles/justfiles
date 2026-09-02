import {
	type Cursor,
	ForeignCursorError,
	type Guard,
	type Hash,
	HashMismatchError,
	type Node,
	type Page,
	type Store,
	sha256Hex
} from './store'

const SEP = String.fromCharCode(0)

const minutes = (count: number): number => count * 60 * 1_000
const days = (count: number): number => count * 24 * 60 * 60 * 1_000

export const DEFAULT_SYNC_POLICY = {
	cursorLeaseMs: days(30),
	writeLeaseMs: minutes(15),
	maxWriteDurationMs: minutes(5),
	tombstoneFenceAgeMs: days(30),
	tombstoneGraceMs: days(10),
	deleteBatch: 128
} as const

export type SyncPolicy = {
	[key in keyof typeof DEFAULT_SYNC_POLICY]: number
}

export function syncPolicy(overrides: Partial<SyncPolicy> = {}): SyncPolicy {
	const policy = { ...DEFAULT_SYNC_POLICY, ...overrides }
	for (const [name, value] of Object.entries(policy))
		if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be positive`)
	if (policy.tombstoneFenceAgeMs < policy.cursorLeaseMs)
		throw new TypeError('tombstoneFenceAgeMs must be at least cursorLeaseMs')
	if (policy.tombstoneGraceMs <= policy.writeLeaseMs + policy.maxWriteDurationMs)
		throw new TypeError('tombstoneGraceMs must exceed writeLeaseMs plus maxWriteDurationMs')
	if (policy.deleteBatch < 1 || !Number.isInteger(policy.deleteBatch))
		throw new TypeError('deleteBatch must be a positive integer')
	return policy
}

type CursorClaims = {
	lineage: string
	position: number
	issuedAt: number
	expiresAt: number
	mode: 'resume' | 'bootstrap'
}

export type ReceiverState = {
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
}

/** Private backend capability. It deliberately does not widen `Store`. */
export const receiverBackend = Symbol('receiver backend')

export type ReceiverStore = Store & { [receiverBackend]: ReceiverBackend }

export type Peer = Pick<Store, 'get' | 'child' | 'children'> & {
	since(cursor?: Cursor): Promise<Page>
	open(cursor?: Cursor): Promise<WriteLease>
	commit(lease: WriteLease, writes: Node[], guards?: Guard[]): Promise<void>
	blobs: Pick<Store['blobs'], 'has' | 'get'> & {
		put(lease: WriteLease, hash: Hash, data: Uint8Array): Promise<void>
	}
}

export type WriteLease = string

type LeaseClaims = {
	lineage: string
	position: number
	issuedAt: number
	expiresAt: number
}

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
	constructor() {
		super('bootstrap required')
		this.name = 'BootstrapRequiredError'
	}
}

/** A short-lived direct writer for trusted tools which do not keep a replica. */
export async function openPeerStore(peer: Peer): Promise<Store> {
	let cursor: Cursor | undefined
	for (;;) {
		const page = await peer.since(cursor)
		if (page.next === undefined) throw new Error('receiver did not return a feed cursor')
		cursor = page.next
		if (page.nodes.length === 0) break
	}
	const lease = await peer.open(cursor)
	return {
		get: (id) => peer.get(id),
		child: (parent, name) => peer.child(parent, name),
		children: (parent, at) => peer.children(parent, at),
		async since(at) {
			try {
				return await peer.since(at)
			} catch (error) {
				if (error instanceof BootstrapRequiredError) throw new ForeignCursorError()
				throw error
			}
		},
		commit: (writes, guards) => peer.commit(lease, writes, guards),
		blobs: {
			has: (hash) => peer.blobs.has(hash),
			get: (hash) => peer.blobs.get(hash),
			put: (hash, data) => peer.blobs.put(lease, hash, data)
		}
	}
}

export function receiver(
	store: ReceiverStore,
	opts: { clock?: () => number; lock?: SyncStateLock; policy?: Partial<SyncPolicy> } = {}
): Peer {
	const backend = store[receiverBackend]
	const policy = syncPolicy(opts.policy)
	const clock = opts.clock ?? Date.now
	const lock = opts.lock ?? syncStateLock()

	return {
		get: (id) => store.get(id),
		child: (parent, name) => store.child(parent, name),
		children: (parent, cursor) => store.children(parent, cursor),
		blobs: {
			has: (hash) => store.blobs.has(hash),
			get: (hash) => store.blobs.get(hash),
			async put(lease, hash, data) {
				await validateLease(lease)
				const held = new Uint8Array(data)
				if ((await sha256Hex(held)) !== hash) throw new HashMismatchError(hash)
				await validateLease(lease)
				await store.blobs.put(hash, held)
			}
		},
		async open(cursor) {
			const now = await backend.observe(clock())
			const state = await backend.state()
			if (cursor === undefined) throw new BootstrapRequiredError()
			const parent = await verifyCursor(cursor, state, now)
			if (parent.mode !== 'resume') throw new BootstrapRequiredError()
			return sign(
				{
					lineage: state.lineage,
					position: parent.position,
					issuedAt: now,
					expiresAt: Math.min(now + policy.writeLeaseMs, parent.expiresAt)
				},
				state.signingSecret,
				'lease'
			)
		},
		commit: (lease, writes, guards) =>
			lock(async () => {
				await validateLease(lease)
				await store.commit(writes, guards)
			}),
		async since(cursor) {
			const now = await backend.observe(clock())
			const state = await backend.state()
			const claims =
				cursor === undefined
					? bootstrapClaims(state, now, policy)
					: await verifyCursor(cursor, state, now)
			const page = await store.since(
				claims.position === 0 ? undefined : backend.cursor(claims.position)
			)
			if (page.next === undefined) throw new Error('receiver store did not return a feed cursor')
			const position = backend.position(page.next)
			const next: CursorClaims =
				position >= state.feedHead
					? { ...bootstrapClaims(state, now, policy), position, mode: 'resume' }
					: { ...claims, position }
			return { nodes: page.nodes, next: await sign(next, state.signingSecret, 'cursor') }
		}
	}

	async function validateLease(lease: WriteLease): Promise<void> {
		const observed = await backend.observe(clock())
		await verifyLease(lease, await backend.state(), observed)
	}
}

const bootstrapClaims = (state: ReceiverState, now: number, policy: SyncPolicy): CursorClaims => ({
	lineage: state.lineage,
	position: 0,
	issuedAt: now,
	expiresAt: now + policy.cursorLeaseMs,
	mode: 'bootstrap'
})

const verifyCursor = async (
	token: Cursor,
	state: ReceiverState,
	now: number
): Promise<CursorClaims> => {
	try {
		const claims = await verifiedClaims<CursorClaims>(token, state.signingSecret, 'cursor')
		if (
			claims.lineage !== state.lineage ||
			!Number.isInteger(claims.position) ||
			claims.position < 0 ||
			claims.position > state.feedHead ||
			!Number.isFinite(claims.issuedAt) ||
			!Number.isFinite(claims.expiresAt) ||
			claims.expiresAt <= now ||
			(claims.mode !== 'resume' && claims.mode !== 'bootstrap') ||
			(claims.mode === 'resume' && claims.position < state.feedFloor)
		)
			throw new Error()
		return claims
	} catch {
		throw new BootstrapRequiredError()
	}
}

const verifyLease = async (
	token: string,
	state: ReceiverState,
	now: number
): Promise<LeaseClaims> => {
	try {
		const claims = await verifiedClaims<LeaseClaims>(token, state.signingSecret, 'lease')
		if (
			claims.lineage !== state.lineage ||
			!Number.isInteger(claims.position) ||
			claims.position < state.feedFloor ||
			claims.position > state.feedHead ||
			!Number.isFinite(claims.issuedAt) ||
			!Number.isFinite(claims.expiresAt) ||
			claims.expiresAt <= now
		)
			throw new Error()
		return claims
	} catch {
		throw new BootstrapRequiredError()
	}
}

type TokenKind = 'cursor' | 'lease'

const sign = async (
	claims: CursorClaims | LeaseClaims,
	secret: string,
	kind: TokenKind
): Promise<string> => {
	const payload = base64url(new TextEncoder().encode(JSON.stringify(claims)))
	return `${payload}.${await signatureOf(payload, secret, kind)}`
}

const verifiedClaims = async <T>(token: string, secret: string, kind: TokenKind): Promise<T> => {
	const [payload, signature, extra] = token.split('.')
	if (!payload || !signature || extra !== undefined) throw new Error()
	const expected = await signatureOf(payload, secret, kind)
	if (!sameText(signature, expected)) throw new Error()
	return JSON.parse(new TextDecoder().decode(unbase64url(payload))) as T
}

const signatureOf = async (payload: string, secret: string, kind: TokenKind): Promise<string> => {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	)
	return base64url(
		new Uint8Array(
			await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${kind}${SEP}${payload}`))
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
