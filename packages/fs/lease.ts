/**
 * Leased peer protocol above `Store`: signed feed cursors, write leases, and one
 * public stale answer — `BootstrapRequiredError`.
 */

import { type SyncPolicy, validateSyncPolicy } from './sync-policy'
import {
	type Cursor,
	forwarded,
	type Guard,
	type Hash,
	type Node,
	type Page,
	type Store
} from './store'

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

export type PushCursorProvider = () => Promise<number | undefined>

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
	open(saved?: Cursor): Promise<WriteLease>
	put(lease: WriteLease, hash: Hash, data: Uint8Array): Promise<void>
	since(cursor?: Cursor): Promise<Page>
	commit(lease: WriteLease, writes: Node[], guards?: Guard[]): Promise<void>
}

export type LeasedStore = Omit<Store, 'commit'> & LeasedPeer

export function leasedPeer(store: Store, ctx: ReceiverContext): LeasedStore {
	validateSyncPolicy(ctx.policy)
	const read = forwarded(store)

	return {
		...read,
		open: (saved) => open(store, ctx, saved),
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

async function open(_store: Store, ctx: ReceiverContext, saved?: Cursor): Promise<WriteLease> {
	const at = now(ctx)
	if (saved === undefined) reject()
	const claims = await readCursor(ctx, saved!, at)
	if (claims.mode !== 'resume') reject()
	return signLease(ctx.state.secret, {
		cursor: saved!,
		issuedAt: at,
		expiresAt: Math.min(at + ctx.policy.writeLeaseMs, claims.expiresAt)
	})
}

async function scan(store: Store, ctx: ReceiverContext, cursor?: Cursor): Promise<Page> {
	const at = now(ctx)
	let mode: CursorMode = 'bootstrap'
	let position = 0
	if (cursor !== undefined) {
		const claims = await readCursor(ctx, cursor, at)
		mode = claims.mode
		position = claims.position
		if (mode === 'resume' && claims.position < ctx.state.feedFloor) reject()
	}
	const page = await store.since(
		mode === 'bootstrap' && position === 0 ? undefined : rawCursor(ctx, position)
	)
	const nextPos = page.next === undefined ? ctx.state.feedHead : rawPosition(ctx, page.next)
	return {
		nodes: page.nodes,
		next: await signCursor(ctx.state.secret, {
			lineage: ctx.state.lineage,
			position: nextPos,
			issuedAt: at,
			expiresAt: at + ctx.policy.cursorLeaseMs,
			mode: nextPos >= ctx.state.feedHead ? 'resume' : mode
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
	const claims = await unpack<CursorClaims>(ctx.state.secret, token)
	if (claims === null) reject()
	const held = claims as CursorClaims
	if (held.lineage !== ctx.state.lineage) reject()
	if (held.expiresAt <= at) reject()
	if (held.position > ctx.state.feedHead) reject()
	return held
}

async function readLease(ctx: ReceiverContext, lease: WriteLease, at: number): Promise<void> {
	const claims = await unpack<LeaseClaims>(ctx.state.secret, lease)
	if (claims === null) reject()
	const held = claims as LeaseClaims
	if (held.expiresAt <= at) reject()
	await readCursor(ctx, held.cursor, at)
}

const rawCursor = (ctx: ReceiverContext, position: number): Cursor =>
	ctx.state.lineage + String.fromCharCode(0) + position

const rawPosition = (ctx: ReceiverContext, cursor: Cursor): number =>
	Number(cursor.slice(ctx.state.lineage.length + 1))

type CursorMode = 'resume' | 'bootstrap'

type CursorClaims = {
	lineage: string
	position: number
	issuedAt: number
	expiresAt: number
	mode: CursorMode
}

type LeaseClaims = { cursor: string; issuedAt: number; expiresAt: number }

const TOKEN = 'v1'

const signCursor = (secret: Uint8Array, claims: CursorClaims): Promise<string> => sign(secret, claims)
const signLease = (secret: Uint8Array, claims: LeaseClaims): Promise<string> => sign(secret, claims)

const sign = async (secret: Uint8Array, claims: object): Promise<string> => {
	const body = b64url(new TextEncoder().encode(JSON.stringify(claims)))
	return `${TOKEN}.${body}.${b64url(await hmac(secret, body))}`
}

const hmac = async (secret: Uint8Array, payload: string): Promise<Uint8Array> => {
	const key = await crypto.subtle.importKey(
		'raw',
		secret as BufferSource,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	)
	return new Uint8Array(
		await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload) as unknown as ArrayBuffer)
	)
}

const unpack = async <T>(secret: Uint8Array, token: string): Promise<T | null> => {
	const parts = token.split('.')
	if (parts.length !== 3 || parts[0] !== TOKEN) return null
	const [, body, sig] = parts as [string, string, string]
	const expected = b64url(await hmac(secret, body))
	if (sig.length !== expected.length) return null
	for (let i = 0; i < sig.length; i++) if (sig[i] !== expected[i]) return null
	try {
		return JSON.parse(new TextDecoder().decode(unb64url(body))) as T
	} catch {
		return null
	}
}

const b64url = (data: Uint8Array): string =>
	btoa(String.fromCharCode(...data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const unb64url = (value: string): Uint8Array => {
	const padded = value.replace(/-/g, '+').replace(/_/g, '/')
	const pad = (4 - (padded.length % 4)) % 4
	return Uint8Array.from(atob(padded + '='.repeat(pad)), (c) => c.charCodeAt(0))
}
