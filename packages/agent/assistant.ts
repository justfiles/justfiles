import type { Agent, AgentEvent, AgentMessage, AgentTool } from '@earendil-works/pi-agent-core'
import type { Volume } from '@justfiles/fs'
import { createActivityRecorder } from './activity.ts'
import { ageCalibration } from './age-calibration'
import { readProfile, readSoul } from './agent-defaults'
import { type CompactionSettings, compact, prepareCompaction, shouldCompact } from './compaction'
import { deviceId } from './device'
import { createReadDocTool, docsPrompt } from './docs'
import { EXPRESSION_PROMPT } from './expression'
import { file } from './file'
import type { LLMText } from './llm.text'
import * as paths from './paths.ts'
import { filesystemPrompt, MEMORY_CONSOLIDATION_PROMPT, systemPrompt } from './prompts'
import {
	type ContextMessage,
	currentSession,
	type SessionEntry,
	type SessionManager,
	session
} from './session.manager'
import { createReadSkillTool, createVolumeSkillRegistry } from './skills'
import { DEFAULT_TIMEZONE, formatInTimezone } from './timezone'

type AssistantProps = {
	volume: Volume
	agent: Agent
	text: LLMText
	agentId: string
	kind: 'main' | 'app'
	appContext?: () => Promise<string>
	compaction: CompactionSettings
	getTimezone?: () => Promise<string> | string
	// How the host reads a doc body by id (disk on quay, asset fetch on frieren). WHICH docs
	// the agent sees is the shared, hand-maintained catalogue (docs.ts); this only supplies
	// the bytes. When provided, the docs block goes in the system prompt and a `read_doc` tool
	// is added. Omit to disable docs. (Skills are independent — see below.)
	readDoc?: (id: string) => Promise<string>
	// A stable `# apps` system-prompt block: tells the agent it drives apps through the `app`
	// command and to discover them with `app list` at runtime. A plain string (not a thunk with
	// a live list) so the prompt prefix stays byte-identical across turns. Omit for no apps.
	appsPrompt?: string
	// Ask for the per-sentence expression tag (see expression.ts). Only a host that strips the
	// tags before display should turn this on — otherwise they show up in the transcript.
	expressions?: boolean
	// Whether the host wired the `os` command (an `osState` port): the filesystem block then
	// points at `os windows` for "what is the user looking at" instead of leaving it unanswerable.
	os?: boolean
	// Publishes entries after their session append succeeds. The outer AgentSession uses this
	// to push durable items without making each prompt carry persistence plumbing.
	onEntriesAppended?: (entries: readonly SessionEntry[]) => Promise<void> | void
}

// Who authored a turn: the user typing, or an app acting on their behalf.
export type PromptSource = 'user' | 'app'

type AssistantEventListener = (event: AgentEvent, signal: AbortSignal) => Promise<void> | void

// The host-agnostic agent: the raw pi-agent-core loop (the `Agent`) wrapped with
// persona, memory, sessions, skills and docs. Created via `createAssistant`.
export interface Assistant {
	// --- conversation ---
	prompt: (message: string, source?: PromptSource) => Promise<string>
	subscribe: (listener: AssistantEventListener) => () => void
	history: () => Promise<readonly SessionEntry[]>

	// --- session lifecycle ---
	// Start a fresh session: mint + register a new session file (the old one stays on
	// disk) and clear the live context. No notes are taken — a clean break (unlike the
	// idle rollover in route(), which summarises the abandoned session first).
	newSession: () => Promise<void>
	// Cancel the in-flight turn. Leaves the session intact so later prompts still work.
	abort: () => Promise<void>

	// --- tools ---
	addTools: (tools: readonly AgentTool[]) => void

	// --- skills ---
	// Apply a skill by id: load its body and run it as a normal turn, so the result lands
	// in the session like any other turn. A host maps its own `/skill`-style command to this
	// — the agent has no `command` concept. Enumeration is separate + LLM-free (`listSkills`).
	applySkill: (id: string) => Promise<string>
	// Read one skill's body by id, without running it.
	readSkill: (id: string) => Promise<string>

	// --- introspection (debug) ---
	systemPrompt: () => string
}

