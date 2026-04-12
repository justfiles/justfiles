import type { Volume } from '@justfiles/fs'
import type {
	SessionManager,
	TranscriptWriter,
	GenerateText,
	CurrentSession,
	SessionMeta,
	ResolveResult,
	InboxCandidate,
} from './types.ts'
import { PATHS } from './types.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()

const IDLE_TIMEOUT_MS = 6 * 60 * 60 * 1000 // 6 hours

export function generateSessionId(): string {
	const now = new Date()
	const iso = now.toISOString()
		.replace(/\.\d{3}Z$/, 'Z')   // strip millis
		.replace(/:/g, '-')           // colons → dashes
	const hex = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0')
	return `${iso}_${hex}`
}

export function createSessionManager(
	vol: Volume,
	transcript: TranscriptWriter,
	generateText: GenerateText,
): SessionManager {

	async function readTextFile(path: string): Promise<string | null> {
		try {
			if (!(await vol.exists(path))) return null
			return dec.decode(await vol.readFile(path))
		} catch {
			return null
		}
	}

	async function readJsonFile<T>(path: string): Promise<T | null> {
		const text = await readTextFile(path)
		if (text === null) return null
		return JSON.parse(text) as T
	}

	async function writeJsonFile(path: string, data: unknown): Promise<void> {
		await vol.writeFile(path, enc.encode(JSON.stringify(data, null, '\t')))
	}

	const manager: SessionManager = {
		async resolve(): Promise<ResolveResult> {
			const current = await readJsonFile<CurrentSession>(PATHS.currentSession)

			if (!current || current.current_session_id === null) {
				return {
					action: 'start_new',
					latest_handoff_path: current?.latest_handoff_path ?? null,
				}
			}

			const lastActivity = current.last_activity_at
				? new Date(current.last_activity_at).getTime()
				: 0
			const elapsed = Date.now() - lastActivity

			if (elapsed > IDLE_TIMEOUT_MS) {
				return {
					action: 'close_and_start',
					old_session_id: current.current_session_id,
					latest_handoff_path: current.latest_handoff_path,
				}
			}

			return {
				action: 'resume',
				session_id: current.current_session_id,
			}
		},

		async startNew(): Promise<string> {
			const sessionId = generateSessionId()

			// Create session directory
			await vol.mkdir(PATHS.activeSession(sessionId), { recursive: true })

			// Write meta.json
			const now = new Date().toISOString()
			const meta: SessionMeta = {
				session_id: sessionId,
				started_at: now,
				last_activity_at: now,
				turn_count: 0,
				state: 'active',
			}
			await writeJsonFile(PATHS.meta(sessionId), meta)

			// Write empty transcript
			await vol.writeFile(PATHS.transcript(sessionId), enc.encode(''))

			// Read existing current.json to preserve latest_handoff_path
			const existing = await readJsonFile<CurrentSession>(PATHS.currentSession)

			// Update current.json
			await vol.mkdir('/sessions', { recursive: true })
			const current: CurrentSession = {
				current_session_id: sessionId,
				last_activity_at: now,
				latest_handoff_path: existing?.latest_handoff_path ?? null,
			}
			await writeJsonFile(PATHS.currentSession, current)

			return sessionId
		},

		async touch(sessionId): Promise<SessionMeta> {
			const meta = await readJsonFile<SessionMeta>(PATHS.meta(sessionId))
			if (!meta) throw new Error(`Session not found: ${sessionId}`)

			meta.turn_count += 1
			meta.last_activity_at = new Date().toISOString()

			await writeJsonFile(PATHS.meta(sessionId), meta)

			// Also update current.json last_activity_at
			const current = await readJsonFile<CurrentSession>(PATHS.currentSession)
			if (current) {
				current.last_activity_at = meta.last_activity_at
				await writeJsonFile(PATHS.currentSession, current)
			}

			return meta
		},

		async close(sessionId): Promise<string> {
			// 1. Set state to closing
			const meta = await readJsonFile<SessionMeta>(PATHS.meta(sessionId))
			if (!meta) throw new Error(`Session not found: ${sessionId}`)
			meta.state = 'closing'
			await writeJsonFile(PATHS.meta(sessionId), meta)

			// 2. Read transcript for summary generation
			const lines = await transcript.readAll(sessionId)
			const transcriptText = lines.map(l => {
				if (l.role === 'user' || l.role === 'assistant') {
					return `[${l.role}] ${l.content}`
				}
				if (l.role === 'tool_call') {
					return `[tool_call: ${l.tool_name}] ${JSON.stringify(l.input)}`
				}
				return `[tool_result: ${l.tool_name}] ${l.content}`
			}).join('\n')

			// 3. Generate final-summary.md (LLM — placeholder in Phase 1)
			const finalSummary = await generateText(
				'You write concise session summaries.',
				`Summarize this session transcript:\n\n${transcriptText}`,
			)
			await vol.writeFile(
				`${PATHS.activeSession(sessionId)}/final-summary.md`,
				enc.encode(finalSummary),
			)

			// 4. Generate handoff.md (LLM — placeholder in Phase 1)
			const handoff = await generateText(
				'You write session handoff notes. Max 200 words.',
				`Write a handoff note for the next session based on:\n\n${transcriptText}`,
			)
			await vol.writeFile(
				`${PATHS.activeSession(sessionId)}/handoff.md`,
				enc.encode(handoff),
			)

			// 5. Move active → archive
			const archivePath = PATHS.archiveSession(sessionId)
			await vol.mkdir(archivePath, { recursive: true })

			// Copy files from active to archive
			const activeDir = PATHS.activeSession(sessionId)
			const entries = await vol.readdir(activeDir)
			for (const entry of entries) {
				await vol.cp(
					`${activeDir}/${entry.name}`,
					`${archivePath}/${entry.name}`,
				)
			}

			// 6. Update meta in archive to archived
			meta.state = 'archived'
			await writeJsonFile(`${archivePath}/meta.json`, meta)

			// 7. Remove active session directory
			await vol.rm(activeDir, { recursive: true })

			// 8. Update current.json
			const handoffPath = PATHS.archiveHandoff(sessionId)
			const current: CurrentSession = {
				current_session_id: null,
				last_activity_at: meta.last_activity_at,
				latest_handoff_path: handoffPath,
			}
			await writeJsonFile(PATHS.currentSession, current)

			return handoffPath
		},

		async maybeUpdateSummary(_sessionId, _meta): Promise<void> {
			// Phase 3 — placeholder
		},

		async getCurrent(): Promise<CurrentSession | null> {
			return readJsonFile<CurrentSession>(PATHS.currentSession)
		},

		async readSoul(): Promise<string | null> {
			return readTextFile(PATHS.soul)
		},

		async readProfile(): Promise<string | null> {
			return readTextFile(PATHS.profile)
		},

		async readRollingSummary(sessionId): Promise<string | null> {
			return readTextFile(PATHS.rollingSummary(sessionId))
		},

		async readHandoff(path): Promise<string | null> {
			return readTextFile(path)
		},

		async readInbox(): Promise<InboxCandidate[]> {
			// Phase 4 — placeholder
			return []
		},
	}

	return manager
}
