import { type Volume, volume } from '@justfiles/fs'
import { memStorage } from '@justfiles/fs/storage/mem'
import { describe, expect, test } from 'vitest'
import {
	type AppendPayload,
	type ContextMessage,
	type SessionEntry,
	session
} from './session.manager.ts'

function user(content: string): AppendPayload {
	return { type: 'message', role: 'user', content }
}

function assistant(content: string): AppendPayload {
	return { type: 'message', role: 'assistant', content }
}

function toolCall(tool_name: string, input: Record<string, unknown>): AppendPayload {
	return { type: 'message', role: 'tool_call', tool_name, input }
}

function toolResult(tool_name: string, content: string): AppendPayload {
	return { type: 'message', role: 'tool_result', tool_name, content }
}

function compactionPayload(summary: string, firstKeptEntryId: string): AppendPayload {
	return {
		type: 'compaction',
		summary,
		firstKeptEntryId,
		tokensBefore: 42
	}
}

async function makeManager(vol = volume(memStorage()), deviceId = 'aaaa1111') {
	return session(vol, {
		agentId: 'test',
		sessionId: 'sess0001',
		startTs: new Date('2026-07-26T09:00:00Z'),
		deviceId
	})
}

const SESSIONS = '/system/agents/test/sessions'

// A peer's shard, written directly: this is what arrives by sync, and this device must
// never write to it.
async function writeShard(vol: Volume, name: string, entries: object[]) {
	await vol.mkdir(SESSIONS, { recursive: true })
	await vol.writeFile(
		`${SESSIONS}/${name}`,
		new TextEncoder().encode(`${entries.map((e) => JSON.stringify(e)).join('\n')}\n`)
	)
}

function entry(over: Partial<SessionEntry> & { id: string }): SessionEntry {
	return {
		type: 'message',
		role: 'user',
		content: over.id,
		parentId: null,
		ts: '2026-07-26T09:00:00.000Z',
		...over
	} as SessionEntry
}

function stripContext(context: ReadonlyArray<ContextMessage>) {
	return context.map(({ role, content }) => ({ role, content }))
}

function expectSequentialBranch(entries: ReadonlyArray<SessionEntry>) {
	expect(entries[0]?.parentId ?? null).toBeNull()
	for (let i = 1; i < entries.length; i++) {
		expect(entries[i]?.parentId).toBe(entries[i - 1]?.id)
	}
}

describe('session manager', () => {
	test('appends along the active leaf and projects tool-heavy history into plain context', async () => {
		const manager = await makeManager()

		expect(manager.activeLeafId).toBeNull()
		expect(await manager.buildSessionContext()).toEqual([])

		const first = await manager.append([
			user('I need help planning a Kyoto trip.'),
			assistant('Happy to help. What kind of trip are you after?')
		])
		expect(first.compacted).toBe(false)
		const firstLeafId = manager.activeLeafId

		const second = await manager.append([
			user('Find a quiet ryokan with a private bath.'),
			toolCall('search_hotels', { city: 'Kyoto', bath: true }),
			toolResult('search_hotels', 'Three matching ryokans found.'),
			assistant('I found three ryokans that fit that request.')
		])
		expect(second.compacted).toBe(false)

		const branch = await manager.walkActiveBranch()
		expect(branch).toHaveLength(6)
		expectSequentialBranch(branch)
		expect(firstLeafId).toBe(branch[1]?.id)
		expect(manager.activeLeafId).toBe(branch[5]?.id)

		expect(branch.map((entry) => (entry.type === 'message' ? entry.role : entry.type))).toEqual([
			'user',
			'assistant',
			'user',
			'tool_call',
			'tool_result',
			'assistant'
		])

		const context = await manager.buildSessionContext()
		expect(stripContext(context)).toEqual([
			{ role: 'user', content: 'I need help planning a Kyoto trip.' },
			{ role: 'assistant', content: 'Happy to help. What kind of trip are you after?' },
			{ role: 'user', content: 'Find a quiet ryokan with a private bath.' },
			{ role: 'assistant', content: 'I found three ryokans that fit that request.' }
		])
		expect(context.every((message) => Number.isFinite(message.timestamp))).toBe(true)
	})

	test('accepts explicit compaction payloads in append', async () => {
		const manager = await makeManager()

		await manager.append([user('Original question'), assistant('Original answer')])

		const branchBefore = await manager.walkActiveBranch()
		const firstKeptEntryId = branchBefore[1]?.id
		expect(firstKeptEntryId).toBeDefined()
		if (!firstKeptEntryId) {
			throw new Error('expected the second branch entry to exist')
		}

		await manager.append([
			compactionPayload('Summary of the original exchange.', firstKeptEntryId),
			user('Follow-up question'),
			assistant('Follow-up answer')
		])

		const branch = await manager.walkActiveBranch()
		expect(branch.map((entry) => (entry.type === 'message' ? entry.role : entry.type))).toEqual([
			'user',
			'assistant',
			'compaction',
			'user',
			'assistant'
		])

		const context = await manager.buildSessionContext()
		expect(stripContext(context)).toEqual([
			{ role: 'assistant', content: 'Summary of the original exchange.' },
			{ role: 'assistant', content: 'Original answer' },
			{ role: 'user', content: 'Follow-up question' },
			{ role: 'assistant', content: 'Follow-up answer' }
		])
	})
})

