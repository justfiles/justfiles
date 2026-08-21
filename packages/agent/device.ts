// The stable identity of THIS install, used to name per-device shards (sessions,
// journal, memory) so every file has exactly one writer and whole-file LWW can never
// destroy a peer's appends. It lives in the host's private mount because an id that
// syncs would defeat the purpose.
//
// `persistedState` owns the atomic first-write claim for this path.
//
// Package-internal: not re-exported from index.ts. D2/D4/D5 shard naming are the only
// consumers (AGENTS.md — stingy interfaces).

import type { Volume } from '@justfiles/fs'
import { type PersistedState, persistedState } from '@justfiles/fs/persistedState'

const CLIENTID_PATH = '/private/state/clientid'

// Memoised per Volume instance so repeated calls reuse the same cell (and its
// in-memory cache) instead of re-reading the file every time.
const cells = new WeakMap<Volume, PersistedState<string>>()

function cell(vol: Volume): PersistedState<string> {
	let c = cells.get(vol)
	if (!c) {
		c = persistedState<string>(vol, CLIENTID_PATH, () => crypto.randomUUID())
		cells.set(vol, c)
	}
	return c
}

export async function deviceId(vol: Volume): Promise<string> {
	return shorten(await cell(vol).get())
}

// Deterministic, filename-safe, short: a uuid's hex digits are already lowercase, so
// dropping the hyphens and taking a prefix needs no re-encoding.
function shorten(uuid: string): string {
	return uuid.replace(/-/g, '').slice(0, 8)
}
