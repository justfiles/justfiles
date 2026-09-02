/**
 * Leased peer protocol above `Store`: signed feed cursors, write leases, and one
 * public stale answer — `BootstrapRequiredError`.
 */

import {
	type Cursor,
	forwarded,
	type Guard,
	type Hash,
	type Node,
	type Page,
	type Store
} from './store'
import { type SyncPolicy, validateSyncPolicy } from './sync-policy'

export type WriteLease = string

export class BootstrapRequiredError extends Error {
	constructor() {
		super('bootstrap required')
		this.name = 'BootstrapRequiredError'
	}
}

export type PendingFence = { through: number; fencedAt: number }

export type SyncLock = {
	run<T>(fn: () => Promise<T> | T): Promise<T>
}

export const mutexLock = (): SyncLock => {
	let chain: Promise<unknown> = Promise.resolve()
	return {
		run(fn) {
			const next = chain.then(fn, fn)
			chain = next.catch(() => undefined)
			return next as Promise<Awaited<ReturnType<typeof fn>>>
		}
	}
}

export type PushCursorProvider = () => Promise<Cursor | readonly Cursor[] | undefined>

export type ReceiverClock = {
	now(): number
	tick(now: number): void
}

export type ReceiverState = {
	lineage: string
	secret: Uint8Array
	feedFloor: number
	feedHead: number
	pendingFence: PendingFence | null
}

export type ReceiverContext = {
	state: ReceiverState
	clock: ReceiverClock
	lock: SyncLock
	policy: SyncPolicy
	pushCursor?: PushCursorProvider
}

export type LeasedPeer = {
	get(id: string): Promise<Node | null>
	child(parent: string, name: string): Promise<Node | null>
	children(parent: string, cursor?: Cursor): Promise<Page>
	blobs: Pick<Store['blobs'], 'has' | 'get'>
	open(saved?: Cursor): Promise<WriteLease>
	put(lease: WriteLease, hash: Hash, data: Uint8Array): Promise<void>
	since(cursor?: Cursor): Promise<Page>
	commit(lease: WriteLease, writes: Node[], guards?: Guard[]): Promise<void>
}

export function leasedPeer(store: Store, ctx: ReceiverContext): LeasedPeer {
	validateSyncPolicy(ctx.policy)
	const read = forwarded(store)

	return {
		get: read.get,
		child: read.child,
		children: read.children,
		blobs: { has: read.blobs.has, get: read.blobs.get },
		open: (saved) => open(ctx, saved),
		since: (cursor) => scan(store, ctx, cursor),
		put: (lease, hash, data) => put(store, ctx, lease, hash, data),
		commit: (lease, writes, guards) => commit(store, ctx, lease, writes, guards)
	}
}

export const newSecret = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32))

const reject = (): never => {
	throw new BootstrapRequiredError()
}

const now = (ctx: ReceiverContext): number => {
	const at = ctx.clock.now()
	ctx.clock.tick(at)
	return at
}

async function open(ctx: ReceiverContext, saved?: Cursor): Promise<WriteLease> {
	const at = now(ctx)
	if (saved === undefined) return reject()
	const claims = await readCursor(ctx, saved, at)
	if (claims.mode !== 'resume') return reject()
	if (claims.position < ctx.state.feedFloor) return reject()
	return signLease(ctx.state.secret, {
		cursor: saved,
		issuedAt: at,
		expiresAt: Math.min(at + ctx.policy.writeLeaseMs, claims.expiresAt)
	})
}

async function scan(store: Store, ctx: ReceiverContext, cursor?: Cursor): Promise<Page> {
	const at = now(ctx)
	let mode: CursorMode = 'bootstrap'
	let position = 0
	let expiresAt = at + ctx.policy.cursorLeaseMs
	if (cursor !== undefined) {
		const claims = await readCursor(ctx, cursor, at)
		mode = claims.mode
		position = claims.position
		expiresAt = claims.expiresAt
		if (mode === 'resume' && claims.position < ctx.state.feedFloor) reject()
	}
	const page = await store.since(
		mode === 'bootstrap' && position === 0 ? undefined : rawCursor(ctx, position)
	)
	const nextPos = page.next === undefined ? ctx.state.feedHead : rawPosition(ctx, page.next)
	const nextMode = nextPos >= ctx.state.feedHead ? 'resume' : mode
	if (nextMode === 'resume' && nextPos >= ctx.state.feedHead)
		expiresAt = at + ctx.policy.cursorLeaseMs
	return {
		nodes: page.nodes,
		next: await signCursor(ctx.state.secret, {
			lineage: ctx.state.lineage,
			position: nextPos,
			issuedAt: at,
			expiresAt,
			mode: nextMode
		})
	}
}

