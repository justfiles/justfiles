import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall
} from '@earendil-works/pi-ai'
import { type Volume, volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Ghost, openGhost, type Tool, type TranscriptEvent } from './index.ts'
import { openNodeSqliteState } from './state/node-sqlite.ts'

let dir: string
let faux: ReturnType<typeof fauxProvider>
let models: ReturnType<typeof createModels>
const open: Ghost[] = []

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'ghost-'))
	faux = fauxProvider()
	models = createModels()
	models.setProvider(faux.provider)
})

afterEach(async () => {
	for (const ghost of open.splice(0)) await ghost.close().catch(() => {})
	await rm(dir, { recursive: true, force: true })
})

async function openOn(
	path: string,
	tools?: Tool[],
	world: Volume = volume(memStore())
): Promise<Ghost> {
	const ghost = await openGhost({
		volume: world,
		state: await openNodeSqliteState(path),
		models,
		shell: { id: 'test', name: 'Test', kind: 'test' },
		tools,
		settings: { model: { provider: 'faux', modelId: 'faux-1' } }
	})
	open.push(ghost)
	return ghost
}

function record(ghost: Ghost): TranscriptEvent[] {
	const events: TranscriptEvent[] = []
	ghost.watch((event) => events.push(event))
	return events
}

const enc = (text: string) => new TextEncoder().encode(text)
const dec = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

/** The model calls `name` with `args`, one tool round per call. */
function calls(...rounds: [name: string, args: Parameters<typeof fauxToolCall>[1]][]) {
	return rounds.map(([name, args]) =>
		fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' })
	)
}

function toolResults(ghost: Ghost) {
	return snapshotOf(ghost).transcript.entries.flatMap((entry) =>
		entry.kind === 'tool' ? [entry] : []
	)
}

function snapshotOf(ghost: Ghost) {
	let snapshot: TranscriptEvent | undefined
	ghost.watch((event) => {
		snapshot ??= event
	})()
	if (snapshot?.type !== 'snapshot') throw new Error('watch did not start with a snapshot')
	return snapshot
}

