import type { Volume } from '@justfiles/fs'
import { file } from './file'
import { parseSessionShard, sessionShard, sessionsDir } from './paths'
import {
	type ContextMessage,
	type EntryId,
	type SessionEntry,
	SessionEntrySchema,
	type SessionManager
} from './session.manager'

function entryId(): EntryId {
	const bytes = new Uint8Array(4)
	crypto.getRandomValues(bytes)
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function walkBranch(entries: SessionEntry[], leafId: EntryId | null): SessionEntry[] {
	if (!leafId) return []
	const byId = new Map(entries.map((e) => [e.id, e]))
	const branch: SessionEntry[] = []
	let cur: EntryId | null = leafId
	while (cur) {
		const entry = byId.get(cur)
		if (!entry) break
		branch.push(entry)
		cur = entry.parentId ?? null
	}
	branch.reverse()
	return branch
}

// Newest-wins, with `id` as the tie-break so devices that never talk to each other still
// order identically. `ts` is ISO-8601 UTC throughout, so a lexical compare IS a
// chronological one.
function newer(a: SessionEntry, b: SessionEntry): SessionEntry {
	if (a.ts !== b.ts) return a.ts > b.ts ? a : b
	return a.id > b.id ? a : b
}

// The active leaf is the newest entry THAT NOTHING PARENTS — a leaf in the graph sense,
// not merely the newest entry.
//
// A plain `max by (ts, id)` looks equivalent and is not: `append` stamps every entry of a
// batch with ONE timestamp, so a user+tool_call+tool_result+assistant turn is four entries
// sharing a `ts`, and the tie-break would then pick whichever random hex id sorts highest
// — truncating the branch mid-turn. Restricting to leaves makes that impossible (only the
// last entry of a batch has no child) and reduces to exactly the old `entries.at(-1)` for a
// single device, without depending on file order.
//
// Concurrent turns on two devices are a real fork: several leaves, and (ts, id) decides
// which one is on screen. Nothing is lost — the other branch is still in the tree.
function activeLeaf(entries: SessionEntry[]): EntryId | null {
	const parented = new Set(entries.map((e) => e.parentId).filter((id) => id !== null))
	let leaf: SessionEntry | null = null
	for (const e of entries) {
		if (parented.has(e.id)) continue
		leaf = leaf ? newer(leaf, e) : e
	}
	return leaf?.id ?? null
}

// A half-written append is cheap to produce (a transcript is appended on every turn and
// synced whole-file), so ONE unparseable line must not cost the rest of the shard — let
// alone the other shards. Skipping is the conservative read: the tree is a set of
// independent nodes, so a lost line costs its own subtree and nothing else.
async function readShard(volume: Volume, path: string): Promise<SessionEntry[]> {
	const entries: SessionEntry[] = []
	for (const line of await file(volume, path).lines()) {
		try {
			entries.push(SessionEntrySchema.parse(JSON.parse(line)))
		} catch {
			// Skipped, deliberately. See above.
		}
	}
	return entries
}

async function listShards(volume: Volume, dir: string) {
	let names: string[]
	try {
		names = (await volume.readdir(dir)).map((d) => d.name)
	} catch {
		return []
	}
	return names.flatMap((name) => {
		const parsed = parseSessionShard(name)
		return parsed ? [{ ...parsed, path: `${dir}/${name}` }] : []
	})
}

// Union every shard of one session, deduped by entry id. Dedupe is safe BECAUSE entries
// are immutable: the same id in two shards (a replayed sync) is the same node, so keeping
// either copy keeps the same thing.
async function readSession(volume: Volume, dir: string, sessionId: string) {
	const shards = (await listShards(volume, dir)).filter((s) => s.sessionId === sessionId)
	const byId = new Map<EntryId, SessionEntry>()
	for (const shard of shards) {
		for (const entry of await readShard(volume, shard.path)) byId.set(entry.id, entry)
	}
	return [...byId.values()]
}

export type SessionRef = {
	agentId: string
	sessionId: string
	/** Shared across devices: the conversation's start, not this shard's. */
	startTs: Date
	deviceId: string
}

// The session this host should resume: the one whose NEWEST ENTRY is newest.
//
// Derived, not recorded. A `sessions.json` pointer has one writer per device, so two hosts
// clobber each other's idea of "current" and the loser's transcript is orphaned; deriving
// removes the contention instead of arbitrating it. Entry `ts` is the clock, NOT file mtime
// — mtime is when a file was last written (sync rewrites it), not when the conversation
// happened.
//
// Cost: this reads every transcript in the directory (#334 — filed, not forgotten). Both
// cheap filters are unsound: the filename records the START (a long conversation outlives a
// shorter later one) and mtime is last-WRITE on a cross-device clock. A correct answer
// first; #334 makes it a tail read.
export async function currentSession(
	volume: Volume,
	agentId: string
): Promise<{ sessionId: string; startTs: Date; newestTs: string } | null> {
	const dir = sessionsDir(agentId)
	const grouped = new Map<string, { starts: Date[]; entries: SessionEntry[] }>()
	for (const shard of await listShards(volume, dir)) {
		let group = grouped.get(shard.sessionId)
		if (!group) {
			group = { starts: [], entries: [] }
			grouped.set(shard.sessionId, group)
		}
		if (shard.startTs) group.starts.push(shard.startTs)
		group.entries.push(...(await readShard(volume, shard.path)))
	}

	let best: { sessionId: string; startTs: Date; newest: SessionEntry } | null = null
	for (const [sessionId, group] of grouped) {
		const newest = group.entries.reduce<SessionEntry | null>((a, e) => (a ? newer(a, e) : e), null)
		// An empty session cannot be the newest — and has no entry to date it by.
		if (!newest) continue
		// A pre-timestamp `<id>.jsonl` carries no start, so take it from the conversation
		// itself: continuing it then names the new shard for when it really began.
		const startTs = group.starts.length
			? new Date(Math.min(...group.starts.map((d) => d.getTime())))
			: new Date(group.entries.reduce((a, e) => (e.ts < a.ts ? e : a), newest).ts)
		if (!best || newer(best.newest, newest) === newest) best = { sessionId, startTs, newest }
	}
	return best
		? { sessionId: best.sessionId, startTs: best.startTs, newestTs: best.newest.ts }
		: null
}

export function session(volume: Volume, ref: SessionRef): SessionManager {
	const dir = sessionsDir(ref.agentId)
	// Appends go HERE and nowhere else. A peer's shard is read-only to this device, and that
	// single-writer rule is what makes whole-file LWW harmless.
	const ownShard = file(volume, sessionShard(ref.agentId, ref.sessionId, ref.startTs, ref.deviceId))
	let activeLeafId: EntryId | null = null
	let initialized = false

	async function init(): Promise<void> {
		if (initialized) return
		initialized = true
		activeLeafId = activeLeaf(await readSession(volume, dir, ref.sessionId))
	}

	async function appendEntries(entries: SessionEntry[]): Promise<void> {
		const lines = `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`
		await ownShard.append(lines)
	}

	const mgr: SessionManager = {
		sessionId: ref.sessionId,
		get activeLeafId() {
			return activeLeafId
		},

		async append(payloads) {
			await init()

			const now = new Date().toISOString()
			const newEntries: SessionEntry[] = []
			let parentId = activeLeafId

			for (const p of payloads) {
				const entry = { ...p, id: entryId(), parentId, ts: now } as SessionEntry
				newEntries.push(entry)
				parentId = entry.id
			}

			await appendEntries(newEntries)
			const lastEntry = newEntries.at(-1)
			if (lastEntry) activeLeafId = lastEntry.id
			return { compacted: false }
		},

		async buildSessionContext() {
			await init()
			const all = await readSession(volume, dir, ref.sessionId)
			const branch = walkBranch(all, activeLeafId)
			const messages: ContextMessage[] = []

			let startIdx = 0
			for (let i = branch.length - 1; i >= 0; i--) {
				const c = branch[i]
				if (c?.type === 'compaction') {
					messages.push({ role: 'assistant', content: c.summary, timestamp: Date.parse(c.ts) })
					const keptIdx = branch.findIndex((e) => e.id === c.firstKeptEntryId)
					startIdx = keptIdx >= 0 ? keptIdx : i + 1
					break
				}
			}

			for (let i = startIdx; i < branch.length; i++) {
				const e = branch[i]
				if (e?.type !== 'message') continue
				if (e.role === 'user')
					messages.push({ role: 'user', content: e.content, timestamp: Date.parse(e.ts) })
				else if (e.role === 'assistant')
					messages.push({ role: 'assistant', content: e.content, timestamp: Date.parse(e.ts) })
			}

			return messages
		},

		async walkActiveBranch() {
			await init()
			const all = await readSession(volume, dir, ref.sessionId)
			return walkBranch(all, activeLeafId)
		},
		branch() {
			throw new Error('not implemented')
		},
		branchWithSummary() {
			throw new Error('not implemented')
		},
		fork() {
			throw new Error('not implemented')
		}
	}

	return mgr
}
