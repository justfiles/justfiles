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

// ── Entry Identity ────────────────────────────────────────────────────────

/** 8-character hex string. Unique within a session. */
export type EntryId = string

// ── Entry Base ────────────────────────────────────────────────────────────

interface EntryBase {
	readonly id: EntryId
	/** Id of the preceding entry on this branch. Null only for the root. */
	readonly parentId: EntryId | null
	readonly ts: string  // ISO8601
}

// ── Concrete Entry Types ──────────────────────────────────────────────────

/**
 * A chat message — user input, assistant response, or tool interaction.
 * Mirrors the current TranscriptLine roles, extended with tree headers.
 */
export type MessageEntry = EntryBase & { readonly type: 'message' } & (
	| { readonly role: 'user'; readonly content: string }
	| { readonly role: 'assistant_thinking'; readonly content: string }
	| { readonly role: 'assistant'; readonly content: string }
	| { readonly role: 'tool_call'; readonly tool_name: string; readonly input: Record<string, unknown> }
	| { readonly role: 'tool_result'; readonly tool_name: string; readonly content: string }
)

/**
 * A compaction node. Not a rewrite — appended as a regular tree entry by the
 * manager when the active branch exceeds the token budget inside append().
 *
 * buildSessionContext() splices `summary` in place of everything before
 * `firstKeptEntryId` when it encounters this node during the leaf → root walk.
 * The folded entries remain on disk for audit and branching; they stop being
 * replayed into the model context.
 */
export interface CompactionEntry extends EntryBase {
	readonly type: 'compaction'
	readonly summary: string
	/** First entry still replayed verbatim (everything before it is folded). */
	readonly firstKeptEntryId: EntryId
	/** Token estimate of the folded prefix, for accounting. */
	readonly tokensBefore: number
}

/**
 * A postmortem note appended to a new branch after the user rewinds.
 * The model inherits the lesson ("we tried X, it failed because Y") without
 * replaying the failed subtree turn-by-turn.
 *
 * Reserved for future power-user branching UI. Not appended in normal flow.
 */
export interface BranchSummaryEntry extends EntryBase {
	readonly type: 'branch_summary'
	/** The abandoned leaf this branch diverged from. */
	readonly fromId: EntryId
	readonly summary: string
	readonly details?: string
}

/** Arbitrary named marker — e.g. session-start, phase boundary, checkpoint. */
export interface LabelEntry extends EntryBase {
	readonly type: 'label'
	readonly label: string
}

/** Discriminated union of all entry types. */
export type SessionEntry =
	| MessageEntry
	| CompactionEntry
	| BranchSummaryEntry
	| LabelEntry

// ── Append Input ──────────────────────────────────────────────────────────

/**
 * What the caller provides when appending. id / parentId / ts are assigned
 * by the manager. Only message entries are appendable — compaction is
 * internal to the manager and triggered automatically inside append().
 */
export type MessagePayload = { readonly type: 'message' } & (
	| { readonly role: 'user'; readonly content: string }
	| { readonly role: 'assistant_thinking'; readonly content: string }
	| { readonly role: 'assistant'; readonly content: string }
	| { readonly role: 'tool_call'; readonly tool_name: string; readonly input: Record<string, unknown> }
	| { readonly role: 'tool_result'; readonly tool_name: string; readonly content: string }
)

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

// ── Compaction Options ────────────────────────────────────────────────────

/**
 * Token budget hints passed to append(). The manager uses these to decide
 * whether the active branch needs compaction before writing new entries.
 */
export interface CompactionOptions {
	/** Estimated token count of the current system prompt. */
	readonly systemPromptTokens?: number
	/** Total context budget in tokens. Defaults to a conservative constant. */
	readonly contextBudget?: number
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
	 * Append message entries to the active branch.
	 *
	 * If the active branch exceeds the token budget (derived from
	 * compactionOptions), the manager compacts internally before writing:
	 * it generates a summary via TextGenerator, writes a CompactionEntry,
	 * then appends the new messages as children of that node. The caller
	 * observes none of this — append() always succeeds or throws.
	 */
	append(entries: ReadonlyArray<MessagePayload>, compactionOptions?: CompactionOptions): Promise<void>

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