describe('openGhost', () => {
	it('settles an ask with the answer and streams it to watchers', async () => {
		const ghost = await openOn(':memory:')
		const events = record(ghost)
		faux.setResponses([fauxAssistantMessage('Paris')])

		const settled = await ghost.ask('Capital of France?', { id: 'q1' })

		expect(settled).toEqual({ id: 'q1', status: 'done', text: 'Paris' })
		expect(events[0]).toMatchObject({
			type: 'snapshot',
			transcript: { entries: [] },
			status: { busy: false, queued: 0 }
		})
		await vi.waitFor(() => {
			const entries = events.flatMap((event) => (event.type === 'entry' ? [event.entry] : []))
			expect(entries).toMatchObject([
				{ kind: 'user', text: 'Capital of France?', askId: 'q1' },
				{ kind: 'assistant', text: 'Paris', toolCalls: [] }
			])
			const busy = events.flatMap((event) => (event.type === 'status' ? [event.status.busy] : []))
			expect(busy).toEqual([true, false])
		})
		const text = events.flatMap((event) => (event.type === 'text' ? [event.delta] : []))
		expect(text.join('')).toBe('Paris')
	})

	it('keeps a throwing watcher from stopping the others', async () => {
		const ghost = await openOn(':memory:')
		ghost.watch((event) => {
			if (event.type !== 'snapshot') throw new Error('bad watcher')
		})
		const events = record(ghost)
		faux.setResponses([fauxAssistantMessage('one'), fauxAssistantMessage('two')])

		await ghost.ask('first', { id: '1' })
		await ghost.ask('second', { id: '2' })

		await vi.waitFor(() => {
			const answers = events.flatMap((event) =>
				event.type === 'entry' && event.entry.kind === 'assistant' ? [event.entry.text] : []
			)
			expect(answers).toEqual(['one', 'two'])
		})
	})

	it('runs tools in the directory of the ask they answer', async () => {
		const cwds: string[] = []
		const where: Tool = {
			name: 'where',
			description: 'Say the working directory.',
			parameters: { type: 'object', properties: {} },
			execute: async (_params, { cwd }) => {
				cwds.push(cwd)
				return { text: cwd }
			}
		}
		const ghost = await openOn(':memory:', [where])
		let release!: () => void
		const queued = new Promise<void>((resolve) => {
			release = resolve
		})
		faux.setResponses([
			async () => {
				await queued
				return fauxAssistantMessage(fauxToolCall('where', {}), { stopReason: 'toolUse' })
			},
			fauxAssistantMessage('a done'),
			fauxAssistantMessage(fauxToolCall('where', {}), { stopReason: 'toolUse' }),
			fauxAssistantMessage('b done'),
			fauxAssistantMessage(fauxToolCall('where', {}), { stopReason: 'toolUse' }),
			fauxAssistantMessage('c done')
		])
		ghost.watch((event) => {
			if (event.type === 'status' && event.status.queued > 0) release()
		})

		const a = ghost.ask('A', { id: 'a', cwd: '/a' })
		const b = ghost.ask('B', { id: 'b', cwd: '/b' })
		await Promise.all([a, b])
		await ghost.ask('C', { id: 'c' })

		expect(cwds).toEqual(['/a', '/b', '/'])
	})

	it('does not submit twice for the same id', async () => {
		const ghost = await openOn(':memory:')
		faux.setResponses([fauxAssistantMessage('once')])

		const first = await ghost.ask('hello', { id: 'same' })
		const again = await ghost.ask('hello', { id: 'same' })

		expect(again).toEqual(first)
		expect(faux.state.callCount).toBe(1)
		const users = snapshotOf(ghost).transcript.entries.filter((entry) => entry.kind === 'user')
		expect(users).toHaveLength(1)
	})

	it('finishes a turn cut off by close when opened again', async () => {
		const path = join(dir, 'state.sqlite')
		let started!: () => void
		const running = new Promise<void>((resolve) => {
			started = resolve
		})
		const hold: Tool = {
			name: 'hold',
			description: 'Wait until stopped.',
			parameters: { type: 'object', properties: {} },
			execute: (_params, { signal }) => {
				started()
				return new Promise((_resolve, reject) => {
					signal.addEventListener('abort', () => reject(signal.reason))
				})
			}
		}
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall('hold', {}), { stopReason: 'toolUse' }),
			fauxAssistantMessage('finished')
		])

		const first = await openOn(path, [hold])
		const cut = first.ask('go', { id: 'turn' })
		await running
		await first.close()
		await expect(cut).rejects.toThrow()

		const second = await openOn(path, [hold])
		const settled = await second.ask('go', { id: 'turn' })

		expect(settled).toEqual({ id: 'turn', status: 'done', text: 'finished' })
		expect(snapshotOf(second).transcript.entries).toMatchObject([
			{ kind: 'user', text: 'go' },
			{ kind: 'assistant', toolCalls: [{ name: 'hold' }] },
			{ kind: 'tool', name: 'hold', isError: true },
			{ kind: 'assistant', text: 'finished' }
		])
	})

	it('starts a new session that opens with the handoff', async () => {
		const ghost = await openOn(':memory:')
		let seen: unknown[] = []
		faux.setResponses([
			fauxAssistantMessage('noted'),
			(context) => {
				seen = context.messages
				return fauxAssistantMessage('fresh')
			}
		])
		await ghost.ask('The secret is 42.', { id: 'old' })

		await ghost.newSession('We were talking about the weather.')
		const settled = await ghost.ask('What now?', { id: 'new' })

		expect(settled).toMatchObject({ status: 'done', text: 'fresh' })
		const sent = JSON.stringify(seen)
		expect(sent).toContain('We were talking about the weather.')
		expect(sent).not.toContain('The secret is 42.')
		expect(snapshotOf(ghost).transcript.entries).toMatchObject([
			{ kind: 'reset', handoff: 'We were talking about the weather.' },
			{ kind: 'user', text: 'What now?' },
			{ kind: 'assistant', text: 'fresh' }
		])
	})
})

