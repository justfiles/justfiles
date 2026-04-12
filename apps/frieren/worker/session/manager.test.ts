import { describe, it, expect } from 'bun:test'
import { memStorage } from '@justfiles/fs/storage/mem'
import { volume } from '@justfiles/fs'
import type { Volume } from '@justfiles/fs'
import { createSessionManager, generateSessionId } from './manager.ts'
import { createTranscriptWriter } from './transcript.ts'
import { PATHS } from './types.ts'
import type { CurrentSession, SessionMeta, GenerateText } from './types.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()

const mockGenerate: GenerateText = async (_sys, _user) => 'mock response'

function setup() {
	const vol = volume(memStorage())
	const transcript = createTranscriptWriter(vol)
	const manager = createSessionManager(vol, transcript, mockGenerate)
	return { vol, transcript, manager }
}

async function readJson<T>(vol: Volume, path: string): Promise<T> {
	return JSON.parse(dec.decode(await vol.readFile(path)))
}

describe('generateSessionId', () => {
	it('produces correct format (ISO datetime with colons replaced + 4-char hex)', () => {
		const id = generateSessionId()
		// Format: YYYY-MM-DDTHH-MM-SSZ_xxxx
		expect(id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z_[0-9a-f]{4}$/)
	})

	it('generates unique ids', () => {
		const ids = new Set<string>()
		for (let i = 0; i < 100; i++) {
			ids.add(generateSessionId())
		}
		// At least most should be unique (hex suffix provides randomness)
		expect(ids.size).toBeGreaterThan(90)
	})
})

describe('SessionManager.resolve', () => {
	it('with no current.json → returns { action: "start_new" }', async () => {
		const { manager } = setup()
		const result = await manager.resolve()
		expect(result).toEqual({ action: 'start_new', latest_handoff_path: null })
	})

	it('with current_session_id: null → returns { action: "start_new", latest_handoff_path }', async () => {
		const { vol, manager } = setup()
		await vol.mkdir('/sessions', { recursive: true })
		const current: CurrentSession = {
			current_session_id: null,
			last_activity_at: null,
			latest_handoff_path: '/sessions/archive/2026-04-11T18-02-55Z_ab12/handoff.md',
		}
		await vol.writeFile(PATHS.currentSession, enc.encode(JSON.stringify(current)))

		const result = await manager.resolve()
		expect(result).toEqual({
			action: 'start_new',
			latest_handoff_path: '/sessions/archive/2026-04-11T18-02-55Z_ab12/handoff.md',
		})
	})

	it('with active session < 6h → returns { action: "resume", session_id }', async () => {
		const { vol, manager } = setup()
		await vol.mkdir('/sessions', { recursive: true })
		const now = new Date()
		const current: CurrentSession = {
			current_session_id: '2026-04-12T09-20-31Z_f83a',
			last_activity_at: now.toISOString(),
			latest_handoff_path: null,
		}
		await vol.writeFile(PATHS.currentSession, enc.encode(JSON.stringify(current)))

		const result = await manager.resolve()
		expect(result).toEqual({
			action: 'resume',
			session_id: '2026-04-12T09-20-31Z_f83a',
		})
	})

	it('with active session > 6h → returns { action: "close_and_start" }', async () => {
		const { vol, manager } = setup()
		await vol.mkdir('/sessions', { recursive: true })
		const stale = new Date(Date.now() - 7 * 60 * 60 * 1000) // 7 hours ago
		const current: CurrentSession = {
			current_session_id: '2026-04-12T09-20-31Z_f83a',
			last_activity_at: stale.toISOString(),
			latest_handoff_path: '/sessions/archive/old/handoff.md',
		}
		await vol.writeFile(PATHS.currentSession, enc.encode(JSON.stringify(current)))

		const result = await manager.resolve()
		expect(result).toEqual({
			action: 'close_and_start',
			old_session_id: '2026-04-12T09-20-31Z_f83a',
			latest_handoff_path: '/sessions/archive/old/handoff.md',
		})
	})
})

describe('SessionManager.startNew', () => {
	it('creates correct directory structure and files', async () => {
		const { vol, manager } = setup()

		const sessionId = await manager.startNew()

		// session_id has correct format
		expect(sessionId).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z_[0-9a-f]{4}$/)

		// meta.json exists with correct content
		const meta = await readJson<SessionMeta>(vol, PATHS.meta(sessionId))
		expect(meta.session_id).toBe(sessionId)
		expect(meta.state).toBe('active')
		expect(meta.turn_count).toBe(0)
		expect(meta.started_at).toBeTruthy()
		expect(meta.last_activity_at).toBeTruthy()

		// transcript.jsonl exists and is empty
		const transcript = dec.decode(await vol.readFile(PATHS.transcript(sessionId)))
		expect(transcript).toBe('')

		// current.json updated
		const current = await readJson<CurrentSession>(vol, PATHS.currentSession)
		expect(current.current_session_id).toBe(sessionId)
		expect(current.last_activity_at).toBeTruthy()
	})

	it('preserves latest_handoff_path when starting new session', async () => {
		const { vol, manager } = setup()
		// Pre-existing current.json with a handoff path
		await vol.mkdir('/sessions', { recursive: true })
		const current: CurrentSession = {
			current_session_id: null,
			last_activity_at: null,
			latest_handoff_path: '/sessions/archive/old/handoff.md',
		}
		await vol.writeFile(PATHS.currentSession, enc.encode(JSON.stringify(current)))

		await manager.startNew()

		const updated = await readJson<CurrentSession>(vol, PATHS.currentSession)
		expect(updated.latest_handoff_path).toBe('/sessions/archive/old/handoff.md')
	})
})

