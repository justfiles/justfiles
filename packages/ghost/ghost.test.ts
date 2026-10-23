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
import { openRotating } from './ghost.ts'
import {
	agentName,
	type Ghost,
	type GhostSettings,
	openGhost,
	type Tool,
	type TranscriptEvent
} from './index.ts'
import { parseLines } from './mirror.ts'
import { openNodeSqliteState } from './state/node-sqlite.ts'
import type { StateDatabase } from './types.ts'

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
	world: Volume = volume(memStore()),
	settings: GhostSettings = {},
	shell = TEST_SHELL
): Promise<Ghost> {
	const ghost = await openGhost(
		depsOn(await openNodeSqliteState(path), world, tools, settings, shell)
	)
	open.push(ghost)
	return ghost
}

/** A ghost on `state` that rotates it past `maxBytes`. */
async function openBounded(
	state: StateDatabase,
	world: Volume,
	maxBytes: number,
	settings: GhostSettings = {}
) {
	const ghost = await openRotating(depsOn(state, world, undefined, settings), maxBytes)
	open.push(ghost)
	return ghost
}

const TEST_SHELL = { id: 'test', name: 'Test', kind: 'test' }

function depsOn(
	state: StateDatabase,
	world: Volume,
	tools?: Tool[],
	settings: GhostSettings = {},
	shell = TEST_SHELL
) {
	return {
		volume: world,
		state,
		models,
		shell,
		tools,
		settings: { model: { provider: 'faux', modelId: 'faux-1' }, ...settings }
	}
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

async function put(world: Volume, path: string, text: string) {
	await world.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true })
	await world.writeFile(path, enc(text))
}

const today = () => new Date().toISOString().slice(0, 10)

async function dailyOf(world: Volume, day: string) {
	return dec(await world.readFile(`/system/memory/daily/${day}.test.md`))
}

/** A request's system prompt: every section in effect, in order. */
function systemPrompt(context: { messages: readonly object[] }): string {
	return Object.values(sectionsOf(context)).join('\n\n')
}

/** A request's prompt sections in effect, by key, in order. */
function sectionsOf(context: { messages: readonly object[] }): Record<string, string> {
	const sections: Record<string, string> = {}
	for (const message of context.messages as { role: string; sections?: Record<string, string> }[])
		if (message.role === 'system') Object.assign(sections, message.sections)
	return sections
}

/** Answer every request with 'ok', keeping its system prompt. */
function capturePrompts(): string[] {
	const prompts: string[] = []
	faux.setResponses([
		(context) => {
			prompts.push(systemPrompt(context))
			return fauxAssistantMessage('ok')
		}
	])
	return prompts
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
		faux.setResponses([fauxAssistantMessage('one'), () => fauxAssistantMessage('two')])

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
		const cut = expect(first.ask('go', { id: 'turn' })).rejects.toThrow()
		await running
		await first.close()
		await cut

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

	it('starts a new session that opens with the handoff, after a note on the old one', async () => {
		const world = volume(memStore())
		const ghost = await openOn(':memory:', undefined, world)
		let read = ''
		let seen: { role: string }[] = []
		faux.setResponses([
			fauxAssistantMessage('noted'),
			(context) => {
				read = JSON.stringify(context.messages)
				return fauxAssistantMessage('- The secret is 42.')
			},
			(context) => {
				seen = context.messages
				return fauxAssistantMessage('fresh')
			}
		])
		await ghost.ask('The secret is 42.', { id: 'old' })

		await ghost.newSession('We were talking about the weather.')
		const settled = await ghost.ask('What now?', { id: 'new' })

		expect(read).toContain('The secret is 42.')
		expect(await dailyOf(world, today())).toBe('- The secret is 42.\n')
		expect(settled).toMatchObject({ status: 'done', text: 'fresh' })
		const sent = JSON.stringify(seen.filter((message) => message.role !== 'system'))
		expect(sent).toContain('We were talking about the weather.')
		expect(sent).not.toContain('The secret is 42.')
		expect(snapshotOf(ghost).transcript.entries).toMatchObject([
			{ kind: 'reset', handoff: 'We were talking about the weather.' },
			{ kind: 'user', text: 'What now?' },
			{ kind: 'assistant', text: 'fresh' }
		])
	})
})

