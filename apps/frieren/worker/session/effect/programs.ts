import { Effect } from 'effect'
import { DEFAULT_SETUP_PROMPT } from '../context.ts'
import type { ResolveResult, TranscriptLine } from '../types.ts'
import type {
	CurrentSessionCorrupt,
	GenerationFailure,
	SessionNotFound,
	StorageFailure,
} from './errors.ts'
import { ContextStore, SessionClock, SessionIdGenerator, SessionStore, TextGenerator, TranscriptStore } from './services.ts'

const DEFAULT_IDLE_TIMEOUT_MS = 6 * 60 * 60 * 1000

const MEMORY_INSTRUCTIONS = `## Persistent memory

You have a filesystem for long-term memory. Use it proactively:

- **/profiles/user.md** — everything you know about the user. Read-before-write when updating it.
- **/soul.md** — your own identity and personality. Only rewrite this when explicitly asked.

If the user tells you something about themselves and you do NOT update /profiles/user.md, that information is lost after this turn.`

export interface BuildSystemPromptInput {
	readonly currentSessionId: string | null
	readonly isNewSession: boolean
	readonly latestHandoffPath: string | null
}

export interface PreparedTurn {
	readonly resolution: ResolveResult
	readonly currentSessionId: string
	readonly isNewSession: boolean
	readonly latestHandoffPath: string | null
	readonly systemPrompt: string
}

export interface PersistTurnInput {
	readonly sessionId: string
	readonly lines: ReadonlyArray<TranscriptLine>
}

export interface DisplayToolCall {
	name: string
	args: unknown
	result?: unknown
	isError?: boolean
}

export interface DisplayMessage {
	readonly role: 'user' | 'assistant'
	readonly content: string
	readonly thinking?: string
	readonly toolCalls?: ReadonlyArray<DisplayToolCall>
}

export const DEFAULT_HISTORY_LIMIT = 10

export const resolveLifecycle = (
	idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
): Effect.Effect<
	ResolveResult,
	CurrentSessionCorrupt | StorageFailure,
	SessionClock | SessionStore
> =>
	Effect.gen(function* () {
		const clock = yield* SessionClock
		const store = yield* SessionStore
		const current = yield* store.getCurrent()

		if (!current || current.current_session_id === null) {
			return {
				action: 'start_new',
				latest_handoff_path: current?.latest_handoff_path ?? null,
			} satisfies ResolveResult
		}

		const lastActivity = current.last_activity_at
			? new Date(current.last_activity_at).getTime()
			: 0
		const elapsed = (yield* clock.nowMillis()) - lastActivity

		if (elapsed > idleTimeoutMs) {
			return {
				action: 'close_and_start',
				old_session_id: current.current_session_id,
				latest_handoff_path: current.latest_handoff_path,
			} satisfies ResolveResult
		}

		return {
			action: 'resume',
			session_id: current.current_session_id,
		} satisfies ResolveResult
	})

export const startNewSession = (): Effect.Effect<
	string,
	CurrentSessionCorrupt | StorageFailure,
	SessionClock | SessionIdGenerator | SessionStore
> =>
	Effect.gen(function* () {
		const clock = yield* SessionClock
		const ids = yield* SessionIdGenerator
		const store = yield* SessionStore
		const sessionId = yield* ids.next()
		const now = yield* clock.nowIso()
		const existing = yield* store.getCurrent()

		yield* store.createSession({
			sessionId,
			now,
			latestHandoffPath: existing?.latest_handoff_path ?? null,
		})

		return sessionId
	})

export const touchSession = (
	sessionId: string,
): Effect.Effect<
	void,
	SessionNotFound | CurrentSessionCorrupt | StorageFailure,
	SessionClock | SessionStore
> =>
	Effect.gen(function* () {
		const clock = yield* SessionClock
		const store = yield* SessionStore
		const meta = yield* store.loadMeta(sessionId)
		const now = yield* clock.nowIso()

		yield* store.saveMeta({
			...meta,
			turn_count: meta.turn_count + 1,
			last_activity_at: now,
		})

		const current = yield* store.getCurrent()
		if (!current) return

		yield* store.writeCurrent({
			...current,
			last_activity_at: now,
		})
	})

export const buildSystemPrompt = (
	input: BuildSystemPromptInput,
): Effect.Effect<string, StorageFailure, ContextStore> =>
	Effect.gen(function* () {
		const store = yield* ContextStore
		const soul = yield* store.readSoul()
		if (!soul) return DEFAULT_SETUP_PROMPT

		const parts: Array<string> = [soul, MEMORY_INSTRUCTIONS]
		const profile = yield* store.readProfile()

		if (profile) parts.push(profile)

		if (input.currentSessionId) {
			if (input.isNewSession && input.latestHandoffPath) {
				const handoff = yield* store.readHandoff(input.latestHandoffPath)
				if (handoff) parts.push(handoff)
			} else {
				const summary = yield* store.readRollingSummary(input.currentSessionId)
				if (summary) parts.push(summary)
			}
		}

		return parts.join('\n\n---\n\n')
	})

