// The stable identity of THIS install, used to name per-device shards (sessions,
// journal, memory) so every file has exactly one writer and whole-file LWW can never
// destroy a peer's appends. Shares /.state/clientid with the sync layer (`synced()` in
// @justfiles/fs): an id that syncs would defeat the purpose, and /.state is host-private
// by construction, so this is the same file, not a second identity.
//
// Package-internal: not re-exported from index.ts. D2/D4/D5 shard naming are the only
// consumers (AGENTS.md — stingy interfaces).

import type { Volume } from '@justfiles/fs'

const CLIENTID_PATH = '/.state/clientid'

const enc = new TextEncoder()
const dec = new TextDecoder()

// Memoised per Volume instance; also single-flight — two concurrent first-calls over
// the same instance share one in-flight load, so the file is written at most once.
const memo = new WeakMap<Volume, Promise<string>>()

export function deviceId(vol: Volume): Promise<string> {
	let inflight = memo.get(vol)
	if (!inflight) {
		inflight = load(vol)
		memo.set(vol, inflight)
	}
	return inflight
}

async function load(vol: Volume): Promise<string> {
	const uuid = (await vol.exists(CLIENTID_PATH))
		? (JSON.parse(dec.decode(await vol.readFile(CLIENTID_PATH))) as string)
		: await mint(vol)
	return shorten(uuid)
}

async function mint(vol: Volume): Promise<string> {
	const uuid = crypto.randomUUID()
	await vol.mkdir('/.state', { recursive: true })
	// Same encoding `persistedState` uses (JSON of a string) so a later `synced()` on
	// this volume reads back the id it would otherwise have minted itself.
	await vol.writeFile(CLIENTID_PATH, enc.encode(JSON.stringify(uuid)))
	return uuid
}

// Deterministic, filename-safe, short: a uuid's hex digits are already lowercase, so
// dropping the hyphens and taking a prefix needs no re-encoding.
function shorten(uuid: string): string {
	return uuid.replace(/-/g, '').slice(0, 8)
}