describe('sections and memory notes', () => {
	// 2026-10-20 01:00 in Auckland, still 2026-10-19 in UTC.
	const NOW = new Date('2026-10-19T12:00:00Z')

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(NOW)
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	const noop: Tool = {
		name: 'exec',
		description: 'Run a process.',
		parameters: { type: 'object', properties: {} },
		execute: async () => ({ text: '' })
	}

	it('builds the system prompt from the Volume, in order', async () => {
		const world = volume(memStore())
		await put(world, '/system/agents/main/soul.md', 'You are Wisp, a quiet ghost.')
		await put(world, '/system/user.md', 'Name: Ada')
		await put(
			world,
			'/system/skills/brew/SKILL.md',
			'---\nname: brew\ndescription: Brew tea.\n---\nSteep it.'
		)
		await put(world, '/system/memory/core.md', '- Ada drinks oolong.')
		await put(world, '/system/memory/daily/2026-10-20.test.md', '- Ada is moving house.')
		const ghost = await openOn(':memory:', [noop], world, { timeZone: 'Pacific/Auckland' })
		const prompts = capturePrompts()

		await ghost.ask('Hello', { id: 'h' })

		const prompt = prompts[0] ?? ''
		const order = [
			'You are Wisp, a quiet ghost.',
			'# your filesystem',
			'`exec` reach this device itself',
			'shell `Test` (id `test`, kind `test`)',
			'# about the user\n\nName: Ada',
			'# skills\n\n',
			'- brew (`/system/skills/brew/SKILL.md`) — Brew tea.',
			'# current time\n\nNow: 2026-10-20T01:00:00+13:00 (Pacific/Auckland).',
			'# permanent memory\n\n- Ada drinks oolong.',
			'# memories of the past 2 days\n\n',
			'## 2026-10-20, shell test\n\n- Ada is moving house.',
			'# expression'
		]
		for (const text of order) expect(prompt).toContain(text)
		const at = order.map((text) => prompt.indexOf(text))
		expect(at).toEqual([...at].sort((a, b) => a - b))
		expect(prompt).not.toContain('Steep it.')
		expect(prompt).not.toContain('You are Computer')
	})

	it('gives the built-in soul when none is written', async () => {
		const ghost = await openOn(':memory:')
		const prompts = capturePrompts()

		await ghost.ask('Hello', { id: 'h' })

		expect(prompts[0]).toMatch(/^---\nschema: frieren\/agent-soul\/v1\n[\s\S]*You are Computer/)
		expect(prompts[0]).not.toContain('# about the user\n\n')
		expect(prompts[0]).not.toContain('# permanent memory\n\n')
		expect(prompts[0]).not.toContain('# memories of the past 2 days\n\n')
	})

	it("names the agent from its soul's frontmatter", async () => {
		const world = volume(memStore())
		expect(await agentName(world)).toBe('Computer')
		await put(world, '/system/agents/main/soul.md', 'You are Wisp.\n\nagent_name: Wisp')
		expect(await agentName(world)).toBe('Computer')
		await put(world, '/system/agents/main/soul.md', '---\nagent_name: Wisp\n---\n\nYou are Wisp.')
		expect(await agentName(world)).toBe('Wisp')
	})

	it("shows every shell's daily files for today and yesterday", async () => {
		const world = volume(memStore())
		await put(world, '/system/memory/daily/2026-10-18.laptop.md', '- Too old.')
		await put(world, '/system/memory/daily/2026-10-19.laptop.md', '- Fixed the boiler.')
		await put(world, '/system/memory/daily/2026-10-20.test.md', '- Today, here.')
		const ghost = await openOn(':memory:', undefined, world, { timeZone: 'Pacific/Auckland' })
		const prompts = capturePrompts()

		await ghost.ask('What did I do yesterday?', { id: 'y' })

		expect(prompts[0]).toContain(
			'## 2026-10-19, shell laptop\n\n- Fixed the boiler.\n\n## 2026-10-20, shell test\n\n- Today, here.'
		)
		expect(prompts[0]).not.toContain('Too old.')
	})

	it('keeps the prompt byte-stable within a turn and reads it again at the next', async () => {
		const world = volume(memStore())
		const ghost = await openOn(':memory:', undefined, world)
		const prompts: string[] = []
		faux.setResponses([
			(context) => {
				prompts.push(systemPrompt(context))
				vi.setSystemTime(new Date(NOW.getTime() + 60_000))
				return fauxAssistantMessage(
					fauxToolCall('write', { path: '/system/memory/core.md', content: '- Remembered.' }),
					{ stopReason: 'toolUse' }
				)
			},
			(context) => {
				prompts.push(systemPrompt(context))
				return fauxAssistantMessage('done')
			},
			(context) => {
				prompts.push(systemPrompt(context))
				return fauxAssistantMessage('again')
			}
		])

		await ghost.ask('Remember it.', { id: '1' })
		await ghost.ask('And now?', { id: '2' })

		expect(prompts[1]).toBe(prompts[0])
		expect(prompts[0]).toContain('Now: 2026-10-19T12:00:00Z (UTC).')
		expect(prompts[0]).not.toContain('- Remembered.')
		expect(prompts[2]).toContain('Now: 2026-10-19T12:01:00Z (UTC).')
		expect(prompts[2]).toContain('# permanent memory\n\n- Remembered.')
	})

	it('notes what a compaction summarizes, and the next turn still answers', async () => {
		const world = volume(memStore())
		const ghost = await openOn(':memory:', undefined, world, {
			compaction: {
				reserveTokens: faux.getModel().contextWindow - 500,
				keepRecentTokens: 1,
				backgroundTokens: 0
			}
		})
		let read = ''
		faux.setResponses([
			fauxAssistantMessage('Got it.'),
			(context) => {
				read = JSON.stringify(context.messages)
				return fauxAssistantMessage('- The cat is called Miso.')
			},
			fauxAssistantMessage('The user has a cat.'),
			fauxAssistantMessage('Miso.')
		])

		await ghost.ask('My cat is called Miso.', { id: '1' })
		const settled = await ghost.ask('What is my cat called?', { id: '2' })

		expect(settled).toEqual({ id: '2', status: 'done', text: 'Miso.' })
		expect(read).toContain('My cat is called Miso.')
		expect(read).not.toContain('What is my cat called?')
		expect(await dailyOf(world, '2026-10-19')).toBe('- The cat is called Miso.\n')
		expect(snapshotOf(ghost).transcript.entries).toMatchObject([
			{ kind: 'compaction', summary: expect.stringContaining('The user has a cat.') },
			{ kind: 'user', text: 'What is my cat called?' },
			{ kind: 'assistant', text: 'Miso.' }
		])
	})

	it('notes the answer a new session waits for', async () => {
		const world = volume(memStore())
		const ghost = await openOn(':memory:', undefined, world)
		let started!: () => void
		const answering = new Promise<void>((resolve) => {
			started = resolve
		})
		let release!: () => void
		const held = new Promise<void>((resolve) => {
			release = resolve
		})
		let read = ''
		faux.setResponses([
			async () => {
				started()
				await held
				return fauxAssistantMessage('The cat is called Miso.')
			},
			(context) => {
				read = JSON.stringify(context.messages)
				return fauxAssistantMessage('- The cat is called Miso.')
			}
		])

		const asked = ghost.ask('What is my cat called?', { id: '1' })
		await answering
		const renewed = ghost.newSession('Fresh start.')
		release()
		await Promise.all([asked, renewed])

		expect(read).toContain('What is my cat called?')
		expect(read).toContain('The cat is called Miso.')
		expect(await dailyOf(world, '2026-10-19')).toBe('- The cat is called Miso.\n')
		expect(snapshotOf(ghost).transcript.entries).toMatchObject([
			{ kind: 'reset', handoff: 'Fresh start.' }
		])
	})

	it('takes a new session note at the next open when the process died before it', async () => {
		const path = join(dir, 'state.sqlite')
		const world = volume(memStore())
		let started!: () => void
		const noting = new Promise<void>((resolve) => {
			started = resolve
		})
		faux.setResponses([
			fauxAssistantMessage('Noted.'),
			(_context, options) => {
				started()
				return new Promise((_resolve, reject) => {
					options?.signal?.addEventListener('abort', () => reject(options.signal?.reason))
				})
			},
			fauxAssistantMessage('- The cat is called Miso.')
		])
		const first = await openOn(path, undefined, world)
		await first.ask('My cat is called Miso.', { id: '1' })

		const renewed = first.newSession()
		await noting
		await first.close()
		await renewed
		const second = await openOn(path, undefined, world)

		await vi.waitFor(async () => {
			expect(await dailyOf(world, '2026-10-19')).toBe('- The cat is called Miso.\n')
		})
		await second.close()

		// Taken once: a later open finds the marker and asks the model nothing.
		const calls = faux.state.callCount
		const third = await openOn(path, undefined, world)
		await third.newSession()
		expect(faux.state.callCount).toBe(calls)
	})

	it('stops a new session note when the ghost closes', async () => {
		const world = volume(memStore())
		let started!: () => void
		const noting = new Promise<void>((resolve) => {
			started = resolve
		})
		faux.setResponses([
			fauxAssistantMessage('Noted.'),
			(_context, options) => {
				started()
				return new Promise((_resolve, reject) => {
					options?.signal?.addEventListener('abort', () => reject(options.signal?.reason))
				})
			}
		])
		const ghost = await openOn(':memory:', undefined, world)
		await ghost.ask('My cat is called Miso.', { id: '1' })

		const renewed = ghost.newSession()
		await noting
		await ghost.close()

		await renewed
		expect(await world.exists('/system/memory/daily/2026-10-19.test.md')).toBe(false)
	})

	it('appends notes to the daily file without repeating a paragraph', async () => {
		const world = volume(memStore())
		const ghost = await openOn(':memory:', undefined, world)
		faux.setResponses([
			fauxAssistantMessage('one'),
			fauxAssistantMessage('- A.\n\n- B.'),
			fauxAssistantMessage('two'),
			fauxAssistantMessage('- B.\n\n- C.')
		])

		await ghost.ask('first', { id: '1' })
		await ghost.newSession()
		await ghost.ask('second', { id: '2' })
		await ghost.newSession()

		expect(await dailyOf(world, '2026-10-19')).toBe('- A.\n\n- B.\n\n- C.\n')
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
		const cut = expect(first.ask('Write it.', { id: 'turn' })).rejects.toThrow()
		await landed
		const closing = first.close()
		release()
		await closing
		await cut

		const second = await openOn(path, undefined, dying)
		const settled = await second.ask('Write it.', { id: 'turn' })

		expect(settled).toEqual({ id: 'turn', status: 'done', text: 'finished' })
		expect(writes).toBe(1)
		expect(dec(await world.readFile('/out.txt'))).toBe('once')
		expect(toolResults(second)).toMatchObject([{ name: 'write', isError: true }])
	})
})

