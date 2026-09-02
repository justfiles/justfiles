/**
 * In-process leased store for tests. Shares one mem store between local volume
 * writes and the peer-facing lease wrapper.
 */

import {
	leasedPeer,
	type LeasedStore,
	mutexLock,
	newSecret,
	type PushCursorProvider,
	type ReceiverClock,
	type ReceiverContext,
	type ReceiverState,
	type SyncLock
} from './lease'
import { memStore } from './mem'
import { DEFAULT_SYNC_POLICY, type SyncPolicy } from './sync-policy'
import type { Store } from './store'

export type MemLeased = {
	local: Store
	peer: LeasedStore
	state: ReceiverState
	clock: ReceiverClock & { advance(ms: number): void }
}

export function memLeased(opts?: {
	policy?: SyncPolicy
	lock?: SyncLock
	pushCursor?: PushCursorProvider
}): MemLeased {
	const local = memStore()
	const clock = fakeClock()
	const state: ReceiverState = {
		lineage: '',
		secret: newSecret(),
		feedFloor: 0,
		feedHead: 0,
		pendingFence: null
	}
	const ctx: ReceiverContext = {
		state,
		clock,
		lock: opts?.lock ?? mutexLock(),
		policy: opts?.policy ?? DEFAULT_SYNC_POLICY,
		pushCursor: opts?.pushCursor
	}
	const peer = leasedPeer(local, ctx)
	return { local, peer, state, clock }
}

const seedLineage = async (store: Store, state: ReceiverState): Promise<void> => {
	const page = await store.since()
	if (page.next === undefined) throw new Error('mem store must return a cursor')
	const sep = String.fromCharCode(0)
	const at = page.next.indexOf(sep)
	state.lineage = page.next.slice(0, at)
	state.feedHead = Number(page.next.slice(at + 1))
}

const fakeClock = (): ReceiverClock & { advance(ms: number): void } => {
	let at = 1_700_000_000_000
	return {
		now: () => at,
		tick: (now) => {
			at = Math.max(at, now)
		},
		advance: (ms) => {
			at += ms
		}
	}
}

/** Async setup: resolves lineage from the mem store feed head. */
export async function openMemLeased(opts?: Parameters<typeof memLeased>[0]): Promise<MemLeased> {
	const held = memLeased(opts)
	await seedLineage(held.local, held.state)
	return held
}
