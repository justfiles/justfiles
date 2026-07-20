/**
 * SessionManager interface — Pi-inspired tree-structured session transcript.
 *
 * Design principles:
 * - Every entry is a node in an append-only directed tree (parentId forms the
 *   graph). This is the same structure as Pi's session JSONL.
 * - The "active leaf" is the tail of the current branch. New entries are
 *   always appended as children of the active leaf.
 * - Compaction is internal to append(). When the tree exceeds the token
 *   budget, the manager generates a summary and writes a CompactionEntry
 *   before persisting the new messages. The caller never triggers or observes
 *   this — it is a growth side-effect, not a public operation.
 * - buildSessionContext() walks leaf → root and resolves compaction nodes,
 *   returning only what the LLM needs to see. It is a pure read.
 * - Branch / fork features are reserved but NOT IMPLEMENTED. The data model
 *   fully supports them; they are withheld until a UI surface exists.
 *
 * Adopting this schema replaces the flat TranscriptLine type. The walker
 * replaces loadRehydrationMessages + maybeUpdateRollingSummary slice logic.
 */

import { z } from 'zod'

export { session } from './session.manager.impl'

// ── Entry Identity ────────────────────────────────────────────────────────

/** 8-character hex string. Unique within a session. */
export type EntryId = string

// ── Schemas & Inferred Types ─────────────────────────────────────────────

const EntryBase = z.object({
	id: z.string(),
	parentId: z.string().nullable(),
	ts: z.string()
})

const UserMessage = EntryBase.extend({
	type: z.literal('message'),
	role: z.literal('user'),
	content: z.string(),
	source: z.enum(['user', 'app']).optional()
})

const AssistantThinkingMessage = EntryBase.extend({
	type: z.literal('message'),
	role: z.literal('assistant_thinking'),
	content: z.string()
})

const AssistantMessage = EntryBase.extend({
	type: z.literal('message'),
	role: z.literal('assistant'),
	content: z.string()
})

const ToolCallMessage = EntryBase.extend({
	type: z.literal('message'),
	role: z.literal('tool_call'),
	tool_name: z.string(),
	input: z.record(z.string(), z.unknown())
})

// A Volume-path reference to an image a tool offloaded (never inline base64) —
// the transcript renderer resolves `src` to displayable bytes per host (#194).
const ImageRefSchema = z.object({
	src: z.string(),
	mimeType: z.string(),
	alt: z.string().optional()
})

export type ImageRef = z.infer<typeof ImageRefSchema>

const ToolResultMessage = EntryBase.extend({
	type: z.literal('message'),
	role: z.literal('tool_result'),
	tool_name: z.string(),
	content: z.string(),
	images: z.array(ImageRefSchema).optional()
})

export const MessageEntrySchema = z.discriminatedUnion('role', [
	UserMessage,
	AssistantThinkingMessage,
	AssistantMessage,
	ToolCallMessage,
	ToolResultMessage
])

export type MessageEntry = z.infer<typeof MessageEntrySchema>

export const CompactionEntrySchema = EntryBase.extend({
	type: z.literal('compaction'),
	summary: z.string(),
	firstKeptEntryId: z.string(),
	tokensBefore: z.number()
})

export type CompactionEntry = z.infer<typeof CompactionEntrySchema>

export const BranchSummaryEntrySchema = EntryBase.extend({
	type: z.literal('branch_summary'),
	fromId: z.string(),
	summary: z.string(),
	details: z.string().optional()
})

export type BranchSummaryEntry = z.infer<typeof BranchSummaryEntrySchema>

export const LabelEntrySchema = EntryBase.extend({
	type: z.literal('label'),
	label: z.string()
})

export type LabelEntry = z.infer<typeof LabelEntrySchema>

export const SessionEntrySchema = z.union([
	MessageEntrySchema,
	CompactionEntrySchema,
	BranchSummaryEntrySchema,
	LabelEntrySchema
])

export type SessionEntry = z.infer<typeof SessionEntrySchema>