export async function createAssistant({
	volume,
	agent,
	text,
	agentId,
	kind,
	appContext,
	compaction,
	getTimezone,
	readDoc,
	appsPrompt,
	expressions,
	os = false,
	onEntriesAppended
}: AssistantProps): Promise<Assistant> {
	// Skills: user-authored on the Volume (+ built-in sources later). Expose `read_skill`
	// only when there is something to read, so a host with no skills sees no dead tool.
	const skillRegistry = createVolumeSkillRegistry(volume)
	if (await skillRegistry.index()) {
		agent.state.tools = [...agent.state.tools, createReadSkillTool(skillRegistry)]
	}
	// Docs (independent of skills): a system-prompt block + a `read_doc` tool, only when the
	// host supplies a reader. The block itself is added in resolveSystemPrompt.
	if (readDoc) {
		agent.state.tools = [...agent.state.tools, createReadDocTool(readDoc)]
	}

	let session = await route({ agentId, kind }, volume, text)
	await initSession()
	let running: { aborted: boolean } | null = null

	return {
		prompt,
		subscribe,
		history: () => session.walkActiveBranch(),
		newSession,
		abort,
		addTools,
		applySkill,
		readSkill: (id) => skillRegistry.read(id),
		systemPrompt: () => agent.state.systemPrompt
	}

	async function abort() {
		if (running) running.aborted = true
		agent.abort()
	}

	async function newSession() {
		session = await createSession(agentId, volume)
		await initSession()
	}

	function addTools(tools: readonly AgentTool[]) {
		agent.state.tools = [...agent.state.tools, ...tools]
	}

	// Load a skill body and run it as a normal turn (its result lands in the session).
	async function applySkill(id: string): Promise<string> {
		return prompt(await skillRegistry.read(id), 'user')
	}

	async function prompt(message: string, source: PromptSource = 'user') {
		const turn = { aborted: false }
		const activity = createActivityRecorder()
		running = turn
		let offset = 0
		let promptError: unknown
		try {
			// The turn boundary, and the point where a peer's turns join this device's conversation:
			// `agent.state.messages` is a CACHE of the transcript, not the source of truth, and sync
			// may have delivered a shard since the last turn. Rehydrating here also refreshes the
			// session's active leaf, so this turn parents onto the merged lineage instead of forking
			// off whatever was newest when this host booted (#300).
			await rehydrate()
			if (appContext) agent.state.systemPrompt = await resolveSystemPrompt()
			if (turn.aborted) return ''
			offset = agent.state.messages.length
			const input = await session.append([
				{ type: 'message', role: 'user', content: message, source }
			])
			await onEntriesAppended?.(input.entries)
			const unsubscribe = agent.subscribe(activity.onEvent)
			try {
				await agent.prompt(message)
				await retryEmptyAssistant(offset)
			} catch (error) {
				promptError = error
			} finally {
				unsubscribe()
			}
		} finally {
			if (running === turn) running = null
		}

		const newMessages = agent.state.messages.slice(offset)
		const turnHasToolCall = newMessages.some(hasToolCall)
		const output = newMessages.slice(1)
		if (output.length > 0) {
			const payloads = await activity.write({
				volume,
				agentId,
				sessionId: session.sessionId,
				messages: output,
				agentTools: agent.state.tools,
				diagnostic: (message) => assistantDiagnostic(message, turnHasToolCall)?.message
			})
			if (payloads.length) {
				const appended = await session.append(payloads)
				await onEntriesAppended?.(appended.entries)
			}
		}

		const answer = assistantText(newMessages)
		if (turn.aborted) return answer
		const diagnostic = promptError
			? { message: errorMessage(promptError) }
			: newMessages
					.map((message) => assistantDiagnostic(message, turnHasToolCall))
					.find((value) => value !== undefined)
		if (diagnostic) {
			console.error('[frieren-agent-failure]', {
				source,
				message: diagnostic.message,
				persistedMessages: newMessages.length
			})
			throw new Error(diagnostic.message)
		}

		if (shouldCompact(agent, compaction)) {
			// Pinned to the append cursor: this reads the branch the turn just extended and is
			// about to append a summary node to. Left unpinned, a peer entry arriving in this
			// window would move the walk to its branch — the compaction node would attach there and
			// `firstKeptEntryId` would point into a lineage the summary is not about.
			const branch = await session.walkActiveBranch(session.activeLeafId)
			const prepared = prepareCompaction(branch, compaction)
			if (kind === 'main') {
				const notes = await text.takeNotes(prepared.content)
				if (notes) await file(volume, paths.daily()).append(`\n\n${notes}`)
			}
			const result = await compact(text, prepared)
			// Awaited, unlike before: `initSession` below now recomputes the active leaf from
			// disk, so an in-flight append would race it — the leaf could come back as the
			// pre-compaction tip and then be overwritten when the append lands.
			const appended = await session.append([
				{
					type: 'compaction',
					summary: result.summary,
					firstKeptEntryId: result.firstKeptEntryId,
					tokensBefore: result.tokensBefore
				}
			])
			await onEntriesAppended?.(appended.entries)
			await initSession()
		}
		return answer
	}

	async function retryEmptyAssistant(offset: number) {
		const messages = agent.state.messages
		const last = messages[messages.length - 1]
		if (messages.length <= offset || !isEmptyAssistant(last)) return

		agent.state.messages = messages.slice(0, -1)
		await agent.continue()
	}

	// Both halves read the CURRENT `session`, so neither takes it as an argument: passing one
	// would imply a choice the body does not honour.
	async function initSession() {
		agent.state.systemPrompt = await resolveSystemPrompt()
		await rehydrate()
	}

	// Replace the in-memory messages with the merged session's context. Note this drops tool
	// calls/results from earlier turns, which is what the transcript already says should happen
	// ("old tool output should not live in active context") — so a long-lived host now sees the
	// same context a freshly-started one does, instead of quietly diverging from it.
	async function rehydrate() {
		const msg = await session.buildSessionContext()
		agent.state.messages = msg.map(contextMessageToAgentMessage)
	}

	function subscribe(listener: AssistantEventListener) {
		return agent.subscribe(listener)
	}

	async function resolveSystemPrompt(): Promise<string> {
		// No onboarding gate and no seeding: a missing soul IS the built-in persona
		// (agent-defaults), so a brand-new Volume wakes up as the same agent a seeded one did —
		// and nothing here writes to the Volume to make that true.
		const soul = await readSoul(volume)

		const prompt = systemPrompt(soul)
		// Orientation first, before any injected body: the agent knows where it is, which paths
		// are the user's, and which are the host's, before it reads a word of their content.
		prompt.add('# your filesystem', filesystemPrompt({ os }))
		const profile = await readProfile(volume)
		if (profile) {
			prompt.add('# about the user', profile)
			const calibration = ageCalibration(profile)
			if (calibration) prompt.add(calibration)
		}

		if (appsPrompt) prompt.add('# apps', appsPrompt)
		if (appContext) prompt.add('# attached app', await appContext())

		const skillsBlock = await skillRegistry.index()
		if (skillsBlock) prompt.add('# skills', skillsBlock)

		if (readDoc) prompt.add('# docs', docsPrompt())

		const tz = (getTimezone ? await getTimezone() : DEFAULT_TIMEZONE) || DEFAULT_TIMEZONE
		const now = new Date()
		prompt.add(
			'# current time',
			`Now: ${formatInTimezone(now, tz)} (${tz}).`,
			'When the user references relative dates ("today", "tomorrow", "next week"), interpret them in this timezone.',
			"When passing date: arguments to calendar tools, use ISO 8601 with the user's offset (or 'Z' for UTC). The agent is responsible for the conversion.",
			'If this session has been running long enough that the time above may be stale, run `date` to get the current time.'
		)
		const memory = await file(volume, paths.MEMORY).text()
		if (memory) prompt.add('# permanent memory', memory)

		const today = new Date()
		const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000)
		const dailies: string[] = []
		for (const date of [yesterday, today]) {
			const daily = await file(volume, paths.daily(date)).text()
			if (daily) dailies.push(`## ${date.toISOString().slice(0, 10)}\n${daily}`)
		}

		if (dailies.length > 0) {
			prompt.add(
				'# memories of the past 2 days',
				`Recent daily notes (last 2 days). These are raw, unprocessed jottings from recent sessions — treat as lower-priority hints than the durable memory above. They may be noisy, redundant, or contradicted by later facts; defer to the durable memory on conflict.`,
				...dailies
			)
		}

		// Last, for recency: the response-format contract is the instruction a small model is
		// most likely to drop, and the one whose failure is most visible.
		if (expressions) prompt.add('# expression', EXPRESSION_PROMPT)

		return prompt.build()
	}
}