async function put(
	store: Store,
	ctx: ReceiverContext,
	lease: WriteLease,
	hash: Hash,
	data: Uint8Array
): Promise<void> {
	await readLease(ctx, lease, now(ctx))
	await store.blobs.put(hash, data)
}

async function commit(
	store: Store,
	ctx: ReceiverContext,
	lease: WriteLease,
	writes: Node[],
	guards?: Guard[]
): Promise<void> {
	await ctx.lock.run(async () => {
		await readLease(ctx, lease, now(ctx))
		await store.commit(writes, guards)
	})
}

async function readCursor(ctx: ReceiverContext, token: string, at: number): Promise<CursorClaims> {
	const claims = await unpack(ctx.state.secret, token)
	if (!cursorClaims(claims)) return reject()
	const held = claims
	if (held.lineage !== ctx.state.lineage) reject()
	if (held.issuedAt > at || held.expiresAt <= held.issuedAt) reject()
	if (held.expiresAt <= at) reject()
	if (held.position > ctx.state.feedHead) reject()
	return held
}

async function readLease(ctx: ReceiverContext, lease: WriteLease, at: number): Promise<void> {
	const claims = await unpack(ctx.state.secret, lease)
	if (!leaseClaims(claims)) return reject()
	const held = claims
	if (held.issuedAt > at || held.expiresAt <= held.issuedAt) reject()
	if (held.expiresAt <= at) reject()
	if (at >= held.issuedAt + ctx.policy.maxWriteDurationMs) reject()
	const cursor = await readCursor(ctx, held.cursor, at)
	if (cursor.mode !== 'resume' || cursor.position < ctx.state.feedFloor) reject()
}

const rawCursor = (ctx: ReceiverContext, position: number): Cursor =>
	ctx.state.lineage + String.fromCharCode(0) + position

const rawPosition = (ctx: ReceiverContext, cursor: Cursor): number =>
	cursor.startsWith(ctx.state.lineage + String.fromCharCode(0))
		? Number(cursor.slice(ctx.state.lineage.length + 1))
		: reject()

type CursorMode = 'resume' | 'bootstrap'

type CursorClaims = {
	lineage: string
	position: number
	issuedAt: number
	expiresAt: number
	mode: CursorMode
}

type LeaseClaims = { cursor: string; issuedAt: number; expiresAt: number }

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

const stamp = (value: unknown): value is number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const cursorClaims = (value: unknown): value is CursorClaims =>
	record(value) &&
	typeof value.lineage === 'string' &&
	stamp(value.position) &&
	stamp(value.issuedAt) &&
	stamp(value.expiresAt) &&
	(value.mode === 'resume' || value.mode === 'bootstrap')

const leaseClaims = (value: unknown): value is LeaseClaims =>
	record(value) &&
	typeof value.cursor === 'string' &&
	stamp(value.issuedAt) &&
	stamp(value.expiresAt)

const TOKEN = 'v1'

const signCursor = (secret: Uint8Array, claims: CursorClaims): Promise<string> =>
	sign(secret, claims)
const signLease = (secret: Uint8Array, claims: LeaseClaims): Promise<string> => sign(secret, claims)

const sign = async (secret: Uint8Array, claims: object): Promise<string> => {
	const body = b64url(new TextEncoder().encode(JSON.stringify(claims)))
	return `${TOKEN}.${body}.${b64url(await hmac(secret, body))}`
}

const hmac = async (secret: Uint8Array, payload: string): Promise<Uint8Array> => {
	const key = await hmacKey(secret)
	return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)))
}

const hmacKey = (secret: Uint8Array): Promise<CryptoKey> =>
	crypto.subtle.importKey(
		'raw',
		new Uint8Array(secret).buffer,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify']
	)

const unpack = async (secret: Uint8Array, token: string): Promise<unknown | null> => {
	const parts = token.split('.')
	if (parts.length !== 3 || parts[0] !== TOKEN) return null
	const [, body, sig] = parts as [string, string, string]
	try {
		const valid = await crypto.subtle.verify(
			'HMAC',
			await hmacKey(secret),
			new Uint8Array(unb64url(sig)).buffer,
			new TextEncoder().encode(body)
		)
		if (!valid) return null
		return JSON.parse(new TextDecoder().decode(unb64url(body))) as unknown
	} catch {
		return null
	}
}

const b64url = (data: Uint8Array): string =>
	btoa(String.fromCharCode(...data))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '')

const unb64url = (value: string): Uint8Array => {
	const padded = value.replace(/-/g, '+').replace(/_/g, '/')
	const pad = (4 - (padded.length % 4)) % 4
	return Uint8Array.from(atob(padded + '='.repeat(pad)), (c) => c.charCodeAt(0))
}
