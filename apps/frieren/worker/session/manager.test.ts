import { describe, it, expect } from 'bun:test'
import { Effect } from 'effect'
import { memStorage } from '@justfiles/fs/storage/mem'
import { volume } from '@justfiles/fs'
import type { Volume } from '@justfiles/fs'
import { generateSessionId, makeSessionRuntime } from './effect/live.ts'
import {
	closeSession,
	maybeUpdateRollingSummary,
	persistTurn,
	resolveLifecycle,
	startNewSession,
	touchSession,
} from './effect/programs.ts'
import { SessionStore, TranscriptStore } from './effect/services.ts'
import { PATHS } from './types.ts'
import type { CurrentSession, GenerateText, SessionMeta } from './types.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()

const mockGenerate: GenerateText = async (_sys, _user) => 'mock response'

function setup() {
	const vol = volume(memStorage())
	const runtime = makeSessionRuntime(vol, mockGenerate)
	return { vol, runtime }
}

async function readJson<T>(vol: Volume, path: string): Promise<T> {
	return JSON.parse(dec.decode(await vol.readFile(path)))
}

describe('generateSessionId', () => {
	it('produces correct format (ISO datetime with colons replaced + 4-char hex)', () => {
		const id = generateSessionId()
		expect(id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z_[0-9a-f]{4}$/)
	})

	it('generates unique ids', () => {
		const ids = new Set<string>()
		for (let i = 0; i < 100; i++) {
			ids.add(generateSessionId())
		}
		expect(ids.size).toBeGreaterThan(90)
	})
})

describe('resolveLifecycle', () => {
	it('with no current.json returns start_new', async () => {
		const { runtime } = setup()
		try {
			const result = await runtime.runPromise(resolveLifecycle())
			expect(result).toEqual({ action: 'start_new', latest_handoff_path: null })
		} finally {
			await runtime.dispose()
		}
	})

	it('with current_session_id null preserves latest_handoff_path', async () => {
		const { vol, runtime } = setup()
		try {
			await vol.mkdir('/sessions', { recursive: true })
			const current: CurrentSession = {
				current_session_id: null,
				last_activity_at: null,
				latest_handoff_path: '/sessions/archive/2026-04-11T18-02-55Z_ab12/handoff.md',
			}
			await vol.writeFile(PATHS.currentSession, enc.encode(JSON.stringify(current)))

			const result = await runtime.runPromise(resolveLifecycle())
			expect(result).toEqual({
				action: 'start_new',
				latest_handoff_path: '/sessions/archive/2026-04-11T18-02-55Z_ab12/handoff.md',
			})
		} finally {
			await runtime.dispose()
		}
	})

	it('with active session under timeout returns resume', async () => {
		const { vol, runtime } = setup()
		try {
			await vol.mkdir('/sessions', { recursive: true })
			const current: CurrentSession = {
				current_session_id: '2026-04-12T09-20-31Z_f83a',
				last_activity_at: new Date().toISOString(),
				latest_handoff_path: null,
			}
			await vol.writeFile(PATHS.currentSession, enc.encode(JSON.stringify(current)))

			const result = await runtime.runPromise(resolveLifecycle())
			expect(result).toEqual({
				action: 'resume',
				session_id: '2026-04-12T09-20-31Z_f83a',
			})
		} finally {
			await runtime.dispose()
		}
	})

	it('with active session over timeout returns close_and_start', async () => {
		const { vol, runtime } = setup()
		try {
			await vol.mkdir('/sessions', { recursive: true })
			const stale = new Date(Date.now() - 7 * 60 * 60 * 1000)
			const current: CurrentSession = {
				current_session_id: '2026-04-12T09-20-31Z_f83a',
				last_activity_at: stale.toISOString(),
				latest_handoff_path: '/sessions/archive/old/handoff.md',
			}
			await vol.writeFile(PATHS.currentSession, enc.encode(JSON.stringify(current)))

			const result = await runtime.runPromise(resolveLifecycle())
			expect(result).toEqual({
				action: 'close_and_start',
				old_session_id: '2026-04-12T09-20-31Z_f83a',
				latest_handoff_path: '/sessions/archive/old/handoff.md',
			})
		} finally {
			await runtime.dispose()
		}
	})
})

