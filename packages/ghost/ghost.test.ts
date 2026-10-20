import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall
} from '@earendil-works/pi-ai'
import { volume } from '@justfiles/fs'
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

async function openOn(path: string, tools?: Tool[]): Promise<Ghost> {
	const ghost = await openGhost({
		volume: volume(memStore()),
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
				{ kind: 'user', text: 'Capital of France?' },
				{ kind: 'assistant', text: 'Paris', toolCalls: [] }
			])
			const busy = events.flatMap((event) => (event.type === 'status' ? [event.status.busy] : []))
			expect(busy).toEqual([true, false])
		})
		const text = events.flatMap((event) => (event.type === 'text' ? [event.delta] : []))
		expect(text.join('')).toBe('Paris')
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