// Roll yesterday's daily notes into durable shared memory. A maintenance/cron
// job — it touches none of the live Assistant's state, so it takes the Volume + LLMText
// directly. The host schedules it (e.g. a daily alarm).
export async function consolidateMemory(
	volume: Volume,
	text: LLMText,
	now: Date = new Date()
): Promise<void> {
	const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
	const dateStr = yesterday.toISOString().slice(0, 10)
	const daily = await file(volume, paths.daily(yesterday)).text()
	if (!daily?.trim()) return
	const existing = (await file(volume, paths.MEMORY).text()) ?? ''
	const userPrompt = [
		'# Current durable memory (read-only)',
		'',
		existing.trim() || '(empty)',
		'',
		`# Yesterday's daily notes (${dateStr})`,
		'',
		daily
	].join('\n')
	const additions = (await text.gen(MEMORY_CONSOLIDATION_PROMPT, userPrompt)).trim()
	if (!additions) return
	await file(volume, paths.MEMORY).append(`\n\n## ${dateStr}\n${additions}\n`)
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function assistantText(messages: AgentMessage[]): string {
	return messages
		.flatMap((message) =>
			'role' in message && message.role === 'assistant'
				? message.content.filter((block) => block.type === 'text').map((block) => block.text)
				: []
		)
		.join('\n')
		.trim()
}

function assistantDiagnostic(
	message: AgentMessage,
	turnHasToolCall = false
): { message: string } | undefined {
	if (!('role' in message) || message.role !== 'assistant') return undefined
	if (message.stopReason === 'error' || message.stopReason === 'aborted' || message.errorMessage) {
		return {
			message: message.errorMessage || `Assistant stopped with reason: ${message.stopReason}`
		}
	}

	const hasText = message.content.some(
		(block) => block.type === 'text' && block.text.trim().length > 0
	)
	const hasToolCall = message.content.some((block) => block.type === 'toolCall')
	if (!hasText && !hasToolCall && !turnHasToolCall) {
		return { message: 'Assistant returned no visible text or tool calls.' }
	}

	return undefined
}

function hasToolCall(message: AgentMessage): boolean {
	return (
		'role' in message &&
		message.role === 'assistant' &&
		message.content.some((block) => block.type === 'toolCall')
	)
}

function isEmptyAssistant(message: AgentMessage | undefined): boolean {
	return (
		!!message &&
		'role' in message &&
		message.role === 'assistant' &&
		!message.errorMessage &&
		message.content.every(
			(block) =>
				(block.type !== 'text' || block.text.trim().length === 0) && block.type !== 'toolCall'
		)
	)
}

function contextMessageToAgentMessage(message: ContextMessage): AgentMessage {
	switch (message.role) {
		case 'user':
			return { role: 'user', content: message.content, timestamp: message.timestamp }
		case 'assistant':
			return {
				role: 'assistant',
				content: [{ type: 'text', text: message.content }],
				api: 'anthropic',
				provider: 'anthropic',
				model: '',
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
				},
				stopReason: 'stop',
				timestamp: message.timestamp
			} as AgentMessage
	}
}

