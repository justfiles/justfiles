import type { Models } from '@earendil-works/pi-ai'
import type { Volume } from '@justfiles/fs'

// The contract of `@justfiles/ghost`. Every type a caller sees is defined here; pi-ai's
// `Models` is the one external type, and no pi-durable type crosses this boundary.

/** Everything the ghost needs, handed in by the shell. */
export interface GhostDeps {
	/** The ghost's whole world: files, memory, transcripts. */
	volume: Volume
	/**
	 * Where the harness keeps conversation state. The ghost owns every table in it: rotating
	 * the state drops all but its own. Closed by `Ghost.close`.
	 */
	state: StateDatabase
	/** Built by the shell; credentials are the shell's. */
	models: Models
	shell: ShellRecord
	/**
	 * Machine capabilities, registered next to the ghost's own tools. The built-ins `read`,
	 * `write`, `edit`, `bash` and `transcript` are defaults: a tool with one's name replaces
	 * it. Two tools with one name make `openGhost` reject. A `bash` that replaces just-bash
	 * sets `GHOST_VOLUME` to the Volume's directory on the device; the prompt tells the agent to
	 * write Volume paths under it there.
	 */
	tools?: Tool[]
	settings?: GhostSettings
}

/** This shell: a device running the ghost, with its own conversation and state. */
export interface ShellRecord {
	id: string
	name: string
	kind: string
}

export interface GhostSettings {
	/** Without one, every ask fails. */
	model?: { provider: string; modelId: string }
	/** Names the day of the daily notes and the time in the prompt. Default `UTC`. */
	timeZone?: string
	/**
	 * Consolidation of every shell's daily notes into core.md, once a day in `timeZone` after
	 * an ask; on unless `false`. One shell per Volume has it on.
	 */
	consolidate?: boolean
	/** Automatic compaction; on unless `false`. An object tunes its thresholds, in tokens. */
	compaction?:
		| boolean
		| { reserveTokens?: number; keepRecentTokens?: number; backgroundTokens?: number }
}

export type SqlValue = null | number | bigint | string | Uint8Array

/** Six asynchronous methods; node:sqlite, a Durable Object's SQL, or ":memory:" all fit. */
export interface StateDatabase {
	exec(sql: string): Promise<void>
	run(sql: string, ...params: SqlValue[]): Promise<void>
	get<T extends object>(sql: string, ...params: SqlValue[]): Promise<T | undefined>
	all<T extends object>(sql: string, ...params: SqlValue[]): Promise<T[]>
	/** All work inside uses `tx`; calling the database itself from `fn` never settles. */
	transaction<T>(fn: (tx: Omit<StateDatabase, 'transaction' | 'close'>) => Promise<T>): Promise<T>
	close(): Promise<void>
}

/** TypeBox objects are JSON Schema, so either works. */
export type JsonSchema = object

/** A machine capability. A call cut off by a restart is not rerun; the model is told. */
export interface Tool<P = unknown> {
	name: string
	description: string
	parameters: JsonSchema
	/** `cwd` is the asking client's directory, a Volume path. Throwing is an error result. */
	execute(params: P, ctx: { signal: AbortSignal; cwd: string }): Promise<ToolResult>
}

export interface ToolResult {
	text: string
	isError?: boolean
}

export interface Ghost {
	/**
	 * Settles when the input is answered or fails, and rejects when the ghost closes first. A
	 * retry with the same `id`, also after reopening, waits for the same input instead of
	 * submitting it again.
	 */
	ask(
		text: string,
		opts: { id: string; whenBusy?: 'queue' | 'steer'; cwd?: string }
	): Promise<Settled>
	abort(): Promise<void>
	/**
	 * Start a new context; the model no longer sees older entries. Notes on the old one go to
	 * the daily file first, and `handoff` opens the new one.
	 */
	newSession(handoff?: string): Promise<void>
	/** The listener gets a snapshot first, then every change. Returns the unsubscribe. */
	watch(listener: (event: TranscriptEvent) => void): () => void
	close(): Promise<void>
}

export type Settled =
	| { id: string; status: 'done'; text: string }
	| { id: string; status: 'failed'; failure: Failure }

export interface Failure {
	kind: 'aborted' | 'auth' | 'quota' | 'context' | 'rate_limit' | 'network' | 'error'
	message: string
}

/** The active transcript: what the model sees, from the newest reset or compaction on. */
export interface Transcript {
	entries: TranscriptEntry[]
	/** The answer text written so far, while one is being generated. */
	partial?: string
}

/** `at` is when it was said, as an ISO time, when pi kept one. */
export type TranscriptEntry = (
	| {
			id: number
			kind: 'user'
			text: string
			/** The `id` the input was asked with. */
			askId?: string
	  }
	| {
			id: number
			kind: 'assistant'
			text: string
			toolCalls: { id: string; name: string; args: unknown }[]
			/** Set when the response failed or was aborted. */
			error?: string
	  }
	| { id: number; kind: 'tool'; callId: string; name: string; text: string; isError: boolean }
	| { id: number; kind: 'reset'; handoff?: string }
	| { id: number; kind: 'compaction'; summary: string }
) & { at?: string }

export interface GhostStatus {
	/** An input is being answered. */
	busy: boolean
	/** Inputs waiting for the current one. */
	queued: number
	/**
	 * The daily consolidation, absent when off: `from` is the first day whose notes are not in
	 * core.md yet, and `running` says a run is going, which the host keeps running for.
	 */
	consolidation?: { from: string; running: boolean }
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }
}

/**
 * Apply in order: `snapshot` replaces everything, `entry` appends to the transcript, `text`
 * extends `partial`, and `status` replaces the status. A reset or compaction comes as a
 * snapshot, since it drops earlier entries.
 */
export type TranscriptEvent =
	| { type: 'snapshot'; transcript: Transcript; status: GhostStatus }
	| { type: 'entry'; entry: TranscriptEntry }
	| { type: 'text'; delta: string }
	| { type: 'tool'; callId: string; name: string; args: unknown }
	| { type: 'status'; status: GhostStatus }