// ── Append Input ──────────────────────────────────────────────────────────

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type AppendPayload = DistributiveOmit<
	MessageEntry | CompactionEntry,
	'id' | 'parentId' | 'ts'
>

// ── Context Output ────────────────────────────────────────────────────────

/**
 * The model-visible message list returned by buildSessionContext().
 *
 * Carries only what the session has and what the conversion layer in frieren.ts
 * needs. AssistantMessage metadata (api, provider, model, usage, stopReason)
 * is not stored in the session — frieren.ts fills those from current config.
 *
 * ToolResultMessage is intentionally absent: toolCallId is not persisted and
 * old tool output should not live in active context.
 */
export type ContextMessage =
	| { readonly role: 'user'; readonly content: string; readonly timestamp: number }
	| { readonly role: 'assistant'; readonly content: string; readonly timestamp: number }

export type AppendResult = {
	compacted: boolean
	notes?: string
}

// ── SessionManager ────────────────────────────────────────────────────────

export interface SessionManager {
	readonly sessionId: string

	/**
	 * The current active leaf id. Every call to append() advances this.
	 * Null before any entry has been appended to this session.
	 */
	readonly activeLeafId: EntryId | null

	// ── Core: Write ──────────────────────────────────────────────────

	/**
	 * Append entries to the active branch.
	 *
	 * If the active branch exceeds the token budget (derived from
	 * compactionOptions), the manager compacts internally before writing:
	 * it generates a summary via TextGenerator, writes a CompactionEntry,
	 * then appends the new messages as children of that node. The caller
	 * observes none of this — append() always succeeds or throws.
	 */
	append(payloads: ReadonlyArray<AppendPayload>): Promise<AppendResult>

	// ── Core: Read ───────────────────────────────────────────────────

	/**
	 * Walk active leaf → root and resolve to the model-visible message list.
	 * This is what gets assigned to agent.state.messages before each LLM call.
	 * Pure read — never writes to the tree.
	 *
	 * Walk stops at the last CompactionEntry — never goes past it to the root:
	 * - the CompactionEntry.summary is emitted as a synthetic assistant message
	 * - entries from firstKeptEntryId → active leaf are emitted verbatim
	 *
	 * If no CompactionEntry exists, all entries root → leaf are emitted.
	 *
	 * Tool calls and tool results are stripped. The caller (frieren.ts) is
	 * responsible for filling in AssistantMessage metadata (api, provider,
	 * model, usage, stopReason) from current config.
	 */
	buildSessionContext(): Promise<ReadonlyArray<ContextMessage>>

	/**
	 * Walk the entire active branch root → leaf, returning all raw entries.
	 * Compaction nodes are included as data — this walk does not stop at them.
	 * Pure read — never writes to the tree.
	 *
	 * Used for UI history projection (users see their full conversation, not
	 * just the post-compaction tail), session-close archival, and memory
	 * extraction.
	 */
	walkActiveBranch(): Promise<ReadonlyArray<SessionEntry>>

	// ── Power User Features (NOT IMPLEMENTED) ────────────────────────
	// These methods reserve the API surface for future power-user UI.
	// Implementations should throw a descriptive error until they are built.

	/**
	 * Move the active leaf to an earlier entry, starting a new branch.
	 * The abandoned subtree stays on disk but is invisible to
	 * buildSessionContext() and walkActiveBranch().
	 *
	 * @throws {Error} Not implemented.
	 */
	branch(entryId: EntryId): Promise<void>

	/**
	 * Like branch(), but also appends a BranchSummaryEntry to the new branch
	 * with a postmortem note about the abandoned subtree.
	 *
	 * @throws {Error} Not implemented.
	 */
	branchWithSummary(entryId: EntryId, summary: string, details?: string): Promise<void>

	/**
	 * Fork this session into a new independent SessionManager starting from
	 * the current active leaf. The forked session has its own file and its
	 * own active leaf sequence; writes to either do not affect the other.
	 *
	 * @throws {Error} Not implemented.
	 */
	fork(): Promise<SessionManager>
}