const SIX_HOURS = 6 * 60 * 60 * 1000

type MessageContext = {
	agentId: string
	kind: 'main' | 'app'
}

// Which session this host is in is DERIVED from the transcripts, never recorded: the one
// whose newest entry is newest. Open the iPad and it resumes the Mac's conversation, with no
// pointer file for two hosts to clobber (#300).
//
// App sessions always resume that thread. Main retires it after six idle hours, measured from
// the newest entry so a peer's synced turn keeps the conversation alive.
async function route(ctx: MessageContext, volume: Volume, text: LLMText): Promise<SessionManager> {
	const now = new Date()
	const current = await currentSession(volume, ctx.agentId)
	const open = async (at: { sessionId: string; startTs: Date }) =>
		session(volume, {
			agentId: ctx.agentId,
			sessionId: at.sessionId,
			startTs: at.startTs,
			deviceId: await deviceId(volume)
		})

	if (current && (ctx.kind === 'app' || now.getTime() - Date.parse(current.newestTs) < SIX_HOURS))
		return open(current)

	// Archiving a retired conversation is a ONE-TIME, cross-device side effect: an LLM call plus
	// a journal append. It has to be CLAIMED, not merely guarded, because until the fresh session
	// has its first entry the retired one is still the newest — so a DO eviction, a backend
	// rebuild, or a host that only asked for history re-derives it and archives it again,
	// duplicating the notes and paying for the summary every time (#335 review).
	if (current && (await claimArchive(volume, ctx.agentId, current.sessionId))) {
		const previous = await open(current)
		const context = await previous.buildSessionContext()
		if (context.length > 0) {
			const tail = context.map((m) => `${m.role}: ${m.content}`).join('\n')
			const notes = await text.takeNotes(tail)
			if (notes) {
				await file(volume, paths.daily(now)).append(`\n\n${notes}`)
			}
		}
	}

	return createSession(ctx.agentId, volume, now)
}