describe('shell tools replace built-ins by name', () => {
	/** A shell tool named `name` that keeps what each call got. */
	function shellTool(name: string) {
		const got: { params: unknown; cwd: string }[] = []
		const tool: Tool = {
			name,
			description: `The shell's ${name}.`,
			parameters: { type: 'object', properties: {} },
			execute: async (params, { cwd }) => {
				got.push({ params, cwd })
				return { text: `shell ${name} in ${cwd}` }
			}
		}
		return { tool, got }
	}

	/** Answer with `rounds` of tool calls, then 'done', keeping each request's context. */
	function answer(...rounds: Parameters<typeof calls>) {
		const seen: { messages: readonly object[] }[] = []
		faux.setResponses(
			[...calls(...rounds), fauxAssistantMessage('done')].map((message) => (context) => {
				seen.push(context)
				return message
			})
		)
		return seen
	}

	/** The tools offered to the model in a request, by name and description. */
	function toolsOf(context: { messages: readonly object[] }) {
		return (context.messages as { role: string; toolsAdded?: Tool[] }[]).flatMap((message) =>
			message.role === 'system'
				? (message.toolsAdded ?? []).map(({ name, description }) => ({ name, description }))
				: []
		)
	}

	const JUST_BASH = 'emulated\nshell over those files with no real processes'

	it('runs a shell bash in place of just-bash, in the cwd of the ask', async () => {
		const world = volume(memStore())
		await world.mkdir('/proj')
		await world.writeFile('/proj/a.txt', enc('apple\n'))
		const bash = shellTool('bash')
		const ghost = await openOn(':memory:', [bash.tool], world)
		const seen = answer(['bash', { command: 'cat a.txt' }])

		await ghost.ask('Look.', { id: 'b', cwd: '/proj' })

		expect(bash.got).toEqual([{ params: { command: 'cat a.txt' }, cwd: '/proj' }])
		expect(toolResults(ghost)).toMatchObject([
			{ name: 'bash', text: 'shell bash in /proj', isError: false }
		])
		const offered = toolsOf(seen[0] ?? { messages: [] })
		expect(offered.filter(({ name }) => name === 'bash')).toEqual([
			{ name: 'bash', description: "The shell's bash." }
		])
		expect(offered.map(({ name }) => name).sort()).toEqual([
			'bash',
			'edit',
			'read',
			'transcript',
			'write'
		])
		const shellRecord = JSON.parse(
			dec(await world.readFile('/system/agents/main/shells/test.json'))
		)
		expect(shellRecord.capabilities).toEqual(['read', 'write', 'edit', 'transcript', 'bash'])
	})

	it('runs a shell read in place of the Volume read, in the cwd of the ask', async () => {
		const world = volume(memStore())
		await put(world, '/proj/a.txt', 'apple')
		const read = shellTool('read')
		const ghost = await openOn(':memory:', [read.tool], world)
		const seen = answer(['read', { path: 'a.txt' }])

		await ghost.ask('Read it.', { id: 'r', cwd: '/proj' })

		expect(read.got).toEqual([{ params: { path: 'a.txt' }, cwd: '/proj' }])
		expect(toolResults(ghost)).toMatchObject([{ name: 'read', text: 'shell read in /proj' }])
		const offered = toolsOf(seen[0] ?? { messages: [] })
		expect(offered.filter(({ name }) => name === 'read')).toEqual([
			{ name: 'read', description: "The shell's read." }
		])
		const filesystem = sectionsOf(seen[0] ?? { messages: [] }).filesystem
		expect(filesystem).toContain('apps. `write`, `edit` and `bash` see the Volume')
		expect(filesystem).toContain('`read` reach this device itself')
	})

	it('drops the just-bash sentence when bash is replaced, and keeps the section as it was when nothing is', async () => {
		const bash = shellTool('bash')
		const replaced = await openOn(':memory:', [bash.tool, shellTool('emacs').tool])
		const seenReplaced = answer()
		await replaced.ask('Hi', { id: 'h' })
		const kept = await openOn(':memory:', [shellTool('emacs').tool])
		const seenKept = answer()
		await kept.ask('Hi', { id: 'h' })

		const withBash = sectionsOf(seenReplaced[0] ?? { messages: [] }).filesystem
		expect(withBash).not.toContain(JUST_BASH)
		expect(withBash).toContain(
			'`/system/user.md` is `"$GHOST_VOLUME/system/user.md"`\nthere, and a bare `/` is the device\'s own root.'
		)
		expect(withBash).toContain(
			'apps. `read`, `write` and `edit` see the Volume and nothing else, rooted at\n`/`; relative paths start from the directory the user asked from.\n`bash`, `emacs` reach this device itself'
		)
		expect(sectionsOf(seenKept[0] ?? { messages: [] }).filesystem).toContain(
			`# your filesystem

Everything you work on is files on one Volume you share with the user and their
apps. \`read\`, \`write\`, \`edit\` and \`bash\` see the Volume and nothing else, rooted at
\`/\`; relative paths start from the directory the user asked from. \`bash\` is an emulated
shell over those files with no real processes: it has \`ls\`, \`cat\`, \`rg\`, \`jq\`, \`sed\` and
the like, but it cannot run programs such as \`npm\`, \`git\` or \`python\`.
\`emacs\` reach this device itself, outside the Volume: real processes, real apps, the real filesystem. Use them when the work needs the machine, not the files.

## This shell`
		)
	})

	it('drops the built-in transcript lines when transcript is replaced', async () => {
		const replaced = await openOn(':memory:', [shellTool('transcript').tool])
		const seen = answer()
		await replaced.ask('Hi', { id: 'h' })

		const filesystem = sectionsOf(seen[0] ?? { messages: [] }).filesystem
		expect(filesystem).not.toContain('`transcript` searches')
		expect(filesystem).toContain('`transcript` reach this device itself')
		expect(filesystem).toContain("this shell's included. Read only; never edit them.\n\nWhen")
	})

	it('rejects two shell tools with one name, naming the tool', async () => {
		const state = await openNodeSqliteState(':memory:')
		const opening = openGhost(
			depsOn(state, volume(memStore()), [shellTool('open').tool, shellTool('open').tool])
		)

		await expect(opening).rejects.toThrow('two shell tools are named `open`')
	})
})