export const closeSession = (
	sessionId: string,
): Effect.Effect<
	string,
	SessionNotFound | StorageFailure | GenerationFailure,
	SessionStore | TranscriptStore | TextGenerator
> =>
	Effect.gen(function* () {
		const store = yield* SessionStore
		const transcript = yield* TranscriptStore
		const text = yield* TextGenerator
		const meta = yield* store.loadMeta(sessionId)
		const closingMeta = { ...meta, state: 'closing' as const }

		yield* store.saveMeta(closingMeta)

		const lines = yield* transcript.readAll(sessionId)
		const transcriptText = serializeTranscript(lines)

		const finalSummary = yield* text.generate({
			step: 'final-summary',
			systemPrompt: 'You write concise session summaries.',
			userPrompt: `Summarize this session transcript:\n\n${transcriptText}`,
		})

		const handoff = yield* text.generate({
			step: 'handoff',
			systemPrompt: 'You write session handoff notes. Max 200 words.',
			userPrompt: `Write a handoff note for the next session based on:\n\n${transcriptText}`,
		})

		const archivedMeta = {
			...closingMeta,
			state: 'archived' as const,
		}

		const archived = yield* store.archiveSession({
			sessionId,
			finalSummary,
			handoff,
			archivedMeta,
		})

		yield* store.writeCurrent({
			current_session_id: null,
			last_activity_at: meta.last_activity_at,
			latest_handoff_path: archived.handoffPath,
		})

		return archived.handoffPath
	})

export const persistTurn = (
	input: PersistTurnInput,
): Effect.Effect<
	void,
	SessionNotFound | CurrentSessionCorrupt | StorageFailure,
	TranscriptStore | SessionClock | SessionStore
> =>
	Effect.gen(function* () {
		const transcript = yield* TranscriptStore

		if (input.lines.length > 0) {
			yield* transcript.append(input.sessionId, input.lines)
		}

		yield* touchSession(input.sessionId)
	})

export const prepareTurn = (): Effect.Effect<
	PreparedTurn,
	| SessionNotFound
	| CurrentSessionCorrupt
	| StorageFailure
	| GenerationFailure,
	SessionClock | SessionIdGenerator | SessionStore | TranscriptStore | ContextStore | TextGenerator
> =>
	Effect.gen(function* () {
		const resolution = yield* resolveLifecycle()

		switch (resolution.action) {
			case 'resume': {
				const systemPrompt = yield* buildSystemPrompt({
					currentSessionId: resolution.session_id,
					isNewSession: false,
					latestHandoffPath: null,
				})

				return {
					resolution,
					currentSessionId: resolution.session_id,
					isNewSession: false,
					latestHandoffPath: null,
					systemPrompt,
				}
			}

			case 'start_new': {
				const sessionId = yield* startNewSession()
				const systemPrompt = yield* buildSystemPrompt({
					currentSessionId: sessionId,
					isNewSession: true,
					latestHandoffPath: resolution.latest_handoff_path,
				})

				return {
					resolution,
					currentSessionId: sessionId,
					isNewSession: true,
					latestHandoffPath: resolution.latest_handoff_path,
					systemPrompt,
				}
			}

			case 'close_and_start': {
				yield* closeSession(resolution.old_session_id)
				const sessionId = yield* startNewSession()
				const systemPrompt = yield* buildSystemPrompt({
					currentSessionId: sessionId,
					isNewSession: true,
					latestHandoffPath: resolution.latest_handoff_path,
				})

				return {
					resolution,
					currentSessionId: sessionId,
					isNewSession: true,
					latestHandoffPath: resolution.latest_handoff_path,
					systemPrompt,
				}
			}
		}
	})

export type RehydrationLine =
	| { readonly role: 'user'; readonly content: string }
	| { readonly role: 'assistant'; readonly content: string }

export const DEFAULT_REHYDRATION_LIMIT = 40

export const loadRehydrationMessages = (
	sessionId: string,
	limit: number = DEFAULT_REHYDRATION_LIMIT,
): Effect.Effect<
	ReadonlyArray<RehydrationLine>,
	StorageFailure | SessionNotFound,
	TranscriptStore
