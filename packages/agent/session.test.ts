import type { StreamFn } from '@earendil-works/pi-agent-core'
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model
} from '@earendil-works/pi-ai'
import { volume } from '@justfiles/fs'
import { memStorage } from '@justfiles/fs/storage/mem'
import { describe, expect, test } from 'vitest'
import { SOUL_PATH } from './agent-defaults.ts'
import type { AgentBackend } from './llm.ts'
import { parseSessionShard, sessionShard } from './paths.ts'
import type { SessionEntry } from './session.manager.ts'
import { createAgentSession, type SessionEvent } from './session.ts'

const encoder = new TextEncoder()

// A full AssistantMessage with the given content blocks. `stopReason`/`errorMessage` are
// overridable so a test can script an error turn or a tool-call turn.
function assistant(
	content: AssistantMessage['content'],
	over: Partial<AssistantMessage> = {}
): AssistantMessage {
	return {
		role: 'assistant',
		content,
		api: 'test',
		provider: 'test',
		model: 'test',
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
		},
		stopReason: 'stop',
		timestamp: Date.now(),
		...over
	}
}

// A credential-sealed backend whose stream returns the scripted assistant messages one per
// turn-step (so a tool-call message + a follow-up text message drive a full ask_user turn).
// `complete` backs the text helper (compaction notes / memory consolidation).
// `seen` records the context handed to the model on each call — the only way to assert what
// the model actually got, rather than what we hoped it got.
function scriptedBackend(
	messages: AssistantMessage[],
	complete = '',
	hooks: {
		// The context handed to the model on each call — the only way to assert what the model
		// actually got, rather than what we hoped it got.
		seen?: unknown[]
		// Runs before a turn's stream is produced, so a test can land a peer's shard exactly
		// where sync would: mid-turn, after the context was built and before it is persisted.
		beforeStream?: (call: number) => Promise<void>
		// `shouldCompact` reads it off the model; without one the comparison is NaN and
		// compaction never fires.
		contextWindow?: number
		// Fires per `completeFn` call — the LLM work behind takeNotes/compaction summaries.
		onComplete?: () => void
	} = {}
) {
	const queue = [...messages]
	let calls = 0
	const streamFn: StreamFn = async (_model, context) => {
		hooks.seen?.push(context)
		await hooks.beforeStream?.(++calls)
		const stream = createAssistantMessageEventStream()
		const message = queue.shift() ?? assistant([])
		stream.push({ type: 'done', reason: 'stop', message })
		stream.end(message)
		return stream
	}
	const completeFn: AgentBackend['completeFn'] = async () => {
		hooks.onComplete?.()
		return assistant(complete ? [{ type: 'text', text: complete }] : [])
	}
	return {
		model: { id: 'test', contextWindow: hooks.contextWindow } as Model<Api>,
		streamFn,
		completeFn,
		revision: 'r1'
	} satisfies AgentBackend
}

const NO_COMPACTION = { enabled: false, reserveTokens: 0, keepRecentTokens: 0 }

