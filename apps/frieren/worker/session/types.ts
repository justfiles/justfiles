/**
 * Session system type definitions.
 *
 * These types define the surfaces between components:
 * - What's stored in the filesystem (file schemas)
 * - What the SessionManager returns (resolve decisions)
 * - What crosses the boundary between components
 *
 * No implementation lives here — only shapes.
 *
 * ## How the Agent hooks wire to sessions
 *
 * The Agent is long-lived (one per DO instance). Session management is
 * integrated via pi-agent-core hooks — not by recreating the Agent:
 *
 * - `transformContext`: injects rolling summary and windows recent turns
 *   before each LLM call. This is where context assembly happens per-turn.
 * - `subscribe()` → `turn_end`: records transcript, calls touch(), checks
 *   rolling summary trigger, checks turn limit for auto-close.
 * - `subscribe()` → `agent_end`: final persistence barrier.
 * - `agent.followUp()`: queues the reflection pass after session rotation
 *   so it runs before the user's next message reaches the LLM.
 *
 * The SessionManager owns all filesystem state. The hooks call into it.
 */

// ── File Schemas ─────────────────────────────────────────────────────────
// These types mirror the JSON files stored in the Volume.

/**
 * `/sessions/current.json`
 *
 * Tracks the single active session for this account (one user = one DO).
 * Written by SessionManager. Read on every incoming message to decide
 * whether to start, resume, or rotate a session.
 */
export interface CurrentSession {
	current_session_id: string | null
	last_activity_at: string | null   // ISO8601
	latest_handoff_path: string | null
}

/**
 * `/sessions/active/{session_id}/meta.json`
 *
 * Per-session metadata. Updated on every turn.
 */
export interface SessionMeta {
	session_id: string
	started_at: string          // ISO8601
	last_activity_at: string    // ISO8601
	turn_count: number
	state: SessionState
}

export type SessionState = 'active' | 'closing' | 'archived'

/**
 * One line in `/sessions/active/{session_id}/transcript.jsonl`.
 *
 * Append-only. Four line types, discriminated by `role`.
 */
export type TranscriptLine =
	| { ts: string; role: 'user'; content: string }
	| { ts: string; role: 'assistant'; content: string }
	| { ts: string; role: 'tool_call'; tool_name: string; input: Record<string, unknown> }
	| { ts: string; role: 'tool_result'; tool_name: string; content: string }

/**
 * `/memory/inbox/{YYYY-MM-DD-HHMM}-{slug}.md` frontmatter.
 *
 * Written at session close. Read during reflection at next session start.
 * Never modified after writing.
 */
export interface InboxCandidate {
	captured: string        // ISO8601
	session: string         // session_id
	confidence: 'low' | 'medium' | 'high'
	content: string         // the fact/observation body (after frontmatter)
}

// ── Session Manager ──────────────────────────────────────────────────────
// The single owner of session lifecycle and filesystem state.
// The Agent hooks call into this — it does not know about the Agent.

/**
 * The result of SessionManager.resolve().
 *
 * Tells the caller exactly what to do — no ambiguity.
 * The caller matches on `action` and follows the corresponding lifecycle.
 */
export type ResolveResult =
	| {
		action: 'start_new'
		latest_handoff_path: string | null
	}
	| {
		action: 'resume'
		session_id: string
	}
	| {
		action: 'close_and_start'
		old_session_id: string
		latest_handoff_path: string | null
	}

export interface SessionManager {
	/** Decide whether to start, resume, or rotate a session. */
	resolve(): Promise<ResolveResult>

	/** Create a new session. Returns the new session_id. */
	startNew(): Promise<string>

	/** Record activity: bump turn_count, set last_activity_at to now. */
	touch(sessionId: string): Promise<SessionMeta>

	/**
	 * Full session close:
	 * 1. Set state to 'closing'
	 * 2. Generate final-summary.md (LLM)
	 * 3. Generate handoff.md (LLM)
	 * 4. Write memory inbox candidates (LLM)
	 * 5. Move to archive (rename active → archive)
	 * 6. Set state to 'archived'
	 * 7. Update current.json
	 *
	 * Returns the handoff path in the archive.
	 */
	close(sessionId: string): Promise<string>

	/**
	 * Check if rolling summary needs regeneration, and regenerate if so.
	 * Called after every turn. Uses turn_count and token estimation
	 * to decide.
	 */
	maybeUpdateSummary(sessionId: string, meta: SessionMeta): Promise<void>

	// ── reads used by hooks ──────────────────────────────────────────────

	/** Read the current session state. Returns null if no current.json. */
	getCurrent(): Promise<CurrentSession | null>

	/** Read the system prompt (soul.md). Returns null if missing. */
	readSoul(): Promise<string | null>

	/** Read the user profile. Returns null if missing. */
	readProfile(): Promise<string | null>

	/** Read the rolling summary for a session. Returns null if missing. */
	readRollingSummary(sessionId: string): Promise<string | null>

	/** Read the handoff at the given path. Returns null if missing. */
	readHandoff(path: string): Promise<string | null>

	/** Read inbox files. Returns empty array if inbox is empty/missing. */
	readInbox(): Promise<InboxCandidate[]>
}

// ── Transcript ───────────────────────────────────────────────────────────

export interface TranscriptWriter {
	/** Append one or more lines to the session's transcript.jsonl. */
	append(sessionId: string, lines: TranscriptLine[]): Promise<void>

	/** Read the last N lines from the transcript. Returns fewer if transcript is shorter. */
	readLastN(sessionId: string, n: number): Promise<TranscriptLine[]>

	/** Read all lines. Used for final summary generation at session close. */
	readAll(sessionId: string): Promise<TranscriptLine[]>
}

// ── LLM Boundary ────────────────────────────────────────────────────────
// The mockable interface for all non-agent LLM calls (summaries, handoffs).

/**
 * Simple text generation function. All session-system LLM calls go through
 * this interface so they can be mocked in tests.
 *
 * The system prompt and user prompt are separate to match LLM conventions.
 */
export type GenerateText = (
	systemPrompt: string,
	userPrompt: string,
) => Promise<string>

// ── Filesystem Paths ─────────────────────────────────────────────────────
// Canonical paths in the Volume. Defined here so every component agrees.

export const PATHS = {
	soul: '/soul.md',
	profile: '/profiles/user.md',
	currentSession: '/sessions/current.json',
	activeSession: (id: string) => `/sessions/active/${id}`,
	meta: (id: string) => `/sessions/active/${id}/meta.json`,
	transcript: (id: string) => `/sessions/active/${id}/transcript.jsonl`,
	rollingSummary: (id: string) => `/sessions/active/${id}/rolling-summary.md`,
	archiveSession: (id: string) => `/sessions/archive/${id}`,
	archiveHandoff: (id: string) => `/sessions/archive/${id}/handoff.md`,
	memoryInbox: '/memory/inbox',
	memoryStructure: '/memory/STRUCTURE.md',
} as const
