import { describe, it, expect } from 'bun:test'
import { Effect } from 'effect'
import { memStorage } from '@justfiles/fs/storage/mem'
import { volume } from '@justfiles/fs'
import { makeSessionRuntime } from './effect/live.ts'
import { startNewSession } from './effect/programs.ts'
import { TranscriptStore } from './effect/services.ts'
import { PATHS } from './types.ts'
import type { GenerateText, TranscriptLine } from './types.ts'

const dec = new TextDecoder()

const mockGenerate: GenerateText = async (_sys, _user) => 'mock response'
const SESSION_ID = '2026-04-12T09-20-31Z_f83a'

function setup() {
	const vol = volume(memStorage())
	const runtime = makeSessionRuntime(vol, mockGenerate)
	return { vol, runtime }
}

describe('TranscriptStore', () => {
	it('append user turn writes a JSONL line', async () => {
		const { vol, runtime } = setup()
		try {
			await vol.mkdir(PATHS.activeSession(SESSION_ID), { recursive: true })
			await vol.writeFile(PATHS.transcript(SESSION_ID), new TextEncoder().encode(''))

			const line: TranscriptLine = { ts: '2026-04-12T09:20:31Z', role: 'user', content: 'hello' }
			await runtime.runPromise(
				Effect.flatMap(TranscriptStore, (store) => store.append(SESSION_ID, [line])),
			)

			const raw = dec.decode(await vol.readFile(PATHS.transcript(SESSION_ID)))
			expect(JSON.parse(raw.trim())).toEqual(line)
		} finally {
			await runtime.dispose()
		}
	})

	it('append multiple lines preserves JSONL ordering', async () => {
		const { vol, runtime } = setup()
		try {
			await vol.mkdir(PATHS.activeSession(SESSION_ID), { recursive: true })
			await vol.writeFile(PATHS.transcript(SESSION_ID), new TextEncoder().encode(''))

			const lines: TranscriptLine[] = [
				{ ts: '2026-04-12T09:20:31Z', role: 'user', content: 'hello' },
				{ ts: '2026-04-12T09:20:35Z', role: 'assistant', content: 'hi' },
			]
			await runtime.runPromise(
				Effect.flatMap(TranscriptStore, (store) => store.append(SESSION_ID, lines)),
			)

			const raw = dec.decode(await vol.readFile(PATHS.transcript(SESSION_ID)))
			expect(raw.trim().split('\n').map((line) => JSON.parse(line))).toEqual(lines)
		} finally {
			await runtime.dispose()
		}
	})

	it('readLastN returns the tail of the transcript in order', async () => {
		const { runtime } = setup()
		try {
			const sessionId = await runtime.runPromise(startNewSession())
			const lines: TranscriptLine[] = []
			for (let i = 0; i < 25; i++) {
				lines.push({
					ts: `2026-04-12T09:${String(i).padStart(2, '0')}:00Z`,
					role: 'user',
					content: `msg ${i}`,
				})
			}

			await runtime.runPromise(
				Effect.flatMap(TranscriptStore, (store) => store.append(sessionId, lines)),
			)
			const last20 = await runtime.runPromise(
				Effect.flatMap(TranscriptStore, (store) => store.readLastN(sessionId, 20)),
			)

			expect(last20).toHaveLength(20)
			expect(last20[0]).toEqual(lines[5])
			expect(last20[19]).toEqual(lines[24])
		} finally {
			await runtime.dispose()
		}
	})

	it('readAll returns all transcript lines', async () => {
		const { runtime } = setup()
		try {
			const sessionId = await runtime.runPromise(startNewSession())
			const lines: TranscriptLine[] = [
				{ ts: '2026-04-12T09:20:31Z', role: 'user', content: 'hello' },
				{ ts: '2026-04-12T09:20:35Z', role: 'assistant', content: 'hi' },
			]

			await runtime.runPromise(
				Effect.flatMap(TranscriptStore, (store) => store.append(sessionId, lines)),
			)
			const all = await runtime.runPromise(
				Effect.flatMap(TranscriptStore, (store) => store.readAll(sessionId)),
			)

			expect(all).toEqual(lines)
		} finally {
			await runtime.dispose()
		}
	})

	it('append to existing transcript preserves prior lines', async () => {
		const { runtime } = setup()
		try {
			const sessionId = await runtime.runPromise(startNewSession())

			await runtime.runPromise(
				Effect.flatMap(TranscriptStore, (store) =>
					store.append(sessionId, [
						{ ts: '2026-04-12T09:20:31Z', role: 'user', content: 'first' },
					]),
				),
			)
			await runtime.runPromise(
				Effect.flatMap(TranscriptStore, (store) =>
					store.append(sessionId, [
						{ ts: '2026-04-12T09:20:35Z', role: 'assistant', content: 'second' },
					]),
				),
			)

			const all = await runtime.runPromise(
				Effect.flatMap(TranscriptStore, (store) => store.readAll(sessionId)),
			)
			expect(all).toHaveLength(2)
			expect(all[0]!.role === 'user' && all[0]!.content).toBe('first')
			expect(all[1]!.role === 'assistant' && all[1]!.content).toBe('second')
		} finally {
			await runtime.dispose()
		}
	})
})