describe('createAgentSession', () => {
	test('runs a turn: broadcasts busy + transcript and returns the answer', async () => {
		const events: SessionEvent[] = []
		const session = createAgentSession({
			volume: volume(memStorage()),
			backend: scriptedBackend([assistant([{ type: 'text', text: 'Hi there' }])]),
			compaction: NO_COMPACTION
		})
		session.subscribe((event) => events.push(event))

		await expect(session.prompt('hello')).resolves.toBe('Hi there')

		expect(events.map((event) => event.type)).toEqual(['busy', 'transcript', 'busy'])
		expect(events[0]).toEqual({ type: 'busy', value: true })
		expect(events.at(-1)).toEqual({ type: 'busy', value: false })
		const transcript = events.find((event) => event.type === 'transcript')
		expect(transcript?.type === 'transcript' && transcript.entries).toMatchObject([
			{ role: 'user', content: 'hello' },
			{ role: 'assistant', content: 'Hi there' }
		])
	})

	test('an ask_user turn pings a question notification', async () => {
		const notifications: { kind: string; body: string; route?: unknown }[] = []
		const session = createAgentSession({
			volume: volume(memStorage()),
			backend: scriptedBackend([
				assistant([
					{
						type: 'toolCall',
						id: 't1',
						name: 'ask_user',
						arguments: { question: 'Tea or coffee?', options: ['tea', 'coffee'] }
					}
				]),
				assistant([{ type: 'text', text: 'waiting' }])
			]),
			compaction: NO_COMPACTION,
			notify: (n) => notifications.push({ kind: n.kind, body: n.body, route: n.route })
		})

		await session.prompt('help me choose')

		expect(notifications).toHaveLength(1)
		expect(notifications[0]).toMatchObject({ kind: 'question', body: 'Tea or coffee?' })
	})

	test('a turn ping carries the reply without its expression tags', async () => {
		const notifications: { kind: string; body: string }[] = []
		const session = createAgentSession({
			volume: volume(memStorage()),
			expressions: true,
			backend: scriptedBackend([
				assistant([{ type: 'text', text: '[concerned]Stop writes. [curious]Restore from 04:00?' }])
			]),
			compaction: NO_COMPACTION,
			notify: (n) => notifications.push({ kind: n.kind, body: n.body })
		})

		await session.prompt('I dropped the table')

		expect(notifications[0]).toMatchObject({
			kind: 'info',
			body: 'Stop writes. Restore from 04:00?'
		})
	})

	// The tag words are ordinary English, so a host that never asked for the channel must
	// keep its text verbatim rather than have a bracket silently deleted.
	test('a host without expressions keeps a literal bracket in the ping', async () => {
		const notifications: { body: string }[] = []
		const session = createAgentSession({
			volume: volume(memStorage()),
			backend: scriptedBackend([
				assistant([{ type: 'text', text: '[thinking] is the tag you asked about.' }])
			]),
			compaction: NO_COMPACTION,
			notify: (n) => notifications.push({ body: n.body })
		})

		await session.prompt('which tag means reflection?')

		expect(notifications[0]?.body).toBe('[thinking] is the tag you asked about.')
	})

	test('a classified failure emits an error event routed to Accounts', async () => {
		const events: SessionEvent[] = []
		const notifications: { kind: string }[] = []
		const session = createAgentSession({
			volume: volume(memStorage()),
			backend: scriptedBackend([
				assistant([], { stopReason: 'error', errorMessage: '401 Unauthorized' })
			]),
			compaction: NO_COMPACTION,
			notify: (n) => notifications.push({ kind: n.kind })
		})
		session.subscribe((event) => events.push(event))

		await expect(session.prompt('hello')).resolves.toBe('')

		const error = events.find((event) => event.type === 'error')
		expect(error?.type === 'error' && error.route).toEqual({ kind: 'settings', pane: 'accounts' })
		expect(notifications).toEqual([{ kind: 'error' }])
	})

	test('newSession clears the transcript', async () => {
		const vol = volume(memStorage())
		const session = createAgentSession({
			volume: vol,
			backend: scriptedBackend([assistant([{ type: 'text', text: 'first' }])]),
			compaction: NO_COMPACTION
		})
		await session.prompt('hello')
		expect((await session.history()).length).toBeGreaterThan(0)

		const events: SessionEvent[] = []
		session.subscribe((event) => events.push(event))
		await session.newSession()

		expect(events).toContainEqual({ type: 'transcript', entries: [] })
		expect(await session.history()).toEqual([])
	})

	test('applySkill loads a Volume skill and runs it as a turn', async () => {
		const vol = volume(memStorage())
		await vol.mkdir('/system/skills', { recursive: true })
		await vol.writeFile(
			'/system/skills/greet.md',
			encoder.encode('---\nname: Greet\ndescription: say hi\n---\nGreet the user warmly.')
		)
		const session = createAgentSession({
			volume: vol,
			backend: scriptedBackend([assistant([{ type: 'text', text: 'Hello!' }])]),
			compaction: NO_COMPACTION
		})

		expect((await session.listSkills()).map((skill) => skill.id)).toEqual(['greet'])
		await expect(session.applySkill('greet')).resolves.toBe('Hello!')
	})

	test('runMaintenance consolidates yesterday notes into memory', async () => {
		const vol = volume(memStorage())
		const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
		await vol.mkdir('/system/memory/daily', { recursive: true })
		await vol.writeFile(`/system/memory/daily/${yesterday}.md`, encoder.encode('- user likes tea'))
		const session = createAgentSession({
			volume: vol,
			backend: scriptedBackend([], 'user prefers tea'),
			compaction: NO_COMPACTION
		})

		await session.runMaintenance()

		const memory = new TextDecoder().decode(await vol.readFile('/system/memory/core.md'))
		expect(memory).toContain('user prefers tea')
	})

	test('nextMaintenanceAt returns 4am in the configured timezone', async () => {
		const session = createAgentSession({
			volume: volume(memStorage()),
			backend: scriptedBackend([]),
			timezone: () => 'UTC'
		})
		const now = new Date('2026-07-05T10:00:00Z')
		const at = await session.nextMaintenanceAt(now)
		// 4am UTC has passed at 10:00, so it schedules the next day's 4am.
		expect(at).toBe(new Date('2026-07-06T04:00:00Z').getTime())
	})

	// The transcript file names itself for when the conversation started, so `ls` IS the
	// chronological index the agent searches (#284 §8) — and for the device that owns it, so it
	// has exactly one writer and sync's whole-file LWW cannot destroy a peer's turns (#300).
	test('a fresh transcript is named for its start time and this device', async () => {
		const vol = volume(memStorage())
		const session = createAgentSession({
			volume: vol,
			backend: scriptedBackend([assistant([{ type: 'text', text: 'hi' }])]),
			compaction: NO_COMPACTION
		})
		await session.prompt('hello')

		const names = (await vol.readdir('/system/agents/main/sessions'))
			.map((entry) => entry.name)
			.filter((name) => name.endsWith('.jsonl'))
		expect(names).toHaveLength(1)
		expect(names[0]).toMatch(
			/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-[0-9a-f]{8}\.[0-9a-f]{8}\.jsonl$/
		)
	})

	// No migration (#284 §8's precedent): a pre-timestamp `<id>.jsonl` is read as a shard with
	// no device suffix, so it keeps loading with `sessions.json` GONE — which matters, because
	// deriving the current session is the only thing that finds it now.
	test('an old-style transcript still loads without a sessions map', async () => {
		const vol = volume(memStorage())
		await vol.mkdir('/system/agents/main/sessions', { recursive: true })
		await vol.writeFile(
			'/system/agents/main/sessions/abcd1234.jsonl',
			encoder.encode(
				`${JSON.stringify({
					type: 'message',
					role: 'user',
					content: 'earlier question',
					id: 'aaaaaaaa',
					parentId: null,
					ts: new Date().toISOString()
				})}\n`
			)
		)

		const session = createAgentSession({
			volume: vol,
			backend: scriptedBackend([assistant([{ type: 'text', text: 'hi' }])]),
			compaction: NO_COMPACTION
		})
		expect((await session.history()).map((entry) => 'content' in entry && entry.content)).toContain(
			'earlier question'
		)
	})

	// A leftover map from before #300 is data, not instruction. It must not be consulted (its
	// pointer may name a session that is no longer newest) and must not be rewritten — writing
	// it is what two hosts used to clobber.
	test('a leftover sessions.json is ignored and never rewritten', async () => {
		const vol = volume(memStorage())
		const dir = '/system/agents/main/sessions'
		await vol.mkdir(dir, { recursive: true })
		const stale = encoder.encode(
			JSON.stringify({
				'agent:main': {
					sessionId: 'ffffffff',
					lastActive: new Date().toISOString(),
					sessionFile: `${dir}/nonexistent.jsonl`
				}
			})
		)
		await vol.writeFile(`${dir}/sessions.json`, stale)

		const session = createAgentSession({
			volume: vol,
			backend: scriptedBackend([assistant([{ type: 'text', text: 'hi' }])]),
			compaction: NO_COMPACTION
		})
		await session.prompt('hello')

		expect(await vol.readFile(`${dir}/sessions.json`)).toEqual(stale)
		// The turn went to a real shard, not to the path the stale map named.
		const names = (await vol.readdir(dir)).map((e) => e.name).filter((n) => n.endsWith('.jsonl'))
		expect(names).toHaveLength(1)
		expect(names[0]).not.toContain('ffffffff')
	})

	// Which session is current is DERIVED from the transcripts: the one whose newest ENTRY is
	// newest. Not the filename (it records the START, and a long conversation outlives a
	// short later one) and not mtime (that is last-WRITE — sync rewrites a file long after the
	// conversation in it ended). Here both wrong clocks point elsewhere.
	test('the current session is the one with the newest entry, not the newest name or mtime', async () => {
		const vol = volume(memStorage())
		const dir = '/system/agents/main/sessions'
		await vol.mkdir(dir, { recursive: true })
		const line = (id: string, ts: string) =>
			encoder.encode(
				`${JSON.stringify({ type: 'message', role: 'user', content: id, id, parentId: null, ts })}\n`
			)
		const recent = new Date(Date.now() - 60_000).toISOString()
		const ancient = '2020-01-01T00:00:00.000Z'

		// Sorts FIRST by name, holds the newest entry.
		await vol.writeFile(`${dir}/2026-01-01T00-00-00Z-aaaaaaaa.dddd0001.jsonl`, line('aaaa', recent))
		// Sorts LAST by name and written LAST, so it wins both wrong clocks — and is ancient.
		await vol.writeFile(
			`${dir}/2026-12-31T00-00-00Z-zzzzzzzz.dddd0001.jsonl`,
			line('zzzz', ancient)
		)

		const session = createAgentSession({
			volume: vol,
			backend: scriptedBackend([assistant([{ type: 'text', text: 'hi' }])]),
			compaction: NO_COMPACTION
		})

		expect((await session.history()).map((e) => 'content' in e && e.content)).toEqual(['aaaa'])
	})

	// The live half of #300, and the one the automated suite nearly missed: a host is
	// long-lived (`getBuilt` memoises the assistant across turns), so the peer's shard arrives
	// while an assistant is ALREADY running. Its in-memory messages are a cache of the
	// transcript, so the turn boundary has to refresh them — otherwise this device neither shows
	// nor continues the peer's newer lineage until it is restarted.
	//
	// The peer's shard here holds a COMPLETE turn, which is what a synced device normally has.
	// Worth knowing about the other case: if a peer's newest entry is an unanswered USER
	// message, pi's agent loop treats the trailing user message as a draft and replaces it with
	// this turn's prompt, so the model does not see that question. The transcript keeps it and
	// the new turn still parents onto it, so nothing is lost and the lineage is right — and two
	// consecutive user messages is a shape most APIs reject anyway.
	test('an already-running assistant picks up a peer turn on its next prompt', async () => {
		const vol = volume(memStorage())
		const seen: unknown[] = []
		const session = createAgentSession({
			volume: vol,
			backend: scriptedBackend(
				[
					assistant([{ type: 'text', text: 'first reply' }]),
					assistant([{ type: 'text', text: 'second reply' }])
				],
				'',
				{ seen }
			),
			compaction: NO_COMPACTION
		})
		await session.prompt('my first question')

		// The sync tick, landing mid-life: a peer continues the conversation from our reply.
		const dir = '/system/agents/main/sessions'
		const mine = (await vol.readdir(dir)).map((e) => e.name).find((n) => n.endsWith('.jsonl'))
		const parsed = new TextDecoder()
			.decode(await vol.readFile(`${dir}/${mine}`))
			.trim()
			.split('\n')
			.map((l) => JSON.parse(l))
		// Built through the real parser/writer rather than string surgery, so the peer's shard
		// groups under the same session exactly as a synced one would.
		const shard = parseSessionShard(mine as string)
		await vol.writeFile(
			sessionShard('main', shard?.sessionId as string, shard?.startTs as Date, 'bbbb2222'),
			new TextEncoder().encode(
				`${JSON.stringify({
					type: 'message',
					role: 'user',
					content: 'asked from the other device',
					id: 'bbbb0001',
					parentId: parsed.at(-1).id,
					ts: new Date().toISOString()
				})}\n${JSON.stringify({
					type: 'message',
					role: 'assistant',
					content: 'answered on the other device',
					id: 'bbbb0002',
					parentId: 'bbbb0001',
					ts: new Date().toISOString()
				})}\n`
			)
		)

		await session.prompt('my second question')

		// What the MODEL was given on the second turn — not merely what the transcript holds.
		// A peer's whole turn, in place, between this device's two turns.
		expect(
			(seen.at(-1) as { messages: { content: unknown }[] }).messages.map((m) =>
				typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
			)
		).toEqual([
			'my first question',
			'[{"type":"text","text":"first reply"}]',
			'asked from the other device',
			'[{"type":"text","text":"answered on the other device"}]',
			'[{"type":"text","text":"my second question"}]'
		])

		// And the merged lineage is one conversation, in order.
		expect((await session.history()).map((e) => ('content' in e ? e.content : e.type))).toEqual([
			'my first question',
			'first reply',
			'asked from the other device',
			'answered on the other device',
			'my second question',
			'second reply'
		])
	})

	// The reconnect path: a warm host (`getBuilt` memoises the assistant) serving a transcript
	// snapshot to a UI that just reconnected. No prompt is involved, so this must not depend on
	// the turn boundary — otherwise reopening the tab shows a conversation missing the turn the
	// other device just had, which is the exact promise of #300.
	test('history shows a peer turn on a warm host with no prompt in between', async () => {
		const vol = volume(memStorage())
		const session = createAgentSession({
			volume: vol,
			backend: scriptedBackend([assistant([{ type: 'text', text: 'answered here' }])]),
			compaction: NO_COMPACTION
		})
		await session.prompt('asked here')

		const dir = '/system/agents/main/sessions'
		const mine = (await vol.readdir(dir)).map((e) => e.name).find((n) => n.endsWith('.jsonl'))
		const lines = new TextDecoder()
			.decode(await vol.readFile(`${dir}/${mine}`))
			.trim()
			.split('\n')
			.map((l) => JSON.parse(l))
		const shard = parseSessionShard(mine as string)
		await vol.writeFile(
			sessionShard('main', shard?.sessionId as string, shard?.startTs as Date, 'bbbb2222'),
			new TextEncoder().encode(
				`${JSON.stringify({
					type: 'message',
					role: 'user',
					content: 'a peer turn, arriving by sync',
					id: 'bbbb0001',
					parentId: lines.at(-1).id,
					ts: new Date(Date.now() + 60_000).toISOString()
				})}\n`
			)
		)

		expect((await session.history()).map((e) => ('content' in e ? e.content : e.type))).toEqual([
			'asked here',
			'answered here',
			'a peer turn, arriving by sync'
		])
	})

	// The assistant-level wiring of the pinned compaction read. Without a test here, the
	// `session.activeLeafId` argument in assistant.ts could be "simplified" away and every
	// other test would still pass — the manager-level test only proves the manager honours
	// the argument, not that the caller passes it.
	test('compaction after a peer arrives mid-turn stays on the local branch', async () => {
		const vol = volume(memStorage())
		const dir = '/system/agents/main/sessions'

		// Lands while the model is streaming turn 2: after that turn's context was built, before
		// its entries are persisted — precisely the window the compaction read sits in.
		const landPeerShard = async (call: number) => {
			if (call !== 2) return
			const mine = (await vol.readdir(dir)).map((e) => e.name).find((n) => n.endsWith('.jsonl'))
			const shard = parseSessionShard(mine as string)
			await vol.writeFile(
				sessionShard('main', shard?.sessionId as string, shard?.startTs as Date, 'bbbb2222'),
				encoder.encode(
					`${JSON.stringify({
						type: 'message',
						role: 'user',
						content: 'a peer, while I was streaming',
						id: 'bbbb0001',
						parentId: null,
						ts: new Date(Date.now() + 60_000).toISOString()
					})}\n`
				)
			)
		}

		const busy = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 5000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
		}
		const session = createAgentSession({
			volume: vol,
			backend: scriptedBackend(
				[
					assistant([{ type: 'text', text: 'first reply' }]),
					// Only this turn reports enough tokens to trigger compaction.
					assistant([{ type: 'text', text: 'second reply' }], { usage: busy })
				],
				'a summary of the local conversation',
				{ beforeStream: landPeerShard, contextWindow: 1000 }
			),
			compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 }
		})

		await session.prompt('first question')
		await session.prompt('second question')

		const mine = (await vol.readdir(dir))
			.map((e) => e.name)
			.find((n) => n.includes('bbbb2222') === false && n.endsWith('.jsonl')) as string
		const written = new TextDecoder()
			.decode(await vol.readFile(`${dir}/${mine}`))
			.trim()
			.split('\n')
			.map((l) => JSON.parse(l) as SessionEntry)
		const node = written.find((e) => e.type === 'compaction')
		const localTail = written.filter((e) => e.type === 'message').at(-1)

		expect(node).toBeDefined()
		expect(node?.parentId).toBe(localTail?.id)
		expect(node?.parentId).not.toBe('bbbb0001')
	})

	// The payload of #300: pick up on another device. A peer's shard is on disk (it arrived by
	// sync); this host must continue that SESSION — a new shard of its own, parented into the
	// foreign one — rather than starting a fresh conversation.
	test('a turn continues a session another device started', async () => {
		const vol = volume(memStorage())
		const dir = '/system/agents/main/sessions'
		const peer = `${dir}/2026-07-26T09-00-00Z-5e551011.bbbb2222.jsonl`
		await vol.mkdir(dir, { recursive: true })
		const ts = new Date(Date.now() - 60_000).toISOString()
		await vol.writeFile(
			peer,
			encoder.encode(
				`${JSON.stringify({ type: 'message', role: 'user', content: 'asked on the mac', id: 'aaaa0001', parentId: null, ts })}\n${JSON.stringify(
					{
						type: 'message',
						role: 'assistant',
						content: 'answered on the mac',
						id: 'aaaa0002',
						parentId: 'aaaa0001',
						ts
					}
				)}\n`
			)
		)

		const session = createAgentSession({
			volume: vol,
			backend: scriptedBackend([assistant([{ type: 'text', text: 'continued here' }])]),
			compaction: NO_COMPACTION
		})
		await session.prompt('following up on the ipad')

		// One lineage, spanning both shards.
		expect((await session.history()).map((e) => 'content' in e && e.content)).toEqual([
			'asked on the mac',
			'answered on the mac',
			'following up on the ipad',
			'continued here'
		])

		// A NEW shard, sharing the session id and start stamp, and the peer's file is untouched.
		const names = (await vol.readdir(dir)).map((e) => e.name).sort()
		expect(names).toHaveLength(2)
		expect(names.every((n) => n.startsWith('2026-07-26T09-00-00Z-5e551011.'))).toBe(true)
		expect(new TextDecoder().decode(await vol.readFile(peer))).not.toContain('ipad')

		// The new shard's first entry parents into the foreign shard — the join is a real edge,
		// not two conversations that happen to sit in one directory.
		const mine = names.find((n) => !n.includes('bbbb2222')) as string
		const first = JSON.parse(
			new TextDecoder().decode(await vol.readFile(`${dir}/${mine}`)).split('\n')[0] as string
		)
		expect(first.parentId).toBe('aaaa0002')
	})
})

