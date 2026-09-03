import type { Cursor, Store } from './store'
import type { SyncStateLock } from './syncState'

export type ReceiverState = {
	issuer: string
	lineage: string
	signingSecret: string
	feedHead: number
	feedFloor: number
	maxOfflineMs: number
}

export type ReceiverBackend = {
	state(): Promise<ReceiverState>
	observe(now: number): Promise<number>
	cursor(position: number): Cursor
	position(cursor: Cursor): number
	lock?: SyncStateLock
}

export const receiverBackend = Symbol('receiver backend')

export type SyncCursor = { load(): Promise<Cursor | undefined> }

export const syncCursor = Symbol('sync cursor')

type SyncStore = Store & { [syncCursor]?: (cursor: SyncCursor) => Store }

export const withSyncCursor = (store: Store, cursor: SyncCursor): Store =>
	(store as SyncStore)[syncCursor]?.(cursor) ?? store

export const readCursorIssuer = (cursor: Cursor): string | undefined => {
	try {
		const payload = cursor.split('.')[0]
		if (!payload) throw new Error()
		const claims = JSON.parse(new TextDecoder().decode(unbase64url(payload))) as {
			issuer?: unknown
		}
		if (typeof claims.issuer !== 'string') throw new Error()
		return claims.issuer
	} catch {
		return undefined
	}
}

const unbase64url = (value: string): Uint8Array => {
	const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
	const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
	return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}
