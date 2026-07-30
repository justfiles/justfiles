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
// A REJECTED load is evicted (not cached) — a transient failure must not poison this
// Volume forever; the next call retries.
const memo = new WeakMap<Volume, Promise<string>>()

export function deviceId(vol: Volume): Promise<string> {
	let inflight = memo.get(vol)
	if (!inflight) {
		inflight = load(vol).catch((e) => {
			if (memo.get(vol) === inflight) memo.delete(vol)
			throw e
		})
		memo.set(vol, inflight)
	}
	return inflight
}

async function load(vol: Volume): Promise<string> {
	const uuid = (await vol.exists(CLIENTID_PATH)) ? await readUuid(vol) : await mint(vol)
	return shorten(uuid)
}

async function mint(vol: Volume): Promise<string> {
	const uuid = crypto.randomUUID()
	await vol.mkdir('/.state', { recursive: true })
	try {
		// Same encoding `persistedState` uses (JSON of a string) so a later `synced()`
		// on this volume reads back the id it would otherwise have minted itself.
		// `exclusive` makes this a CLAIM, not a probe: it closes the TOCTOU window
		// between the `exists` check above and this write, so a second Volume wrapper
		// over the SAME underlying storage racing to mint (e.g. `synced()` starting up
		// concurrently) can't silently overwrite the id this call already won.
		await vol.writeFile(CLIENTID_PATH, enc.encode(JSON.stringify(uuid)), { exclusive: true })
		return uuid
	} catch (e) {
		if (!(e as Error).message.startsWith('EEXIST')) throw e
		return awaitWinner(vol) // lost the mint race — the winner's write may still be in flight
	}
}

// The winner's dirent commits (atomicCreate) before its blob content does (`writeFile`
// is createNode THEN putBlob) — a loser that just lost the claim above can briefly see
// the path exist with no bytes yet. Poll a few event-loop turns; on every real backend
// the winner's `putBlob` lands well inside that window.
async function awaitWinner(vol: Volume): Promise<string> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await readUuid(vol)
		} catch (e) {
			if (attempt >= 50) throw e
			// A macrotask yield, not a microtask one: the winner's pending write can
			// itself be waiting on real async work (content hashing), which only
			// advances once the event loop turns, not by draining more microtasks.
			await new Promise((resolve) => setTimeout(resolve, 0))
		}
	}
}

async function readUuid(vol: Volume): Promise<string> {
	return JSON.parse(dec.decode(await vol.readFile(CLIENTID_PATH))) as string
}

// Deterministic, filename-safe, short: a uuid's hex digits are already lowercase, so
// dropping the hyphens and taking a prefix needs no re-encoding.
function shorten(uuid: string): string {
	return uuid.replace(/-/g, '').slice(0, 8)
}