describe('transcript mirror, shell record and transcript tool', () => {
	const NOW = new Date('2026-10-19T12:00:00Z')

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(NOW)
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	const long: Tool = {
		name: 'long',
		description: 'Say a lot.',
		parameters: { type: 'object', properties: {} },
		execute: async () => ({ text: 'x'.repeat(5000) })
	}

	async function mirrorOf(world: Volume, shell = 'test', day = '2026-10-19') {
		const text = dec(await world.readFile(`/system/agents/main/transcripts/${shell}/${day}.jsonl`))
		return text
			.trimEnd()
			.split('\n')
			.map((line) => JSON.parse(line))
	}

	it('mirrors each entry once, in order, across a reopen', async () => {
		const path = join(dir, 'state.sqlite')
		const world = volume(memStore())
		faux.setResponses([
			...calls(['long', {}]),
			fauxAssistantMessage('said'),
			fauxAssistantMessage('again')
		])

		const first = await openOn(path, [long], world)
		await first.ask('Talk.', { id: '1' })
		await first.close()
		const second = await openOn(path, [long], world)
		await second.ask('Once more.', { id: '2' })
		await second.close()

		const lines = await mirrorOf(world)
		expect(lines).toMatchObject([
			{ at: NOW.toISOString(), kind: 'user', text: 'Talk.', askId: '1' },
			{ kind: 'assistant', toolCalls: [{ name: 'long' }] },
			{ kind: 'tool', name: 'long', text: `${'x'.repeat(2000)}… [3000 more characters]` },
			{ kind: 'assistant', text: 'said' },
			{ kind: 'user', text: 'Once more.' },
			{ kind: 'assistant', text: 'again' }
		])
		const ids = lines.map((line) => line.id)
		expect(ids).toEqual([...new Set(ids)].sort((a, b) => a - b))
	})

	it('dates the entries watchers see, in the snapshot too', async () => {
		const ghost = await openOn(':memory:')
		const events = record(ghost)
		faux.setResponses([fauxAssistantMessage('said')])

		await ghost.ask('Talk.', { id: '1' })

		const said = [
			{ at: NOW.toISOString(), kind: 'user' },
			{ at: NOW.toISOString(), kind: 'assistant' }
		]
		await vi.waitFor(() =>
			expect(
				events.flatMap((event) => (event.type === 'entry' ? [event.entry] : []))
			).toMatchObject(said)
		)
		expect(snapshotOf(ghost).transcript.entries).toMatchObject(said)
		await ghost.close()
	})

	it('starts a new line after one a dying process left half written', async () => {
		const world = volume(memStore())
		await put(
			world,
			'/system/agents/main/transcripts/test/2026-10-19.jsonl',
			'{"at":"2026-10-19T11:00:00.000Z","id":1,"kind":"us'
		)
		faux.setResponses([fauxAssistantMessage('fine')])
		const ghost = await openOn(':memory:', undefined, world)

		await ghost.ask('Still there?', { id: '1' })
		await ghost.close()

		const text = dec(await world.readFile('/system/agents/main/transcripts/test/2026-10-19.jsonl'))
		expect(text.split('\n')[0]).toBe('{"at":"2026-10-19T11:00:00.000Z","id":1,"kind":"us')
		expect(parseLines(text)).toMatchObject([
			{ kind: 'user', text: 'Still there?' },
			{ kind: 'assistant', text: 'fine' }
		])
	})

	it('carries on from an older day when the newest file holds only a half line', async () => {
		const world = volume(memStore())
		faux.setResponses([fauxAssistantMessage('one'), () => fauxAssistantMessage('two')])
		const path = join(dir, 'state.sqlite')
		// One session across the two days, so the second file starts with the second ask.
		const first = await openOn(path, undefined, world, { dayBoundary: false })
		await first.ask('First.', { id: '1' })
		await first.close()
		await put(world, '/system/agents/main/transcripts/test/2026-10-20.jsonl', '{"at":"2026-10-20')

		vi.setSystemTime(new Date('2026-10-20T12:00:00Z'))
		const second = await openOn(path, undefined, world, { dayBoundary: false })
		await second.ask('Second.', { id: '2' })
		await second.close()

		expect(await mirrorOf(world)).toMatchObject([
			{ kind: 'user', text: 'First.' },
			{ kind: 'assistant', text: 'one' }
		])
		const text = dec(await world.readFile('/system/agents/main/transcripts/test/2026-10-20.jsonl'))
		expect(text.split('\n')[0]).toBe('{"at":"2026-10-20')
		expect(parseLines(text)).toMatchObject([
			{ kind: 'user', text: 'Second.' },
			{ kind: 'assistant', text: 'two' }
		])
	})

	it('keeps the newest entry in the newest file when the day goes back', async () => {
		const world = volume(memStore())
		const path = join(dir, 'state.sqlite')
		faux.setResponses([
			fauxAssistantMessage('one'),
			fauxAssistantMessage('two'),
			fauxAssistantMessage('three')
		])
		// 2026-10-20 in Auckland, then 2026-10-19 in UTC.
		for (const [i, timeZone] of ['Pacific/Auckland', 'UTC', 'UTC'].entries()) {
			const ghost = await openOn(path, undefined, world, { timeZone })
			await ghost.ask(`Turn ${i}.`, { id: String(i) })
			await ghost.close()
		}

		expect(await world.exists('/system/agents/main/transcripts/test/2026-10-19.jsonl')).toBe(false)
		expect(await mirrorOf(world, 'test', '2026-10-20')).toMatchObject([
			{ kind: 'user', text: 'Turn 0.' },
			{ kind: 'assistant', text: 'one' },
			{ kind: 'user', text: 'Turn 1.' },
			{ kind: 'assistant', text: 'two' },
			{ kind: 'user', text: 'Turn 2.' },
			{ kind: 'assistant', text: 'three' }
		])
	})

	it('writes the shell record at open and again after a turn', async () => {
		const world = volume(memStore())
		const ghost = await openOn(':memory:', [long], world)
		const recordOf = async () =>
			JSON.parse(dec(await world.readFile('/system/agents/main/shells/test.json')))

		expect(await recordOf()).toEqual({
			id: 'test',
			name: 'Test',
			kind: 'test',
			capabilities: ['read', 'write', 'edit', 'bash', 'transcript', 'long'],
			lastSeen: NOW.toISOString()
		})

		const later = new Date(NOW.getTime() + 60_000)
		vi.setSystemTime(later)
		faux.setResponses([fauxAssistantMessage('ok')])
		await ghost.ask('Hi', { id: 'h' })

		await vi.waitFor(async () => {
			expect((await recordOf()).lastSeen >= later.toISOString()).toBe(true)
		})
	})

	it("answers from another shell's transcript with transcript search and show", async () => {
		const world = volume(memStore())
		const laptop = { id: 'laptop', name: 'Laptop', kind: 'mac' }
		const desk = { id: 'desk', name: 'Desk', kind: 'mac' }
		faux.setResponses([fauxAssistantMessage('Pot it in peat-free compost.')])
		const first = await openOn(
			':memory:',
			undefined,
			world,
			{ timeZone: 'Pacific/Auckland' },
			laptop
		)
		await first.ask('How do I repot the fern?', { id: '1' })
		await first.close()

		let found = ''
		faux.setResponses([
			...calls(
				['transcript', { action: 'search', query: 'FERN repot' }],
				['transcript', { action: 'show', shell: 'laptop', date: '2026-10-20', range: '2' }]
			),
			(context) => {
				found = JSON.stringify(context.messages)
				return fauxAssistantMessage('You were repotting the fern on the laptop.')
			}
		])
		const second = await openOn(
			':memory:',
			undefined,
			world,
			{ timeZone: 'Pacific/Auckland' },
			desk
		)
		const settled = await second.ask('What was I doing in the other shell?', { id: 'q' })

		expect(settled).toMatchObject({ text: 'You were repotting the fern on the laptop.' })
		const [search, show] = toolResults(second)
		expect(search?.text).toBe(
			'Times in Pacific/Auckland.\nlaptop 2026-10-20 #1 01:00 user: How do I repot the fern?'
		)
		expect(show?.text).toBe(
			'Shell laptop, 2026-10-20, times in Pacific/Auckland.\n#2 01:00 assistant: Pot it in peat-free compost.'
		)
		expect(found).toContain('Pot it in peat-free compost.')
	})
})