// ── Cross-device shards (#300) ────────────────────────────────────────────
//
// The requirement: talk on the Mac, pick up on the iPad, see ONE lineage. Eventual
// consistency is fine; loss is not. Every test here is about the union of shards, because
// sharding is not the alternative to merging — it is the mechanism for it.
describe('session shards merge across devices', () => {
	test('append writes only this device’s shard and never touches a peer’s', async () => {
		const vol = volume(memStorage())
		const peer = '2026-07-26T09-00-00Z-sess0001.bbbb2222.jsonl'
		await writeShard(vol, peer, [entry({ id: 'peer0001' })])
		const before = await vol.stat(`${SESSIONS}/${peer}`)

		const manager = await makeManager(vol, 'aaaa1111')
		await manager.append([user('from this device')])

		// Byte-for-byte, not just "still parses": whole-file LWW means a single stray write
		// here is how a peer's history disappears.
		expect(await vol.readFile(`${SESSIONS}/${peer}`)).toEqual(
			new TextEncoder().encode(`${JSON.stringify(entry({ id: 'peer0001' }))}\n`)
		)
		expect((await vol.stat(`${SESSIONS}/${peer}`)).mtimeNs).toBe(before.mtimeNs)
		expect((await vol.readdir(SESSIONS)).map((d) => d.name).sort()).toEqual([
			'2026-07-26T09-00-00Z-sess0001.aaaa1111.jsonl',
			peer
		])
	})

	test('a lineage that spans two shards builds as one conversation', async () => {
		const vol = volume(memStorage())
		await writeShard(vol, '2026-07-26T09-00-00Z-sess0001.aaaa1111.jsonl', [
			entry({ id: 'aaaa0001', content: 'mac question', ts: '2026-07-26T09:00:00.000Z' }),
			entry({
				id: 'aaaa0002',
				role: 'assistant',
				content: 'mac answer',
				parentId: 'aaaa0001',
				ts: '2026-07-26T09:00:01.000Z'
			})
		])
		await writeShard(vol, '2026-07-26T09-00-00Z-sess0001.bbbb2222.jsonl', [
			entry({
				id: 'bbbb0001',
				content: 'ipad follow-up',
				parentId: 'aaaa0002',
				ts: '2026-07-26T09:05:00.000Z'
			})
		])

		const manager = await makeManager(vol, 'cccc3333')
		expect(stripContext(await manager.buildSessionContext())).toEqual([
			{ role: 'user', content: 'mac question' },
			{ role: 'assistant', content: 'mac answer' },
			{ role: 'user', content: 'ipad follow-up' }
		])
	})

	// A requirement test with TWO guards behind it, and worth naming: `readSession` unions
	// into an id-keyed Map, but `walkBranch` also indexes by id, so it would absorb a
	// duplicate on its own. Reverting the Map alone does NOT make this fail. Kept because a
	// grow-only set of immutable nodes should be REPRESENTED as a set at that boundary — not
	// because the walk is fragile without it.
	test('an entry present in two shards appears once', async () => {
		const vol = volume(memStorage())
		const dup = entry({ id: 'aaaa0001', content: 'said once' })
		await writeShard(vol, '2026-07-26T09-00-00Z-sess0001.aaaa1111.jsonl', [dup])
		// A replayed sync: the same immutable node, delivered twice.
		await writeShard(vol, '2026-07-26T09-00-00Z-sess0001.bbbb2222.jsonl', [dup])

		const manager = await makeManager(vol, 'cccc3333')
		expect(stripContext(await manager.buildSessionContext())).toEqual([
			{ role: 'user', content: 'said once' }
		])
	})

	// Zero coordination: two devices that never talk must land on the same leaf, so the
	// tie-break cannot be file order, mtime, or arrival order.
	test('two managers over the same shards agree on the leaf at equal timestamps', async () => {
		const vol = volume(memStorage())
		const root = entry({ id: 'aaaa0000', content: 'shared root' })
		const tie = '2026-07-26T09:09:09.000Z'
		await writeShard(vol, '2026-07-26T09-00-00Z-sess0001.aaaa1111.jsonl', [
			root,
			entry({ id: 'aaaa9999', content: 'mac turn', parentId: 'aaaa0000', ts: tie })
		])
		await writeShard(vol, '2026-07-26T09-00-00Z-sess0001.bbbb2222.jsonl', [
			entry({ id: 'bbbb0001', content: 'ipad turn', parentId: 'aaaa0000', ts: tie })
		])

		const one = await makeManager(vol, 'aaaa1111')
		const two = await makeManager(vol, 'bbbb2222')
		await one.buildSessionContext()
		await two.buildSessionContext()

		expect(one.activeLeafId).toBe(two.activeLeafId)
		// Highest id wins the tie, so the answer is nameable rather than merely consistent.
		expect(one.activeLeafId).toBe('bbbb0001')
	})

	// Concurrent turns are a real fork. The leaf rule decides what is on screen; it must not
	// decide what EXISTS.
	test('the losing branch stays readable even though it is off-context', async () => {
		const vol = volume(memStorage())
		await writeShard(vol, '2026-07-26T09-00-00Z-sess0001.aaaa1111.jsonl', [
			entry({ id: 'aaaa0000', content: 'shared root' }),
			entry({
				id: 'aaaa0001',
				content: 'mac branch',
				parentId: 'aaaa0000',
				ts: '2026-07-26T09:01:00.000Z'
			})
		])
		await writeShard(vol, '2026-07-26T09-00-00Z-sess0001.bbbb2222.jsonl', [
			entry({
				id: 'bbbb0001',
				content: 'ipad branch',
				parentId: 'aaaa0000',
				ts: '2026-07-26T09:02:00.000Z'
			})
		])

		const manager = await makeManager(vol, 'aaaa1111')
		const context = stripContext(await manager.buildSessionContext())
		expect(context).toEqual([
			{ role: 'user', content: 'shared root' },
			{ role: 'user', content: 'ipad branch' }
		])
		// Not merged, not lost: still on disk, and a later append can branch back to it.
		const raw = new TextDecoder().decode(
			await vol.readFile(`${SESSIONS}/2026-07-26T09-00-00Z-sess0001.aaaa1111.jsonl`)
		)
		expect(raw).toContain('mac branch')
	})

	// Order comes from parent pointers, so which file a node arrived in cannot matter. The
	// old implementation read `entries.at(-1)` and would have been at the mercy of this.
	test('context is identical whichever shard is read first', async () => {
		const shards: [string, object[]][] = [
			[
				'2026-07-26T09-00-00Z-sess0001.aaaa1111.jsonl',
				[
					entry({ id: 'aaaa0001', content: 'first', ts: '2026-07-26T09:00:00.000Z' }),
					entry({
						id: 'aaaa0002',
						role: 'assistant',
						content: 'second',
						parentId: 'aaaa0001',
						ts: '2026-07-26T09:00:01.000Z'
					})
				]
			],
			[
				'2026-07-26T09-00-00Z-sess0001.zzzz9999.jsonl',
				[
					entry({
						id: 'zzzz0001',
						content: 'third',
						parentId: 'aaaa0002',
						ts: '2026-07-26T09:00:02.000Z'
					})
				]
			]
		]
		const contexts: unknown[] = []
		// `readdir` returns whatever the backend's order is; writing in both orders is the
		// only way to prove the reader does not inherit it.
		for (const order of [shards, [...shards].reverse()]) {
			const vol = volume(memStorage())
			for (const [name, entries] of order) await writeShard(vol, name, entries)
			contexts.push(stripContext(await (await makeManager(vol, 'cccc3333')).buildSessionContext()))
		}
		expect(contexts[0]).toEqual(contexts[1])
		expect(contexts[0]).toEqual([
			{ role: 'user', content: 'first' },
			{ role: 'assistant', content: 'second' },
			{ role: 'user', content: 'third' }
		])
	})

	test('a compaction in one shard resolves for a branch that continues in another', async () => {
		const vol = volume(memStorage())
		await writeShard(vol, '2026-07-26T09-00-00Z-sess0001.aaaa1111.jsonl', [
			entry({ id: 'aaaa0001', content: 'ancient history', ts: '2026-07-26T09:00:00.000Z' }),
			entry({
				id: 'aaaa0002',
				content: 'kept turn',
				parentId: 'aaaa0001',
				ts: '2026-07-26T09:00:01.000Z'
			}),
			{
				type: 'compaction',
				id: 'aaaa0003',
				parentId: 'aaaa0002',
				ts: '2026-07-26T09:00:02.000Z',
				summary: 'we discussed Kyoto',
				firstKeptEntryId: 'aaaa0002',
				tokensBefore: 42
			}
		])
		await writeShard(vol, '2026-07-26T09-00-00Z-sess0001.bbbb2222.jsonl', [
			entry({
				id: 'bbbb0001',
				content: 'after the compaction, elsewhere',
				parentId: 'aaaa0003',
				ts: '2026-07-26T09:05:00.000Z'
			})
		])

		const manager = await makeManager(vol, 'cccc3333')
		expect(stripContext(await manager.buildSessionContext())).toEqual([
			{ role: 'assistant', content: 'we discussed Kyoto' },
			{ role: 'user', content: 'kept turn' },
			{ role: 'user', content: 'after the compaction, elsewhere' }
		])
	})

	// Two devices compacting independently is duplicated WORK, not corruption: each
	// compaction sits on its own branch, and the walk stops at the first one it meets.
	test('independent compactions on two branches leave both walks intact', async () => {
		const vol = volume(memStorage())
		const root = entry({ id: 'aaaa0000', content: 'root' })
		const shared = entry({
			id: 'aaaa0001',
			content: 'shared turn',
			parentId: 'aaaa0000',
			ts: '2026-07-26T09:00:01.000Z'
		})
		const compaction = (id: string, ts: string, summary: string) => ({
			type: 'compaction' as const,
			id,
			parentId: 'aaaa0001',
			ts,
			summary,
			firstKeptEntryId: 'aaaa0001',
			tokensBefore: 42
		})
		await writeShard(vol, '2026-07-26T09-00-00Z-sess0001.aaaa1111.jsonl', [
			root,
			shared,
			compaction('aaaa0002', '2026-07-26T09:01:00.000Z', 'mac summary')
		])
		await writeShard(vol, '2026-07-26T09-00-00Z-sess0001.bbbb2222.jsonl', [
			compaction('bbbb0002', '2026-07-26T09:02:00.000Z', 'ipad summary')
		])

		// The newer compaction is the leaf, and its walk is clean — the other summary does
		// not leak into it.
		const manager = await makeManager(vol, 'cccc3333')
		expect(stripContext(await manager.buildSessionContext())).toEqual([
			{ role: 'assistant', content: 'ipad summary' },
			{ role: 'user', content: 'shared turn' }
		])
	})

	// A transcript is appended on every turn and synced whole-file, so a torn line is cheap
	// to produce. It must cost its own entry and nothing more.
	test('a malformed line costs only itself, not its shard or its peers', async () => {
		const vol = volume(memStorage())
		await vol.mkdir(SESSIONS, { recursive: true })
		await vol.writeFile(
			`${SESSIONS}/2026-07-26T09-00-00Z-sess0001.aaaa1111.jsonl`,
			new TextEncoder().encode(
				`${JSON.stringify(entry({ id: 'aaaa0001', content: 'before the tear' }))}\n` +
					'{"type":"message","role":"user","con\n' +
					`${JSON.stringify(
						entry({
							id: 'aaaa0003',
							content: 'after the tear',
							parentId: 'aaaa0001',
							ts: '2026-07-26T09:00:02.000Z'
						})
					)}\n`
			)
		)
		await writeShard(vol, '2026-07-26T09-00-00Z-sess0001.bbbb2222.jsonl', [
			entry({
				id: 'bbbb0001',
				content: 'the peer is unaffected',
				parentId: 'aaaa0003',
				ts: '2026-07-26T09:05:00.000Z'
			})
		])

		const manager = await makeManager(vol, 'cccc3333')
		expect(stripContext(await manager.buildSessionContext())).toEqual([
			{ role: 'user', content: 'before the tear' },
			{ role: 'user', content: 'after the tear' },
			{ role: 'user', content: 'the peer is unaffected' }
		])
	})

	// The bug a plain `max by (ts, id)` would have shipped: `append` stamps a whole batch
	// with ONE timestamp, so the tie-break would pick a random hex id from the middle of the
	// turn and truncate it. Only leaves are candidates, so that is structurally impossible.
	// Reopened from disk, because that is where the leaf rule actually runs.
	test('a multi-entry turn sharing one timestamp keeps its whole lineage', async () => {
		const vol = volume(memStorage())
		await (await makeManager(vol)).append([
			user('plan my trip'),
			toolCall('search', { q: 'kyoto' }),
			toolResult('search', 'found'),
			assistant('here is a plan')
		])

		const reopened = await makeManager(vol)
		expect(stripContext(await reopened.buildSessionContext())).toEqual([
			{ role: 'user', content: 'plan my trip' },
			{ role: 'assistant', content: 'here is a plan' }
		])
		// All four entries share a `ts`; the leaf is the one nothing parents.
		const branch = await reopened.walkActiveBranch()
		expect(branch).toHaveLength(4)
		expect(new Set(branch.map((e) => e.ts)).size).toBe(1)
		expect(reopened.activeLeafId).toBe(branch.at(-1)?.id)
	})
})