describe('SessionManager.touch', () => {
	it('increments turn_count and updates last_activity_at', async () => {
		const { vol, manager } = setup()
		const sessionId = await manager.startNew()

		const meta1 = await manager.touch(sessionId)
		expect(meta1.turn_count).toBe(1)

		const meta2 = await manager.touch(sessionId)
		expect(meta2.turn_count).toBe(2)

		// last_activity_at should be recent
		const diff = Date.now() - new Date(meta2.last_activity_at).getTime()
		expect(diff).toBeLessThan(5000)
	})
})

describe('SessionManager.close', () => {
	it('renames active to archive and updates current.json', async () => {
		const { vol, manager, transcript } = setup()
		const sessionId = await manager.startNew()

		// Add some transcript so close has something to work with
		await transcript.append(sessionId, [
			{ ts: '2026-04-12T09:20:31Z', role: 'user', content: 'hello' },
			{ ts: '2026-04-12T09:20:35Z', role: 'assistant', content: 'hi' },
		])

		const handoffPath = await manager.close(sessionId)

		// handoff path is in archive
		expect(handoffPath).toContain('/sessions/archive/')
		expect(handoffPath).toContain(sessionId)
		expect(handoffPath).toEndWith('/handoff.md')

		// Archive directory has expected files
		const archiveDir = PATHS.archiveSession(sessionId)
		const entries = await vol.readdir(archiveDir)
		const names = entries.map(e => e.name).sort()
		expect(names).toContain('meta.json')
		expect(names).toContain('transcript.jsonl')
		expect(names).toContain('handoff.md')
		expect(names).toContain('final-summary.md')

		// meta.json in archive has state: archived
		const meta = await readJson<SessionMeta>(vol, `${archiveDir}/meta.json`)
		expect(meta.state).toBe('archived')

		// Active directory no longer exists
		expect(await vol.exists(PATHS.activeSession(sessionId))).toBe(false)

		// current.json updated: session_id null, handoff path set
		const current = await readJson<CurrentSession>(vol, PATHS.currentSession)
		expect(current.current_session_id).toBeNull()
		expect(current.latest_handoff_path).toBe(handoffPath)
	})

	it('handles empty transcript gracefully', async () => {
		const { vol, manager } = setup()
		const sessionId = await manager.startNew()

		const handoffPath = await manager.close(sessionId)
		expect(handoffPath).toBeTruthy()

		// Should still produce files
		const archiveDir = PATHS.archiveSession(sessionId)
		expect(await vol.exists(`${archiveDir}/handoff.md`)).toBe(true)
	})
})

describe('SessionManager reads', () => {
	it('readSoul returns soul.md content', async () => {
		const { vol, manager } = setup()
		await vol.writeFile(PATHS.soul, enc.encode('I am Frieren'))
		const soul = await manager.readSoul()
		expect(soul).toBe('I am Frieren')
	})

	it('readSoul returns null when missing', async () => {
		const { manager } = setup()
		const soul = await manager.readSoul()
		expect(soul).toBeNull()
	})

	it('readProfile returns profile content', async () => {
		const { vol, manager } = setup()
		await vol.mkdir('/profiles', { recursive: true })
		await vol.writeFile(PATHS.profile, enc.encode('# Profile: user'))
		const profile = await manager.readProfile()
		expect(profile).toBe('# Profile: user')
	})

	it('readProfile returns null when missing', async () => {
		const { manager } = setup()
		const profile = await manager.readProfile()
		expect(profile).toBeNull()
	})

	it('readRollingSummary returns content when present', async () => {
		const { vol, manager } = setup()
		const sessionId = await manager.startNew()
		await vol.writeFile(PATHS.rollingSummary(sessionId), enc.encode('# Rolling Summary'))
		const summary = await manager.readRollingSummary(sessionId)
		expect(summary).toBe('# Rolling Summary')
	})

	it('readRollingSummary returns null when missing', async () => {
		const { manager } = setup()
		const summary = await manager.readRollingSummary('nonexistent')
		expect(summary).toBeNull()
	})

	it('readHandoff returns content at given path', async () => {
		const { vol, manager } = setup()
		const path = '/sessions/archive/2026-04-11T18-02-55Z_ab12/handoff.md'
		await vol.mkdir('/sessions/archive/2026-04-11T18-02-55Z_ab12', { recursive: true })
		await vol.writeFile(path, enc.encode('# Handoff'))
		const handoff = await manager.readHandoff(path)
		expect(handoff).toBe('# Handoff')
	})

	it('readHandoff returns null for missing path', async () => {
		const { manager } = setup()
		const handoff = await manager.readHandoff('/nonexistent/handoff.md')
		expect(handoff).toBeNull()
	})

	it('getCurrent returns null when no current.json', async () => {
		const { manager } = setup()
		const current = await manager.getCurrent()
		expect(current).toBeNull()
	})

	it('getCurrent returns parsed current.json', async () => {
		const { vol, manager } = setup()
		await vol.mkdir('/sessions', { recursive: true })
		const data: CurrentSession = {
			current_session_id: 'test',
			last_activity_at: '2026-04-12T09:20:31Z',
			latest_handoff_path: null,
		}
		await vol.writeFile(PATHS.currentSession, enc.encode(JSON.stringify(data)))
		const current = await manager.getCurrent()
		expect(current).toEqual(data)
	})
})