describe('daily consolidation', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(new Date('2026-10-19T12:00:00Z'))
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	const CORE = '/system/memory/core.md'
	const stateOf = (ghost: Ghost) => snapshotOf(ghost).status.consolidation
	const day = (iso: string) => vi.setSystemTime(new Date(`${iso}T09:00:00Z`))
	/** Long enough for a run that was going to start to have asked the model. */
	const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

	/**
	 * Answer consolidation requests with `answers` in turn, running the functions among them
	 * first, and everything else 'ok'; returns each consolidation request's prompt.
	 */
	function consolidations(...answers: (string | (() => unknown))[]): string[] {
		const requests: string[] = []
		const steps = [...answers]
		faux.setResponses(
			Array.from({ length: 40 }, () => async (context: { messages: readonly object[] }) => {
				const [system] = context.messages as { role: string; content?: unknown }[]
				if (!String(system?.content).startsWith('You are extracting durable facts'))
					return fauxAssistantMessage('ok')
				requests.push(String((context.messages.at(-1) as { content: unknown }).content))
				for (let step = steps.shift(); step !== undefined; step = steps.shift()) {
					if (typeof step === 'string') return fauxAssistantMessage(step)
					await step()
				}
				throw new Error('no answer left')
			})
		)
		return requests
	}

	it("appends the finished days' notes from every shell to core.md after an ask, and waits for the next", async () => {
		const world = volume(memStore())
		await put(world, CORE, '- Likes tea.\n')
		const requests = consolidations('- Prefers dark mode.')
		const ghost = await openOn(':memory:', undefined, world)
		expect(stateOf(ghost)).toEqual({ from: '2026-10-19', running: false })
		await put(world, '/system/memory/daily/2026-10-19.test.md', '- Fixed the login test.')
		await put(world, '/system/memory/daily/2026-10-19.laptop.md', '- Prefers dark mode.')
		// The 19th is not over yet.
		await ghost.ask('Same day.', { id: '1' })
		await settle()
		expect(requests).toEqual([])

		day('2026-10-20')
		await put(world, '/system/memory/daily/2026-10-20.test.md', '- Still today.')
		await settle()
		expect(requests).toEqual([])
		await ghost.ask('Next day.', { id: '2' })

		await vi.waitFor(() => expect(stateOf(ghost)).toEqual({ from: '2026-10-20', running: false }))
		expect(dec(await world.readFile(CORE))).toBe(
			'- Likes tea.\n\n## 2026-10-19\n\n- Prefers dark mode.\n'
		)
		expect(requests).toHaveLength(1)
		expect(requests[0]).toContain('- Likes tea.')
		expect(requests[0]).toContain('# Daily notes, 2026-10-19, shell laptop\n\n- Prefers dark mode.')
		expect(requests[0]).toContain(
			'# Daily notes, 2026-10-19, shell test\n\n- Fixed the login test.'
		)
		expect(requests[0]).not.toContain('Still today')
		expect(await world.exists(`${CORE}.tmp`)).toBe(false)
	})

	it('waits for the asks queued behind the one that answered', async () => {
		const world = volume(memStore())
		const order: string[] = []
		let release: () => void = () => {}
		const held = new Promise<void>((resolve) => {
			release = resolve
		})
		faux.setResponses([
			async () => {
				await held
				order.push('first')
				return fauxAssistantMessage('one')
			},
			// Slow, so a run that did not wait for it would ask the model first.
			async () => {
				await settle()
				order.push('second')
				return fauxAssistantMessage('two')
			},
			() => {
				order.push('consolidation')
				return fauxAssistantMessage('- From A.')
			}
		])
		const ghost = await openOn(':memory:', undefined, world)
		await put(world, '/system/memory/daily/2026-10-19.test.md', '- A.')
		day('2026-10-20')

		const first = ghost.ask('First.', { id: '1' })
		await vi.waitFor(() => expect(snapshotOf(ghost).status.busy).toBe(true))
		const second = ghost.ask('Second.', { id: '2' })
		await vi.waitFor(() => expect(snapshotOf(ghost).status.queued).toBe(1))
		release()
		await Promise.all([first, second])

		await vi.waitFor(() => expect(stateOf(ghost)).toEqual({ from: '2026-10-20', running: false }))
		expect(order).toEqual(['first', 'second', 'consolidation'])
	})

	it('leaves core.md alone when it changed during the run, and takes those days again the next', async () => {
		const world = volume(memStore())
		await put(world, CORE, '- Likes tea.\n')
		const requests = consolidations(
			// The agent appends a bullet while the run's answer is being made.
			() => world.appendFile(CORE, enc('- Added meanwhile.\n')),
			'- From A.',
			'- From A and B.'
		)
		const ghost = await openOn(':memory:', undefined, world)
		await put(world, '/system/memory/daily/2026-10-19.test.md', '- A.')

		day('2026-10-20')
		await ghost.ask('hi', { id: '1' })
		await vi.waitFor(() => {
			expect(requests).toHaveLength(1)
			expect(stateOf(ghost)).toEqual({ from: '2026-10-19', running: false })
		})
		expect(dec(await world.readFile(CORE))).toBe('- Likes tea.\n- Added meanwhile.\n')

		await put(world, '/system/memory/daily/2026-10-20.test.md', '- B.')
		day('2026-10-21')
		await ghost.ask('hi', { id: '2' })
		await vi.waitFor(() => expect(stateOf(ghost)).toEqual({ from: '2026-10-21', running: false }))
		expect(dec(await world.readFile(CORE))).toBe(
			'- Likes tea.\n- Added meanwhile.\n\n## 2026-10-19 to 2026-10-20\n\n- From A and B.\n'
		)
		expect(requests[1]).toContain('- A.')
		expect(requests[1]).toContain('- B.')
	})

	it('takes every day missed while closed after the first ask, not at open', async () => {
		const path = join(dir, 'state.sqlite')
		const world = volume(memStore())
		for (const day of ['2026-10-19', '2026-10-20', '2026-10-21'])
			await put(world, `/system/memory/daily/${day}.test.md`, `- On ${day}.`)
		const requests = consolidations('- Three days.')
		await (await openOn(path, undefined, world)).close()

		day('2026-10-22')
		const ghost = await openOn(path, undefined, world)
		await settle()
		expect(requests).toEqual([])
		await ghost.ask('Morning.', { id: '1' })

		await vi.waitFor(() => expect(stateOf(ghost)).toEqual({ from: '2026-10-22', running: false }))
		expect(dec(await world.readFile(CORE))).toBe('## 2026-10-19 to 2026-10-21\n\n- Three days.\n')
		for (const day of ['2026-10-19', '2026-10-20', '2026-10-21'])
			expect(requests[0]).toContain(`- On ${day}.`)
	})

	it('keeps one task however often consolidation was turned off and on', async () => {
		const path = join(dir, 'state.sqlite')
		const world = volume(memStore())
		await put(world, '/system/memory/daily/2026-10-19.test.md', '- A.')
		const requests = consolidations('- From A.', '- Again.')
		for (let i = 0; i < 51; i++) {
			await (await openOn(path, undefined, world)).close()
			await (await openOn(path, undefined, world, { consolidate: false })).close()
		}
		await (await openOn(path, undefined, world)).close()
		const ghost = await openOn(path, undefined, world)

		day('2026-10-20')
		await ghost.ask('hi', { id: '1' })

		await vi.waitFor(() => expect(stateOf(ghost)).toEqual({ from: '2026-10-20', running: false }))
		await settle()
		expect(requests).toHaveLength(1)
	})

	it('neither runs nor writes with consolidation off, and stops a task armed before', async () => {
		const path = join(dir, 'state.sqlite')
		const world = volume(memStore())
		await put(world, '/system/memory/daily/2026-10-19.test.md', '- A.')
		const requests = consolidations('- From A.')
		await (await openOn(path, undefined, world)).close()

		const ghost = await openOn(path, undefined, world, { consolidate: false })
		day('2026-10-20')
		await ghost.ask('hi', { id: '1' })
		await settle()

		expect(stateOf(ghost)).toBeUndefined()
		expect(requests).toEqual([])
		expect(await world.exists(CORE)).toBe(false)
	})

	it('takes the days of a run whose write failed at the next', async () => {
		const world = volume(memStore())
		let failures = 1
		const flaky = new Proxy(world, {
			get(target, key) {
				if (key !== 'writeFile') return Reflect.get(target, key)
				return async (...args: Parameters<Volume['writeFile']>) => {
					if (args[0] === `${CORE}.tmp` && failures-- > 0) throw new Error('EIO: disk')
					return target.writeFile(...args)
				}
			}
		})
		const requests = consolidations('- From A.', '- From A and B.')
		const ghost = await openOn(':memory:', undefined, flaky)
		await put(world, '/system/memory/daily/2026-10-19.test.md', '- A.')

		day('2026-10-20')
		await ghost.ask('hi', { id: '1' })
		await vi.waitFor(() => {
			expect(requests).toHaveLength(1)
			expect(stateOf(ghost)).toEqual({ from: '2026-10-19', running: false })
		})
		expect(await world.exists(CORE)).toBe(false)

		await put(world, '/system/memory/daily/2026-10-20.test.md', '- B.')
		day('2026-10-21')
		await ghost.ask('hi', { id: '2' })
		await vi.waitFor(() => expect(stateOf(ghost)).toEqual({ from: '2026-10-21', running: false }))
		expect(dec(await world.readFile(CORE))).toBe('## 2026-10-19 to 2026-10-20\n\n- From A and B.\n')
		expect(requests[1]).toContain('- A.')
	})

	it('keeps the days a run left for the next one through a reopen and a rotation', async () => {
		const path = join(dir, 'state.sqlite')
		const world = volume(memStore())
		await put(world, CORE, '- Likes tea.\n')
		const requests = consolidations(
			() => world.appendFile(CORE, enc('- Added meanwhile.\n')),
			'- From A.',
			'- From A and B.'
		)
		const first = await openOn(path, undefined, world)
		await put(world, '/system/memory/daily/2026-10-19.test.md', '- A.')
		day('2026-10-20')
		await first.ask('hi', { id: '1' })
		await vi.waitFor(() => {
			expect(requests).toHaveLength(1)
			expect(stateOf(first)).toEqual({ from: '2026-10-19', running: false })
		})
		await first.close()

		// Two megabytes that make the open rotate.
		const state = await openNodeSqliteState(path)
		await state.exec('CREATE TABLE ballast (bytes BLOB)')
		await state.run('INSERT INTO ballast VALUES (zeroblob(2097152))')
		const ghost = await openBounded(state, world, 1024 * 1024)
		await vi.waitFor(async () => expect(await tables(state)).not.toContain('ballast'))
		await put(world, '/system/memory/daily/2026-10-20.test.md', '- B.')
		day('2026-10-21')
		await ghost.ask('hi', { id: '2' })

		await vi.waitFor(() => expect(stateOf(ghost)).toEqual({ from: '2026-10-21', running: false }))
		expect(requests[1]).toContain('# Daily notes, 2026-10-19, shell test')
		expect(dec(await world.readFile(CORE))).toBe(
			'- Likes tea.\n- Added meanwhile.\n\n## 2026-10-19 to 2026-10-20\n\n- From A and B.\n'
		)
	})

	it('keeps the days of a run a rotation cuts off', async () => {
		const path = join(dir, 'state.sqlite')
		const world = volume(memStore())
		await put(world, '/system/memory/daily/2026-10-19.test.md', '- A.')
		await put(world, '/system/memory/daily/2026-10-20.test.md', '- B.')
		const requests: string[] = []
		let hold = true
		faux.setResponses(
			Array.from(
				{ length: 20 },
				() => (context: { messages: readonly object[] }, options?: { signal?: AbortSignal }) => {
					const [system] = context.messages as { role: string; content?: unknown }[]
					if (!String(system?.content).startsWith('You are extracting durable facts'))
						return fauxAssistantMessage('ok')
					requests.push(String((context.messages.at(-1) as { content: unknown }).content))
					// The first run waits on the model until the rotation closes it.
					if (hold)
						return new Promise<never>((_, reject) =>
							options?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
						)
					return fauxAssistantMessage('- From A and B.')
				}
			)
		)
		await (await openOn(path, undefined, world)).close()

		day('2026-10-21')
		const state = await openNodeSqliteState(path)
		const ghost = await openBounded(state, world, 1024 * 1024)
		await state.exec('CREATE TABLE ballast (bytes BLOB)')
		await state.run('INSERT INTO ballast VALUES (zeroblob(2097152))')
		await ghost.ask('first', { id: '1' })
		await vi.waitFor(() => expect(requests).toHaveLength(1))
		await vi.waitFor(async () => expect(await tables(state)).not.toContain('ballast'))
		hold = false
		await ghost.ask('second', { id: '2' })

		await vi.waitFor(() => expect(stateOf(ghost)).toEqual({ from: '2026-10-21', running: false }))
		expect(requests[1]).toContain('- A.')
		expect(requests[1]).toContain('- B.')
	})

	it('starts the new generation at the day a rotation the process died in kept', async () => {
		const world = volume(memStore())
		await put(world, '/system/memory/daily/2026-10-17.test.md', '- Older.')
		const state = await openNodeSqliteState(':memory:')
		await state.exec(
			'CREATE TABLE ghost_state (singleton INTEGER PRIMARY KEY, generation INTEGER NOT NULL, carried TEXT NOT NULL)'
		)
		await state.run(`INSERT INTO ghost_state VALUES (1, 1, '{"from":"2026-10-17"}')`)
		const requests = consolidations('- From the 17th.')
		const ghost = await openBounded(state, world, Number.POSITIVE_INFINITY)

		await ghost.ask('hi', { id: '1' })

		await vi.waitFor(() => expect(stateOf(ghost)).toEqual({ from: '2026-10-19', running: false }))
		expect(requests[0]).toContain('- Older.')
	})

	it('rotates state that outgrew its bound after the run', async () => {
		const world = volume(memStore())
		const state = await openNodeSqliteState(':memory:')
		const requests = consolidations(async () => {
			// Two megabytes the next generation leaves behind with the rest of this one.
			await state.exec('CREATE TABLE ballast (bytes BLOB)')
			await state.run('INSERT INTO ballast VALUES (zeroblob(2097152))')
		}, '- Asked once.')
		const ghost = await openBounded(state, world, 1024 * 1024)
		await put(world, '/system/memory/daily/2026-10-19.test.md', '- A.')
		day('2026-10-20')

		await ghost.ask('first', { id: '1' })

		await vi.waitFor(() => expect(snapshotOf(ghost).transcript.entries).toEqual([]))
		expect(requests).toHaveLength(1)
		expect(stateOf(ghost)).toEqual({ from: '2026-10-20', running: false })
		expect(await tables(state)).toEqual(expect.arrayContaining(['g1_entries', 'ghost_state']))
		expect((await tables(state)).filter((name) => !/^(g1_|ghost_state$)/.test(name))).toEqual([])
	})
})