describe('startNewSession', () => {
	it('creates correct directory structure and files', async () => {
		const { vol, runtime } = setup()
		try {
			const sessionId = await runtime.runPromise(startNewSession())

			expect(sessionId).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z_[0-9a-f]{4}$/)

			const meta = await readJson<SessionMeta>(vol, PATHS.meta(sessionId))
			expect(meta.session_id).toBe(sessionId)
			expect(meta.state).toBe('active')
			expect(meta.turn_count).toBe(0)
			expect(meta.started_at).toBeTruthy()
			expect(meta.last_activity_at).toBeTruthy()

			const transcript = dec.decode(await vol.readFile(PATHS.transcript(sessionId)))
			expect(transcript).toBe('')

			const current = await readJson<CurrentSession>(vol, PATHS.currentSession)
			expect(current.current_session_id).toBe(sessionId)
			expect(current.last_activity_at).toBeTruthy()
		} finally {
			await runtime.dispose()
		}
	})

	it('preserves latest_handoff_path when starting new session', async () => {
		const { vol, runtime } = setup()
		try {
			await vol.mkdir('/sessions', { recursive: true })
			const current: CurrentSession = {
				current_session_id: null,
				last_activity_at: null,
				latest_handoff_path: '/sessions/archive/old/handoff.md',
			}
			await vol.writeFile(PATHS.currentSession, enc.encode(JSON.stringify(current)))

			await runtime.runPromise(startNewSession())

			const updated = await readJson<CurrentSession>(vol, PATHS.currentSession)
			expect(updated.latest_handoff_path).toBe('/sessions/archive/old/handoff.md')
		} finally {
			await runtime.dispose()
		}
	})
})

describe('touchSession', () => {
	it('increments turn_count and updates last_activity_at', async () => {
		const { runtime } = setup()
		try {
			const sessionId = await runtime.runPromise(startNewSession())

			await runtime.runPromise(touchSession(sessionId))
			const meta1 = await runtime.runPromise(
				Effect.flatMap(SessionStore, (store) => store.loadMeta(sessionId)),
			)
			expect(meta1.turn_count).toBe(1)

			await runtime.runPromise(touchSession(sessionId))
			const meta2 = await runtime.runPromise(
				Effect.flatMap(SessionStore, (store) => store.loadMeta(sessionId)),
			)
			expect(meta2.turn_count).toBe(2)

			const diff = Date.now() - new Date(meta2.last_activity_at).getTime()
			expect(diff).toBeLessThan(5000)
		} finally {
			await runtime.dispose()
		}
	})
})

describe('closeSession', () => {
	it('archives the active session and updates current.json', async () => {
		const { vol, runtime } = setup()
		try {
			const sessionId = await runtime.runPromise(startNewSession())

			await runtime.runPromise(
				Effect.flatMap(TranscriptStore, (store) =>
					store.append(sessionId, [
						{ ts: '2026-04-12T09:20:31Z', role: 'user', content: 'hello' },
						{ ts: '2026-04-12T09:20:35Z', role: 'assistant', content: 'hi' },
					]),
				),
			)

			const handoffPath = await runtime.runPromise(closeSession(sessionId))

			expect(handoffPath).toContain('/sessions/archive/')
			expect(handoffPath).toContain(sessionId)
			expect(handoffPath).toEndWith('/handoff.md')

			const archiveDir = PATHS.archiveSession(sessionId)
			const entries = await vol.readdir(archiveDir)
			const names = entries.map((entry) => entry.name).sort()
			expect(names).toContain('meta.json')
			expect(names).toContain('transcript.jsonl')
			expect(names).toContain('handoff.md')
			expect(names).toContain('final-summary.md')

			const meta = await readJson<SessionMeta>(vol, `${archiveDir}/meta.json`)
			expect(meta.state).toBe('archived')
			expect(await vol.exists(PATHS.activeSession(sessionId))).toBe(false)

			const current = await readJson<CurrentSession>(vol, PATHS.currentSession)
			expect(current.current_session_id).toBeNull()
			expect(current.latest_handoff_path).toBe(handoffPath)
		} finally {
			await runtime.dispose()
		}
	})

	it('handles empty transcript gracefully', async () => {
		const { vol, runtime } = setup()
		try {
			const sessionId = await runtime.runPromise(startNewSession())
			const handoffPath = await runtime.runPromise(closeSession(sessionId))

			expect(handoffPath).toBeTruthy()
			expect(await vol.exists(`${PATHS.archiveSession(sessionId)}/handoff.md`)).toBe(true)
		} finally {
			await runtime.dispose()
		}
	})
})