// Rolling over summarises the retired conversation into the daily journal. That is an LLM call
// and an append-only write, and until the fresh session has its first entry the retired one is
// STILL the newest — so anything that re-initialises the host in that window used to archive it
// all over again (#335 review). A DO eviction, a backend rebuild, or a UI that only asked for
// history are all in that window.
describe('retiring a session on rollover', () => {
	const DAILY = `/system/memory/daily/${new Date().toISOString().slice(0, 10)}.md`

	// A conversation that went quiet seven hours ago: past the six-hour idle window, so the next
	// turn retires it.
	async function seedIdleSession(vol: Volume) {
		const dir = '/system/agents/main/sessions'
		const idle = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString()
		await vol.mkdir(dir, { recursive: true })
		await vol.writeFile(
			`${dir}/2026-07-26T09-00-00Z-01d5e551.aaaa1111.jsonl`,
			encoder.encode(
				`${JSON.stringify({ type: 'message', role: 'user', content: 'an old question', id: 'aaaa0001', parentId: null, ts: idle })}\n${JSON.stringify(
					{
						type: 'message',
						role: 'assistant',
						content: 'an old answer',
						id: 'aaaa0002',
						parentId: 'aaaa0001',
						ts: idle
					}
				)}\n`
			)
		)
	}

	test('the retired conversation is summarised once, however often the host re-initialises', async () => {
		const vol = volume(memStorage())
		await seedIdleSession(vol)
		let completions = 0
		const open = () =>
			createAgentSession({
				volume: vol,
				backend: scriptedBackend([], 'a note about the old conversation', {
					onComplete: () => completions++
				}),
				compaction: NO_COMPACTION
			})

		// First host: retires the idle session and journals it.
		await open().history()
		const afterFirst = new TextDecoder().decode(await vol.readFile(DAILY))
		expect(afterFirst).toContain('a note about the old conversation')
		expect(completions).toBe(1)

		// A second host over the same Volume — an eviction, a rebuild, or just a reconnect that
		// only wanted history. The retired session is still the newest thing on disk.
		await open().history()

		const afterSecond = new TextDecoder().decode(await vol.readFile(DAILY))
		expect(afterSecond).toBe(afterFirst)
		// And the summary was not paid for twice: the claim is taken BEFORE the LLM call.
		expect(completions).toBe(1)
	})

	// Two builds against ONE backend — an evicted DO rebuilding while a request is already in
	// flight. The claim is a real atomic create here, so exactly one archives.
	test('two builds racing over one backend retire it once between them', async () => {
		const vol = volume(memStorage())
		await seedIdleSession(vol)
		let completions = 0
		const open = () =>
			createAgentSession({
				volume: vol,
				backend: scriptedBackend([], 'a note about the old conversation', {
					onComplete: () => completions++
				}),
				compaction: NO_COMPACTION
			})

		await Promise.all([open().history(), open().history()])

		expect(completions).toBe(1)
		expect(new TextDecoder().decode(await vol.readFile(DAILY)).match(/a note about/g)).toHaveLength(
			1
		)
	})

	// And the boundary, pinned deliberately rather than left implied: the claim does NOT
	// arbitrate across REPLICAS. Two agent-running hosts each hold their own Volume, so both
	// exclusive creates succeed and both archive; sync later collapses the marker by LWW, long
	// after the work was done twice.
	//
	// This is a decision, not an oversight. Making it a real distributed claim needs a shared
	// authority or a leader election, and the cost of the duplicate is an extra LLM call plus a
	// duplicated journal block — so it is arbitrated by CONFIGURATION (one host per account owns
	// background work) instead of by a protocol. Two conditions make that safe, and both are
	// tracked: the daily journal and durable memory must be per-device shards first (#302/#303),
	// or a double-run is whole-file LWW and one summary is LOST rather than duplicated; and the
	// background-work owner has to exist before two agents share a Volume (E3, #306).
	//
	// If someone later adds real cross-replica coordination, this test fails and should be
	// rewritten — that is the point of asserting the current boundary.
	test('the claim does not reach across replicas: each host archives its own copy', async () => {
		let completions = 0
		const hosts = await Promise.all(
			[0, 1].map(async () => {
				const vol = volume(memStorage())
				await seedIdleSession(vol)
				const session = createAgentSession({
					volume: vol,
					backend: scriptedBackend([], 'a note about the old conversation', {
						onComplete: () => completions++
					}),
					compaction: NO_COMPACTION
				})
				return { vol, session }
			})
		)
		await Promise.all(hosts.map((h) => h.session.history()))

		// Both did the work: two LLM calls, and each replica holds one summary.
		expect(completions).toBe(2)
		for (const { vol } of hosts) {
			expect(
				new TextDecoder().decode(await vol.readFile(DAILY)).match(/a note about/g)
			).toHaveLength(1)
		}
	})
})

// A session reads the identity files when it BUILDS its runtime, and every host memoises
// the session — so without this, renaming the agent in Settings changed the file and
// nothing else until the host restarted. Watching belongs to the session for exactly that
// reason: no host can forget it.
test('a soul written under a live session reaches the next turn', async () => {
	const vol = volume(memStorage())
	await vol.mkdir('/system/agents/main', { recursive: true })
	await vol.writeFile(SOUL_PATH, encoder.encode('---\nagent_name: Kodama\n---\n\nYou are Kodama.'))
	const session = createAgentSession({
		volume: vol,
		backend: scriptedBackend([assistant([{ type: 'text', text: 'ok' }])]),
		compaction: NO_COMPACTION
	})
	expect(await session.systemPrompt()).toContain('You are Kodama.')

	await vol.writeFile(SOUL_PATH, encoder.encode('---\nagent_name: Fern\n---\n\nYou are Fern.'))
	// The watch fires on the commit; the drop is what the next build reads through.
	await new Promise((resolve) => setTimeout(resolve, 0))

	const prompt = await session.systemPrompt()
	expect(prompt).toContain('You are Fern.')
	expect(prompt).not.toContain('You are Kodama.')
})