// The claim is `writeFile({ exclusive: true })` — atomic create, no replace, on every backend
// (#325/#327). Scope it honestly: that is a real lock among callers sharing ONE backend, which
// is exactly the case this fixes — the same host re-initialising (an evicted DO, a rebuilt
// backend, a reconnect that only wanted history) re-derives the same retired session and would
// otherwise archive it again on every single init.
//
// It does NOT reach across REPLICAS. Two agent-running hosts each hold their own Volume, so
// both creates succeed and sync later collapses the marker by LWW — after both did the work.
// That is deliberate: the duplicate costs an LLM call and a journal block, and buying protection
// with a distributed protocol would cost permanent complexity. It is arbitrated by
// CONFIGURATION instead — one host per account owns background work — which needs the journal
// and memory to be per-device shards first (#302/#303), or a double-run is whole-file LWW and a
// summary is lost rather than duplicated. See `session.test.ts` for the pinned boundary.
//
// Claimed BEFORE the work, deliberately. A crash in between loses a best-effort summary;
// claiming afterwards would duplicate it on every re-init, which is the bug. The transcript
// itself is never at risk either way — it stays on disk and is searchable, which is where the
// agent is told to look for old conversations.
async function claimArchive(volume: Volume, agentId: string, sessionId: string): Promise<boolean> {
	const path = paths.sessionArchive(agentId, sessionId)
	await volume.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true })
	try {
		await volume.writeFile(path, new TextEncoder().encode(new Date().toISOString()), {
			exclusive: true
		})
		return true
	} catch (e) {
		if (!(e as Error).message.startsWith('EEXIST')) throw e
		return false
	}
}

// Mint a fresh session id and open this device's shard for it. The retired session stays on
// disk and simply stops being the newest — nothing has to be de-registered, because nothing
// was registered. Shared by route() (after an idle rollover) and Runtime.newSession.
//
// Note the one thing deriving costs: a brand-new session has no entries, so it is not yet
// discoverable. Ask for a new conversation, say nothing, restart — and route() resolves back
// to the previous session. No content is lost (there was none); the INTENT is. Recording it
// would mean host-private state under /private, which #300 leaves optional and nothing has
// asked for.
//
// The second-order effect of that same gap was a real bug, now fixed: the retired session
// stays the newest until the fresh one has an entry, so every re-init used to re-archive it.
// `claimArchive` makes the archival idempotent rather than trying to close the window.
//
// And note what `route()` being called ONCE per host costs (#337, pre-existing): a warm host
// never re-evaluates, so it never rolls over on idle and never joins a session a PEER started.
// Two devices already in the same session converge fine — that is what the turn-boundary
// rehydrate and the derived-leaf read handle — but a peer starting a NEW one splits them until
// a restart. Fixing it needs a guard so `newSession()` does not become a no-op, and #334 first
// so the scan is not paid per turn.
async function createSession(
	agentId: string,
	volume: Volume,
	now: Date = new Date()
): Promise<SessionManager> {
	return session(volume, {
		agentId,
		sessionId: crypto.randomUUID().slice(0, 8),
		startTs: now,
		deviceId: await deviceId(volume)
	})
}