describe('state rotation', () => {
	it('moves to a fresh generation once the state outgrows its bound, after a note on the old one', async () => {
		const path = join(dir, 'state.sqlite')
		const world = volume(memStore())
		faux.setResponses([fauxAssistantMessage('one'), fauxAssistantMessage('two')])
		const first = await openOn(path, undefined, world)
		await first.ask('first', { id: '1' })
		await first.ask('second', { id: '2' })
		await first.close()

		faux.setResponses([fauxAssistantMessage('- Asked twice.'), fauxAssistantMessage('three')])
		const second = await openBounded(await openNodeSqliteState(path), world, 0)
		const settled = await second.ask('third', { id: '3' })

		expect(settled).toEqual({ id: '3', status: 'done', text: 'three' })
		expect(snapshotOf(second).transcript.entries).toMatchObject([
			{ kind: 'user', text: 'third' },
			{ kind: 'assistant', text: 'three' }
		])
		expect(await dailyOf(world, today())).toBe('- Asked twice.\n')
		expect(snapshotOf(second).status.consolidation).toEqual({ from: today(), running: false })
		await second.close()
		const state = await openNodeSqliteState(path)
		expect((await tables(state)).filter((name) => !/^(g1_|ghost_state$)/.test(name))).toEqual([])
		await state.close()

		// The new generation is the one a later open finds.
		const third = await openOn(path, undefined, world)
		expect(snapshotOf(third).transcript.entries).toMatchObject([
			{ kind: 'user', text: 'third' },
			{ kind: 'assistant', text: 'three' }
		])
	})

	it('answers a retry of an ask from before the rotation without asking again', async () => {
		const path = join(dir, 'state.sqlite')
		faux.setResponses([fauxAssistantMessage('Paris')])
		const first = await openOn(path)
		await first.ask('Capital of France?', { id: 'q1' })
		await first.close()

		faux.setResponses([fauxAssistantMessage('- Asked about France.')])
		const second = await openBounded(await openNodeSqliteState(path), volume(memStore()), 0)
		await vi.waitFor(() => expect(snapshotOf(second).transcript.entries).toEqual([]))
		const retried = await second.ask('Capital of France?', { id: 'q1' })
		await second.close()

		expect(retried).toEqual({ id: 'q1', status: 'done', text: 'Paris' })
		expect(faux.state.callCount).toBe(2)
		// Also once the process that rotated is gone.
		const third = await openOn(path)
		expect(await third.ask('Capital of France?', { id: 'q1' })).toEqual(retried)
		expect(snapshotOf(third).transcript.entries).toEqual([])
	})

	it('answers a retry that arrives during the rotation from the old generation', async () => {
		const path = join(dir, 'state.sqlite')
		faux.setResponses([fauxAssistantMessage('Paris')])
		const first = await openOn(path)
		await first.ask('Capital of France?', { id: 'q1' })
		await first.close()

		let noted: () => void = () => {}
		const noting = new Promise<void>((resolve) => {
			noted = resolve
		})
		faux.setResponses([
			async () => {
				await noting
				return fauxAssistantMessage('- Asked about France.')
			},
			fauxAssistantMessage('Asked again')
		])
		const second = await openBounded(await openNodeSqliteState(path), volume(memStore()), 0)
		await vi.waitFor(() => expect(faux.state.callCount).toBe(2))
		const retried = second.ask('Capital of France?', { id: 'q1' })
		noted()

		expect(await retried).toEqual({ id: 'q1', status: 'done', text: 'Paris' })
		expect(faux.state.callCount).toBe(2)
	})

	it('carries asks whose ids name Object properties, and does not mistake them for answers', async () => {
		const path = join(dir, 'state.sqlite')
		faux.setResponses([fauxAssistantMessage('Paris')])
		const first = await openOn(path)
		await first.ask('Capital of France?', { id: '__proto__' })
		await first.close()

		faux.setResponses([fauxAssistantMessage('- Asked about France.'), fauxAssistantMessage('Rome')])
		const second = await openBounded(await openNodeSqliteState(path), volume(memStore()), 0)
		await vi.waitFor(() => expect(snapshotOf(second).transcript.entries).toEqual([]))

		expect(await second.ask('Capital of France?', { id: '__proto__' })).toEqual({
			id: '__proto__',
			status: 'done',
			text: 'Paris'
		})
		expect(await second.ask('Capital of Italy?', { id: 'constructor' })).toEqual({
			id: 'constructor',
			status: 'done',
			text: 'Rome'
		})
		expect(faux.state.callCount).toBe(3)
	})

	it('mirrors the new generation after the old one, with ids that go on rising', async () => {
		const path = join(dir, 'state.sqlite')
		const world = volume(memStore())
		faux.setResponses([fauxAssistantMessage('one'), fauxAssistantMessage('two')])
		const first = await openOn(path, undefined, world)
		await first.ask('first', { id: '1' })
		await first.ask('second', { id: '2' })
		await first.close()

		faux.setResponses([fauxAssistantMessage('- Asked twice.'), fauxAssistantMessage('three')])
		const second = await openBounded(await openNodeSqliteState(path), world, 0)
		await vi.waitFor(() => expect(snapshotOf(second).transcript.entries).toEqual([]))
		await second.ask('third', { id: '3' })
		await second.close()
		// A reopen carries on from the mirrored ids, not the generation's own.
		faux.setResponses([fauxAssistantMessage('four')])
		const third = await openOn(path, undefined, world)
		await third.ask('fourth', { id: '4' })
		await third.close()

		const lines = parseLines(
			dec(await world.readFile(`/system/agents/main/transcripts/test/${today()}.jsonl`))
		)
		expect(lines.filter((line) => line.kind !== 'tool')).toMatchObject([
			{ kind: 'user', text: 'first' },
			{ kind: 'assistant', text: 'one' },
			{ kind: 'user', text: 'second' },
			{ kind: 'assistant', text: 'two' },
			{ kind: 'user', text: 'third' },
			{ kind: 'assistant', text: 'three' },
			{ kind: 'user', text: 'fourth' },
			{ kind: 'assistant', text: 'four' }
		])
		const ids = lines.map((line) => line.id)
		expect(ids).toEqual([...new Set(ids)].sort((a, b) => a - b))
	})

	it('keeps the old generation when its note fails, and rotates once one is taken', async () => {
		const path = join(dir, 'state.sqlite')
		const world = volume(memStore())
		let notesFail = true
		// Notes fail until told otherwise; every other request is answered 'ok'.
		faux.setResponses(
			Array.from({ length: 20 }, () => (context: { messages: readonly object[] }) => {
				const [system] = context.messages as { role: string; content?: unknown }[]
				if (system?.role !== 'system' || !String(system.content).startsWith('You are extracting'))
					return fauxAssistantMessage('ok')
				return notesFail
					? fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'down' })
					: fauxAssistantMessage('- Asked.')
			})
		)
		const first = await openOn(path, undefined, world)
		await first.ask('first', { id: '1' })
		await first.close()

		const ghost = await openBounded(await openNodeSqliteState(path), world, 0)
		await ghost.ask('second', { id: '2' })
		const state = await openNodeSqliteState(path)
		expect(await tables(state)).toContain('entries')
		await state.close()

		// The next check, after the next ask, tries again.
		notesFail = false
		await ghost.ask('third', { id: '3' })
		await vi.waitFor(() => expect(snapshotOf(ghost).transcript.entries).toEqual([]))
		expect(await dailyOf(world, today())).toBe('- Asked.\n')
	})

	it('rotates after an ask on a shell that does not consolidate', async () => {
		const world = volume(memStore())
		const state = await openNodeSqliteState(':memory:')
		faux.setResponses([fauxAssistantMessage('one'), fauxAssistantMessage('')])
		const ghost = await openBounded(state, world, 1024 * 1024, { consolidate: false })
		await state.exec('CREATE TABLE ballast (bytes BLOB)')
		await state.run('INSERT INTO ballast VALUES (zeroblob(2097152))')

		await ghost.ask('first', { id: '1' })

		await vi.waitFor(() => expect(snapshotOf(ghost).transcript.entries).toEqual([]))
		expect((await tables(state)).filter((name) => !/^(g1_|ghost_state$)/.test(name))).toEqual([])
	})

	it('drops the old generation at open when the process died before it did', async () => {
		const path = join(dir, 'state.sqlite')
		faux.setResponses([fauxAssistantMessage('one')])
		const first = await openOn(path)
		await first.ask('first', { id: '1' })
		await first.close()
		const state = await openNodeSqliteState(path)
		await state.run("INSERT INTO ghost_state (singleton, generation, carried) VALUES (1, 1, '{}')")

		const second = await openBounded(state, volume(memStore()), Number.POSITIVE_INFINITY)

		expect(snapshotOf(second).transcript.entries).toEqual([])
		expect((await tables(state)).filter((name) => !/^(g1_|ghost_state$)/.test(name))).toEqual([])
	})
})