> =>
	Effect.gen(function* () {
		const transcript = yield* TranscriptStore
		const lines = yield* transcript.readLastN(sessionId, limit * 4)
		const textOnly: RehydrationLine[] = []
		for (const line of lines) {
			if (line.role !== 'user' && line.role !== 'assistant') continue
			const prev = textOnly[textOnly.length - 1]
			if (prev && prev.role === line.role) {
				// Coalesce consecutive same-role lines. extractTranscriptLines
				// splits one model turn into multiple assistant lines whenever
				// tool calls are interleaved with text; after dropping tools
				// here, the survivors must be merged or providers reject the
				// back-to-back same-role sequence.
				textOnly[textOnly.length - 1] = {
					role: prev.role,
					content: prev.content + line.content,
				}
			} else {
				textOnly.push({ role: line.role, content: line.content })
			}
		}
		// Drop any leading assistant messages so the rehydrated tail always
		// starts at a user-message boundary — providers accept that shape
		// unambiguously and it avoids orphan assistant turns.
		let start = 0
		while (start < textOnly.length && textOnly[start]!.role !== 'user') {
			start++
		}

		const normalized = textOnly.slice(start)

		// A cold-start resume only happens once a *new* user prompt arrives.
		// If the transcript tail already ends in an unanswered user message from
		// a prior failed/aborted turn, rehydrating it would stack that stale
		// request directly before the fresh prompt. Local models then tend to
		// continue the old request instead of answering the new one.
		if (normalized.at(-1)?.role === 'user') {
			normalized.pop()
		}

		return normalized.slice(-limit)
	})

export const loadRecentHistory = (
	limit: number = DEFAULT_HISTORY_LIMIT,
): Effect.Effect<
	ReadonlyArray<DisplayMessage>,
	CurrentSessionCorrupt | StorageFailure | SessionNotFound,
	SessionStore | TranscriptStore
> =>
	Effect.gen(function* () {
		const store = yield* SessionStore
		const current = yield* store.getCurrent()
		if (!current || !current.current_session_id) return []

		const transcript = yield* TranscriptStore
		// Read more than `limit` lines so projection still yields up to
		// `limit` display messages even when tool calls inflate line count.
		const lines = yield* transcript.readLastN(current.current_session_id, limit * 4)
		const messages = projectTranscriptToDisplay(lines)
		return messages.slice(-limit)
	})

export function projectTranscriptToDisplay(
	lines: ReadonlyArray<TranscriptLine>,
): ReadonlyArray<DisplayMessage> {
	const out: DisplayMessage[] = []
	let currentAssistant: {
		role: 'assistant'
		content: string
		thinking: string
		toolCalls: DisplayToolCall[]
	} | null = null

	const flushAssistant = () => {
		if (!currentAssistant) return
		out.push({
			role: 'assistant',
			content: currentAssistant.content,
			...(currentAssistant.thinking.length > 0
				? { thinking: currentAssistant.thinking }
				: {}),
			...(currentAssistant.toolCalls.length > 0
				? { toolCalls: currentAssistant.toolCalls }
				: {}),
		})
		currentAssistant = null
	}

	for (const line of lines) {
		switch (line.role) {
			case 'user':
				flushAssistant()
				out.push({ role: 'user', content: line.content })
				break
			case 'assistant_thinking':
				if (!currentAssistant) {
					currentAssistant = { role: 'assistant', content: '', thinking: line.content, toolCalls: [] }
				} else {
					currentAssistant.thinking += line.content
				}
				break
			case 'assistant':
				if (!currentAssistant) {
					currentAssistant = { role: 'assistant', content: line.content, thinking: '', toolCalls: [] }
				} else {
					currentAssistant.content += line.content
				}
				break
			case 'tool_call':
				if (!currentAssistant) {
					currentAssistant = { role: 'assistant', content: '', thinking: '', toolCalls: [] }
				}
				currentAssistant.toolCalls.push({ name: line.tool_name, args: line.input })
				break
			case 'tool_result': {
				if (!currentAssistant) break
				for (let i = currentAssistant.toolCalls.length - 1; i >= 0; i--) {
					const tc = currentAssistant.toolCalls[i]!
					if (tc.name === line.tool_name && tc.result === undefined) {
						tc.result = line.content
						break
					}
				}
				break
			}
		}
	}
	flushAssistant()
	return out
}

function serializeTranscript(lines: ReadonlyArray<TranscriptLine>): string {
	return lines
		.map((line) => {
			switch (line.role) {
				case 'user':
				case 'assistant_thinking':
				case 'assistant':
					return `[${line.role}] ${line.content}`
				case 'tool_call':
					return `[tool_call: ${line.tool_name}] ${JSON.stringify(line.input)}`
				case 'tool_result':
					return `[tool_result: ${line.tool_name}] ${line.content}`
			}
		})
		.join('\n')
}