describe('maybeUpdateRollingSummary', () => {
	it('writes a rolling summary after enough completed turns', async () => {
		const calls: Array<{ systemPrompt: string; userPrompt: string }> = []
		const generate: GenerateText = async (systemPrompt, userPrompt) => {
			calls.push({ systemPrompt, userPrompt })
			return '# Rolling Summary\nUser is building session summaries.'
		}
		const vol = volume(memStorage())
		const runtime = makeSessionRuntime(vol, generate)

		try {
			const sessionId = await runtime.runPromise(startNewSession())
			await runtime.runPromise(
				Effect.flatMap(TranscriptStore, (store) =>
					store.append(sessionId, [
						{ ts: 't1', role: 'user', content: 'first' },
						{ ts: 't2', role: 'assistant', content: 'one' },
						{ ts: 't3', role: 'user', content: 'second' },
						{ ts: 't4', role: 'assistant', content: 'two' },
						{ ts: 't5', role: 'user', content: 'third' },
						{ ts: 't6', role: 'assistant', content: 'three' },
					]),
				),
			)

			const updated = await runtime.runPromise(maybeUpdateRollingSummary(sessionId))

			expect(updated).toBe(true)
			expect(calls).toHaveLength(1)
			expect(calls[0]!.systemPrompt).toContain('rolling summary')
			expect(calls[0]!.userPrompt).toContain('Transcript:')
			expect(dec.decode(await vol.readFile(PATHS.rollingSummary(sessionId)))).toBe(
				'# Rolling Summary\nUser is building session summaries.',
			)
		} finally {
			await runtime.dispose()
		}
	})

	it('skips summary generation before the trigger threshold', async () => {
		const calls: Array<{ systemPrompt: string; userPrompt: string }> = []
		const generate: GenerateText = async (systemPrompt, userPrompt) => {
			calls.push({ systemPrompt, userPrompt })
			return 'unused'
		}
		const vol = volume(memStorage())
		const runtime = makeSessionRuntime(vol, generate)

		try {
			const sessionId = await runtime.runPromise(startNewSession())
			await runtime.runPromise(
				Effect.flatMap(TranscriptStore, (store) =>
					store.append(sessionId, [
						{ ts: 't1', role: 'user', content: 'first' },
						{ ts: 't2', role: 'assistant', content: 'one' },
						{ ts: 't3', role: 'user', content: 'second' },
						{ ts: 't4', role: 'assistant', content: 'two' },
					]),
				),
			)

			const updated = await runtime.runPromise(maybeUpdateRollingSummary(sessionId))

			expect(updated).toBe(false)
			expect(calls).toHaveLength(0)
			expect(await vol.exists(PATHS.rollingSummary(sessionId))).toBe(false)
		} finally {
			await runtime.dispose()
		}
	})
})

describe('persistTurn', () => {
	it('appends transcript lines and updates session activity', async () => {
		const { runtime } = setup()
		try {
			const sessionId = await runtime.runPromise(startNewSession())
			await runtime.runPromise(
				persistTurn({
					sessionId,
					lines: [
						{ ts: '2026-04-12T09:20:31Z', role: 'user', content: 'hello' },
						{ ts: '2026-04-12T09:20:35Z', role: 'assistant', content: 'hi' },
					],
				}),
			)

			const meta = await runtime.runPromise(
				Effect.flatMap(SessionStore, (store) => store.loadMeta(sessionId)),
			)
			const transcript = await runtime.runPromise(
				Effect.flatMap(TranscriptStore, (store) => store.readAll(sessionId)),
			)

			expect(meta.turn_count).toBe(1)
			expect(transcript).toHaveLength(2)
			expect(transcript[0]!.role).toBe('user')
			expect(transcript[1]!.role).toBe('assistant')
		} finally {
			await runtime.dispose()
		}
	})
})

describe('stores', () => {
	it('SessionStore.getCurrent returns persisted current session', async () => {
		const { vol, runtime } = setup()
		try {
			await vol.mkdir('/sessions', { recursive: true })
			const current: CurrentSession = {
				current_session_id: null,
				last_activity_at: null,
				latest_handoff_path: '/sessions/archive/old/handoff.md',
			}
			await vol.writeFile(PATHS.currentSession, enc.encode(JSON.stringify(current)))

			const loaded = await runtime.runPromise(
				Effect.flatMap(SessionStore, (store) => store.getCurrent()),
			)
			expect(loaded).toEqual(current)
		} finally {
			await runtime.dispose()
		}
	})
})