// A host is long-lived: frieren's DO and the mac daemon build a manager once and keep it.
// Sync delivers a peer's shard AFTER that, so "merge on read" has to mean every read, not
// the first one.
describe('a long-lived manager keeps up with arriving shards', () => {
	test('a peer shard that lands after the first read advances the leaf', async () => {
		const vol = volume(memStorage())
		const manager = await makeManager(vol, 'aaaa1111')
		await manager.append([user('asked here')])
		const localLeaf = manager.activeLeafId as string

		// The sync tick: a peer's turn, continuing OUR lineage.
		await writeShard(vol, '2026-07-26T09-00-00Z-sess0001.bbbb2222.jsonl', [
			entry({
				id: 'bbbb0001',
				role: 'assistant',
				content: 'answered on the other device',
				parentId: localLeaf,
				ts: '2026-07-27T00:00:00.000Z'
			})
		])

		expect(stripContext(await manager.buildSessionContext())).toEqual([
			{ role: 'user', content: 'asked here' },
			{ role: 'assistant', content: 'answered on the other device' }
		])
		expect(manager.activeLeafId).toBe('bbbb0001')

		// And the next local turn continues that lineage rather than forking off the tip this
		// device happened to know about.
		await manager.append([user('and now back here')])
		const branch = await manager.walkActiveBranch()
		expect(branch.map((e) => ('content' in e ? e.content : e.type))).toEqual([
			'asked here',
			'answered on the other device',
			'and now back here'
		])
	})

	// The other half of the same rule, and the reason `append` must NOT refresh: a turn is
	// several appends (its messages, then a compaction node). A peer entry landing between
	// them must not splice itself into the middle of this device's turn.
	test('a peer arrival mid-turn does not splice into the local lineage', async () => {
		const vol = volume(memStorage())
		const manager = await makeManager(vol, 'aaaa1111')
		await manager.append([user('start of my turn'), assistant('my reply')])
		const myTail = manager.activeLeafId as string

		await writeShard(vol, '2026-07-26T09-00-00Z-sess0001.bbbb2222.jsonl', [
			entry({
				id: 'bbbb0001',
				content: 'a peer, mid-turn',
				parentId: null,
				// NEWER than the turn in progress — local appends stamp with the real clock, so a
				// fixed date here would lose the (ts, id) comparison and the test would pass even if
				// `append` did refresh. That is exactly what it happened to do at first.
				ts: new Date(Date.now() + 60_000).toISOString()
			})
		])

		// The compaction node belongs to MY turn, whatever arrived in the meantime.
		await manager.append([compactionPayload('summary of my turn', myTail)])

		// Asserted on what was WRITTEN, not on what a read returns: the peer's entry is newer,
		// so the active branch legitimately becomes the peer's (that is the leaf rule resolving a
		// fork). The invariant here is narrower and it is about the writer — an append continues
		// the lineage it is part of.
		const mine = await vol.readFile(`${SESSIONS}/2026-07-26T09-00-00Z-sess0001.aaaa1111.jsonl`)
		const written = new TextDecoder()
			.decode(mine)
			.trim()
			.split('\n')
			.map((l) => JSON.parse(l) as SessionEntry)
		const node = written.find((e) => e.type === 'compaction')
		expect(node?.parentId).toBe(myTail)
		expect(node?.parentId).not.toBe('bbbb0001')
	})

	// A reconnecting UI (frieren tab reload, mac daemon resnapshot) hits a WARM host, so
	// `history()` is a standalone read with no prompt behind it. It has to show the
	// conversation as it stands, or #300's headline — open the other device and see the same
	// conversation — fails on exactly the path a user takes.
	test('a standalone read shows a peer arrival without needing a prompt', async () => {
		const vol = volume(memStorage())
		const manager = await makeManager(vol, 'aaaa1111')
		await manager.append([user('asked here'), assistant('answered here')])

		await writeShard(vol, '2026-07-26T09-00-00Z-sess0001.bbbb2222.jsonl', [
			entry({
				id: 'bbbb0001',
				content: 'a peer turn, arriving by sync',
				parentId: manager.activeLeafId,
				ts: new Date(Date.now() + 60_000).toISOString()
			})
		])

		// No prompt, no rebuild, no restart.
		expect(
			(await manager.walkActiveBranch()).map((e) => ('content' in e ? e.content : e.type))
		).toEqual(['asked here', 'answered here', 'a peer turn, arriving by sync'])
	})

	// ...and deriving for display must not disturb the writer, or the compaction bug comes
	// back through the UI instead of through the compaction flow itself. A polling transcript
	// view is a read that can land at any moment, including mid-turn.
	test('a display read mid-turn does not steal the compaction', async () => {
		const vol = volume(memStorage())
		const manager = await makeManager(vol, 'aaaa1111')
		await manager.append([user('my question'), assistant('my reply')])
		const myTail = manager.activeLeafId as string

		await writeShard(vol, '2026-07-26T09-00-00Z-sess0001.bbbb2222.jsonl', [
			entry({
				id: 'bbbb0001',
				content: 'a peer, while I was mid-turn',
				parentId: null,
				ts: new Date(Date.now() + 60_000).toISOString()
			})
		])

		// The UI polls. It legitimately sees the peer's branch — that IS the active one now.
		expect(
			(await manager.walkActiveBranch()).map((e) => ('content' in e ? e.content : e.type))
		).toEqual(['a peer, while I was mid-turn'])

		// The writer is unmoved by that read.
		expect(manager.activeLeafId).toBe(myTail)
		await manager.append([compactionPayload('summary of my turn', myTail)])
		const written = new TextDecoder()
			.decode(await vol.readFile(`${SESSIONS}/2026-07-26T09-00-00Z-sess0001.aaaa1111.jsonl`))
			.trim()
			.split('\n')
			.map((l) => JSON.parse(l) as SessionEntry)
		expect(written.find((e) => e.type === 'compaction')?.parentId).toBe(myTail)
	})

	// The reviewer's sequence on #335, and the reason a read must not move the writer's cursor:
	// compaction reads the branch it is about to summarise, and that read sits BETWEEN the
	// turn's messages and the compaction node (assistant.ts). A peer arriving in that window
	// must not capture the compaction.
	test('a read between a turn and its compaction does not hand the compaction to a peer', async () => {
		const vol = volume(memStorage())
		const manager = await makeManager(vol, 'aaaa1111')
		await manager.append([user('my question'), assistant('my reply')])
		const myTail = manager.activeLeafId as string

		// Lands while the model was streaming — newer than the turn, so it WOULD win a refresh.
		await writeShard(vol, '2026-07-26T09-00-00Z-sess0001.bbbb2222.jsonl', [
			entry({
				id: 'bbbb0001',
				content: 'a peer, while I was mid-turn',
				parentId: null,
				ts: new Date(Date.now() + 60_000).toISOString()
			})
		])

		// What the compaction flow does: read the branch it is about to summarise — PINNED to the
		// append cursor, because it is about to append to it — then append the summary node.
		const branch = await manager.walkActiveBranch(manager.activeLeafId)
		expect(branch.map((e) => ('content' in e ? e.content : e.type))).toEqual([
			'my question',
			'my reply'
		])
		await manager.append([compactionPayload('summary of my turn', myTail)])

		const written = new TextDecoder()
			.decode(await vol.readFile(`${SESSIONS}/2026-07-26T09-00-00Z-sess0001.aaaa1111.jsonl`))
			.trim()
			.split('\n')
			.map((l) => JSON.parse(l) as SessionEntry)
		const compaction = written.find((e) => e.type === 'compaction')
		expect(compaction?.parentId).toBe(myTail)
		expect(compaction?.parentId).not.toBe('bbbb0001')
	})
})