describe('the Volume is the world', () => {
	it('writes and reads files in the Volume, not on disk', async () => {
		const world = volume(memStore())
		const ghost = await openOn(':memory:', undefined, world)
		faux.setResponses([
			...calls(
				['write', { path: 'ghost-notes/a.md', content: 'hello volume' }],
				['read', { path: 'ghost-notes/a.md' }]
			),
			fauxAssistantMessage('done')
		])

		await ghost.ask('Note it.', { id: 'w' })

		expect(dec(await world.readFile('/ghost-notes/a.md'))).toBe('hello volume')
		expect(toolResults(ghost)).toMatchObject([
			{ name: 'write', isError: false },
			{ name: 'read', isError: false, text: 'hello volume' }
		])
		expect(existsSync('ghost-notes')).toBe(false)
		expect(existsSync('/ghost-notes')).toBe(false)
	})

	it('runs bash commands and pipelines over Volume files', async () => {
		const world = volume(memStore())
		await world.mkdir('/proj')
		await world.writeFile('/proj/a.txt', enc('apple\nbanana\n'))
		await world.writeFile('/proj/b.txt', enc('cherry\n'))
		const ghost = await openOn(':memory:', undefined, world)
		faux.setResponses([
			...calls(
				['bash', { command: 'ls' }],
				['bash', { command: 'cat a.txt' }],
				['bash', { command: 'rg -l cherry' }],
				['bash', { command: 'grep -n banana a.txt' }],
				['bash', { command: 'cat *.txt | grep -v apple | sort -r | head -n 1' }]
			),
			fauxAssistantMessage('done')
		])

		await ghost.ask('Look around.', { id: 'b', cwd: '/proj' })

		expect(toolResults(ghost).map(({ text, isError }) => ({ text: text.trim(), isError }))).toEqual(
			[
				{ text: 'a.txt\nb.txt', isError: false },
				{ text: 'apple\nbanana', isError: false },
				{ text: 'b.txt', isError: false },
				{ text: '2:banana', isError: false },
				{ text: 'cherry', isError: false }
			]
		)
	})

	it('resolves relative paths against the cwd of each ask', async () => {
		const world = volume(memStore())
		const ghost = await openOn(':memory:', undefined, world)
		faux.setResponses([
			...calls(['write', { path: 'x.txt', content: 'A' }]),
			fauxAssistantMessage('a done'),
			...calls(['write', { path: 'x.txt', content: 'B' }], ['bash', { command: 'pwd; cat x.txt' }]),
			fauxAssistantMessage('b done')
		])

		await ghost.ask('A', { id: 'a', cwd: '/a' })
		await ghost.ask('B', { id: 'b', cwd: '/b' })

		expect(dec(await world.readFile('/a/x.txt'))).toBe('A')
		expect(dec(await world.readFile('/b/x.txt'))).toBe('B')
		expect(toolResults(ghost).at(-1)?.text.trim()).toBe('/b\nB')
	})

	it('finishes a turn cut off after a write without writing again', async () => {
		const path = join(dir, 'state.sqlite')
		const world = volume(memStore())
		let writes = 0
		let written!: () => void
		const landed = new Promise<void>((resolve) => {
			written = resolve
		})
		let release!: () => void
		const held = new Promise<void>((resolve) => {
			release = resolve
		})
		// The write lands, and the tool is held there until the ghost closes under it.
		const dying = new Proxy(world, {
			get(target, key) {
				if (key !== 'writeFile') return Reflect.get(target, key)
				return async (...args: Parameters<Volume['writeFile']>) => {
					await target.writeFile(...args)
					if (args[0] !== '/out.txt') return
					writes++
					written()
					await held
				}
			}
		})
		faux.setResponses([
			...calls(['write', { path: 'out.txt', content: 'once' }]),
			fauxAssistantMessage('finished')
		])

		const first = await openOn(path, undefined, dying)
		const cut = first.ask('Write it.', { id: 'turn' })
		await landed
		const closing = first.close()
		release()
		await closing
		await expect(cut).rejects.toThrow()

		const second = await openOn(path, undefined, dying)
		const settled = await second.ask('Write it.', { id: 'turn' })

		expect(settled).toEqual({ id: 'turn', status: 'done', text: 'finished' })
		expect(writes).toBe(1)
		expect(dec(await world.readFile('/out.txt'))).toBe('once')
		expect(toolResults(second)).toMatchObject([{ name: 'write', isError: true }])
	})
})
