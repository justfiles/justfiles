/**
 * Session system type definitions.
 *
 * These types define the surfaces between components:
 * - What's stored in the filesystem (file schemas)
 * - What the session programs return (resolve decisions)
 * - What crosses the boundary between components
 *
 * No implementation lives here — only shapes.
 */

// ── File Schemas ─────────────────────────────────────────────────────────
// These types mirror the JSON files stored in the Volume.

/**
 * `/sessions/current.json`
 *
 * Tracks the single active session for this account (one user = one DO).
 * Written by the session runtime. Read on every incoming message to decide
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
	inbox_extracted_at?: string // ISO8601; set by extractMemoryInbox
}

export type SessionState = 'active' | 'closing' | 'archived'

/**
 * One line in `/sessions/active/{session_id}/transcript.jsonl`.
 *
 * Append-only. Line types are discriminated by `role`.
 */
export type TranscriptLine =
	| { ts: string; role: 'user'; content: string }
	| { ts: string; role: 'assistant_thinking'; content: string }
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

/**
 * The result of session lifecycle resolution.
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

// ── LLM Boundary ────────────────────────────────────────────────────────
// The mockable interface for non-agent LLM calls (summaries, handoffs).

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
