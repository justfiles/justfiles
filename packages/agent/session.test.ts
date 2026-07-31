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
import type { AgentBackend } from './llm.ts'
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
function scriptedBackend(messages: AssistantMessage[], complete = ''): AgentBackend {
	const queue = [...messages]
	const streamFn: StreamFn = () => {
		const stream = createAssistantMessageEventStream()
		const message = queue.shift() ?? assistant([])
		stream.push({ type: 'done', reason: 'stop', message })
		stream.end(message)
		return stream
	}
	const completeFn: AgentBackend['completeFn'] = async () =>
		assistant(complete ? [{ type: 'text', text: complete }] : [])
	return {
		model: { id: 'test' } as Model<Api>,
		streamFn,
		completeFn,
		revision: 'r1'
	}
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