async function tables(state: StateDatabase): Promise<string[]> {
	const rows = await state.all<{ name: string }>(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite%'"
	)
	return rows.map((row) => row.name)
}

describe('a new session each day', () => {
	// 2026-10-19 12:00 UTC; with the default boundary the next day starts at 04:00.
	const NOW = new Date('2026-10-19T12:00:00Z')

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(NOW)
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	const kinds = (ghost: Ghost) => snapshotOf(ghost).transcript.entries.map((entry) => entry.kind)

	/** Answers for an ask, the note on it, and the next day's ask; `next` is what that one saw. */
	function acrossDays() {
		const seen = { note: '', next: { messages: [] as { role: string }[] } }
		faux.setResponses([
			fauxAssistantMessage('noted'),
			(context) => {
				seen.note = JSON.stringify(context.messages)
				return fauxAssistantMessage('- The secret is 42.')
			},
			(context) => {
				seen.next = context
				return fauxAssistantMessage('fresh')
			}
		])
		return seen
	}

	it('starts a new session at the first ask of a day, with notes on the old one in its prompt', async () => {
		const world = volume(memStore())
		const ghost = await openOn(':memory:', undefined, world)
		const seen = acrossDays()
		await ghost.ask('The secret is 42.', { id: '1' })

		vi.setSystemTime(new Date('2026-10-20T04:00:00Z'))
		const settled = await ghost.ask('What now?', { id: '2' })

		expect(settled).toMatchObject({ status: 'done', text: 'fresh' })
		expect(seen.note).toContain('The secret is 42.')
		expect(await dailyOf(world, '2026-10-20')).toBe('- The secret is 42.\n')
		const sent = seen.next.messages.filter((message) => message.role !== 'system')
		expect(JSON.stringify(sent)).not.toContain('The secret is 42.')
		expect(systemPrompt(seen.next)).toContain('## 2026-10-20, shell test\n\n- The secret is 42.')
		expect(systemPrompt(seen.next)).toContain('Each day starts a new conversation')
		expect(snapshotOf(ghost).transcript.entries).toMatchObject([
			{ kind: 'reset' },
			{ kind: 'user', text: 'What now?' },
			{ kind: 'assistant', text: 'fresh' }
		])
	})

	it('keeps the session until the boundary hour', async () => {
		const ghost = await openOn(':memory:')
		faux.setResponses([fauxAssistantMessage('one'), fauxAssistantMessage('two')])
		await ghost.ask('First.', { id: '1' })

		vi.setSystemTime(new Date('2026-10-20T03:59:00Z'))
		await ghost.ask('Second.', { id: '2' })

		expect(kinds(ghost)).toEqual(['user', 'assistant', 'user', 'assistant'])
		expect(faux.state.callCount).toBe(2)
	})

	it('takes the day from the time zone, at its boundary hour', async () => {
		const world = volume(memStore())
		// 2026-10-20 01:00 in Auckland: before 04:00, so still the 19th's session.
		const ghost = await openOn(':memory:', undefined, world, { timeZone: 'Pacific/Auckland' })
		acrossDays()
		await ghost.ask('The secret is 42.', { id: '1' })

		// 04:00 on the 20th in Auckland, while UTC is still on the 19th.
		vi.setSystemTime(new Date('2026-10-19T15:00:00Z'))
		await ghost.ask('What now?', { id: '2' })

		expect(kinds(ghost)).toEqual(['reset', 'user', 'assistant'])
		expect(await dailyOf(world, '2026-10-20')).toBe('- The secret is 42.\n')
	})

	it('resets after a compaction that crossed the boundary and kept the old history', async () => {
		const ghost = await openOn(':memory:', undefined, undefined, {
			compaction: {
				reserveTokens: faux.getModel().contextWindow - 500,
				keepRecentTokens: 120,
				backgroundTokens: 0
			}
		})
		// Answers, notes and summaries alike, each timed when asked for; only the kinds and
		// times of the entries matter here.
		faux.setResponses(Array.from({ length: 12 }, () => () => fauxAssistantMessage('ok')))
		vi.setSystemTime(new Date('2026-10-19T03:00:00Z'))
		await ghost.ask('x'.repeat(2000), { id: 'a' })
		vi.setSystemTime(new Date('2026-10-19T03:50:00Z'))
		await ghost.ask('Still the same day.', { id: 'b' })
		// Past the boundary, a steer compacts without a reset: pi writes the system message
		// anew, with this time, ahead of the history it keeps from before the boundary.
		vi.setSystemTime(new Date('2026-10-19T04:10:00Z'))
		await ghost.ask('Go on.', { id: 'c', whenBusy: 'steer' })
		expect(kinds(ghost)).toContain('compaction')
		expect(kinds(ghost)).not.toContain('reset')

		vi.setSystemTime(new Date('2026-10-19T09:00:00Z'))
		await ghost.ask('What now?', { id: 'd' })

		expect(kinds(ghost)).toEqual(['reset', 'user', 'assistant'])
	})

	it('lets a steer into the running turn, whatever the day', async () => {
		const ghost = await openOn(':memory:')
		let started!: () => void
		const answering = new Promise<void>((resolve) => {
			started = resolve
		})
		let release!: () => void
		const held = new Promise<void>((resolve) => {
			release = resolve
		})
		faux.setResponses([
			async () => {
				started()
				await held
				return fauxAssistantMessage('one')
			},
			fauxAssistantMessage('two')
		])

		const first = ghost.ask('First.', { id: '1' })
		await answering
		vi.setSystemTime(new Date('2026-10-20T04:00:00Z'))
		const second = ghost.ask('Second.', { id: '2', whenBusy: 'steer' })
		release()
		await Promise.all([first, second])

		expect(kinds(ghost)).not.toContain('reset')
		expect(faux.state.callCount).toBe(2)
	})

	it('does not start another session when the day opens on a fresh one', async () => {
		const ghost = await openOn(':memory:')
		faux.setResponses([
			fauxAssistantMessage('one'),
			fauxAssistantMessage('- First.'),
			fauxAssistantMessage('two')
		])
		await ghost.ask('First.', { id: '1' })
		await ghost.newSession()

		vi.setSystemTime(new Date('2026-10-20T04:00:00Z'))
		await ghost.ask('Second.', { id: '2' })

		expect(kinds(ghost)).toEqual(['reset', 'user', 'assistant'])
		expect(faux.state.callCount).toBe(3)
	})

	it('answers a retried ask from its record without opening the day', async () => {
		const ghost = await openOn(':memory:')
		faux.setResponses([fauxAssistantMessage('one')])
		const first = await ghost.ask('First.', { id: '1' })

		vi.setSystemTime(new Date('2026-10-20T04:00:00Z'))
		const again = await ghost.ask('First.', { id: '1' })

		expect(again).toEqual(first)
		expect(kinds(ghost)).toEqual(['user', 'assistant'])
		expect(faux.state.callCount).toBe(1)
	})

	it('keeps one session across days with the boundary off', async () => {
		const ghost = await openOn(':memory:', undefined, undefined, { dayBoundary: false })
		faux.setResponses([
			(context) => {
				expect(systemPrompt(context)).not.toContain('Each day starts a new conversation')
				return fauxAssistantMessage('one')
			},
			fauxAssistantMessage('two')
		])
		await ghost.ask('First.', { id: '1' })

		vi.setSystemTime(new Date('2026-10-21T12:00:00Z'))
		await ghost.ask('Second.', { id: '2' })

		expect(kinds(ghost)).toEqual(['user', 'assistant', 'user', 'assistant'])
		expect(faux.state.callCount).toBe(2)
	})

	it('refuses a boundary that is not an hour', async () => {
		await expect(openOn(':memory:', undefined, undefined, { dayBoundary: 24 })).rejects.toThrow(
			'dayBoundary'
		)
	})
})
