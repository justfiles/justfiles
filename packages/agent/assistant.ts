import type { Agent, AgentEvent, AgentMessage, AgentTool } from '@earendil-works/pi-agent-core'
import type { Volume } from '@justfiles/fs'
import { z } from 'zod'
import { ageCalibration } from './age-calibration'
import { ensureAgentDefaults } from './agent-defaults'
import { type CompactionSettings, compact, prepareCompaction, shouldCompact } from './compaction'
import { createReadDocTool, docsPrompt } from './docs'
import { file } from './file'
import type { LLMText } from './llm.text'
import { MEMORY_CONSOLIDATION_PROMPT, systemPrompt } from './prompts'
import {
	type AppendPayload,
	type ContextMessage,
	type ImageRef,
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
	compaction: CompactionSettings
	getTimezone?: () => Promise<string> | string
	// How the host reads a doc body by id (disk on quay, asset fetch on frieren). WHICH docs
	// the agent sees is the shared, hand-maintained catalogue (docs.ts); this only supplies
	// the bytes. When provided, the docs block goes in the system prompt and a `read_doc` tool
	// is added. Omit to disable docs. (Skills are independent — see below.)
	readDoc?: (id: string) => Promise<string>
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
	compaction,
	getTimezone,
	readDoc
}: AssistantProps): Promise<Assistant> {
	// Seed the platform's default persona + empty profile if absent, so the agent always has
	// a working identity and never blocks on "onboarding". Idempotent; personalization wins.
	await ensureAgentDefaults(volume)
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

	const agentId = 'main'
	let session = await route({ agentId }, volume, text)
	await initSession(session)

	return {
		prompt,
		subscribe,
		history: () => session.walkActiveBranch(),
		newSession,
		abort,
		addTools,
		applySkill: (id) => applySkill(id),
		readSkill: (id) => skillRegistry.read(id),
		systemPrompt: () => agent.state.systemPrompt
	}

	async function abort() {
		agent.abort()
	}

	async function newSession() {
		session = await createSession({ agentId }, volume)
		await initSession(session)
	}

	function addTools(tools: readonly AgentTool[]) {
		agent.state.tools = [...agent.state.tools, ...tools]
	}

	// Load a skill body and run it as a normal turn (its result lands in the session).
	async function applySkill(id: string): Promise<string> {
		return prompt(await skillRegistry.read(id))
	}

	async function prompt(message: string, source: PromptSource = 'user') {
		const offset = agent.state.messages.length
		let promptError: unknown
		try {
			await agent.prompt(message)
			await retryEmptyAssistant(offset)
		} catch (error) {
			promptError = error
		}

		const newMessages = agent.state.messages.slice(offset)
		const turnHasToolCall = newMessages.some(hasToolCall)
		if (newMessages.length > 0) {
			await session.append(
				newMessages.flatMap((message, index) => {
					const entry = transform(message, index === 0 ? source : 'user', turnHasToolCall)
					return entry ? [entry] : []
				})
			)
		}

		const answer = assistantText(newMessages)
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
			const branch = await session.walkActiveBranch()
			const prepared = prepareCompaction(branch, compaction)
			const notes = await text.takeNotes(prepared.content)
			if (notes) {
				await file(volume, PATHS.daily()).append(`\n\n${notes}`)
			}
			const result = await compact(text, prepared)
			session.append([
				{
					type: 'compaction',
					summary: result.summary,
					firstKeptEntryId: result.firstKeptEntryId,
					tokensBefore: result.tokensBefore
				}
			])
			await initSession(session)
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

	async function initSession(session: SessionManager) {
		agent.state.systemPrompt = await resolveSystemPrompt()
		const msg = await session.buildSessionContext()
		agent.state.messages = msg.map(contextMessageToAgentMessage)
	}

	function subscribe(listener: AssistantEventListener) {
		return agent.subscribe(listener)
	}

	async function resolveSystemPrompt(): Promise<string> {
		// No onboarding gate: `createAssistant` seeds a default persona (agent-defaults) so a
		// soul is normally present; if it is still missing we fall back to a blank persona so
		// the agent keeps working (skills, docs, tools) and never blocks the user.
		const soul = (await file(volume, PATHS.soul(agentId)).text()) || ''

		const prompt = systemPrompt(soul)
		const profile = await file(volume, PATHS.profile).text()
		if (profile) {
			prompt.add('# about the user', profile)
			const calibration = ageCalibration(profile)
			if (calibration) prompt.add(calibration)
		}

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
			'If this session has been running long enough that the time above may be stale, run `now` to get the current time.'
		)
		const memory = await file(volume, PATHS.memory).text()
		if (memory) prompt.add('# permanent memory', memory)

		const today = new Date()
		const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000)
		const dailies: string[] = []
		for (const date of [yesterday, today]) {
			const daily = await file(volume, PATHS.daily(date)).text()
			if (daily) dailies.push(`## ${date.toISOString().slice(0, 10)}\n${daily}`)
		}
		if (dailies.length > 0) {
			prompt.add(
				'# memories of the past 2 days',
				`Recent daily notes (last 2 days). These are raw, unprocessed jottings from recent sessions — treat as lower-priority hints than the durable memory above. They may be noisy, redundant, or contradicted by later facts; defer to the durable memory on conflict.`,
				...dailies
			)
		}

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
	const daily = await file(volume, PATHS.daily(yesterday)).text()
	if (!daily?.trim()) return
	const existing = (await file(volume, PATHS.memory).text()) ?? ''
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
	await file(volume, PATHS.memory).append(`\n\n## ${dateStr}\n${additions}\n`)
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

function transform(
	message: AgentMessage,
	source: PromptSource,
	turnHasToolCall = false
): AppendPayload | null {
	if (!('role' in message)) throw new Error(`unsupported message: ${JSON.stringify(message)}`)
	switch (message.role) {
		case 'user': {
			const content =
				typeof message.content === 'string'
					? message.content
					: message.content
							.filter((b) => b.type === 'text')
							.map((b) => b.text)
							.join('\n')
			return { type: 'message', role: 'user', content, source }
		}
		case 'assistant': {
			const diagnostic = assistantDiagnostic(message, turnHasToolCall)
			if (diagnostic) {
				return {
					type: 'message',
					role: 'assistant',
					content: `[Agent error: ${diagnostic.message}]`
				}
			}

			const texts: string[] = []
			const toolCalls: { tool_name: string; input: Record<string, unknown> }[] = []
			for (const block of message.content) {
				if (block.type === 'text') texts.push(block.text)
				if (block.type === 'toolCall')
					toolCalls.push({
						tool_name: block.name,
						input: block.arguments as Record<string, unknown>
					})
			}
			const firstToolCall = toolCalls[0]
			if (firstToolCall)
				return {
					type: 'message',
					role: 'tool_call',
					tool_name: firstToolCall.tool_name,
					input: firstToolCall.input
				}
			const content = texts.join('\n')
			if (!content.trim() && turnHasToolCall) return null
			return { type: 'message', role: 'assistant', content }
		}
		case 'toolResult': {
			// Image refs ride in `details` (pi's out-of-band channel — never model
			// context); persist them so the transcript can render inline (#194).
			const images = (message.details as { images?: ImageRef[] } | undefined)?.images
			return {
				type: 'message',
				role: 'tool_result',
				tool_name: message.toolName,
				content: message.content
					.filter((b) => b.type === 'text')
					.map((b) => b.text)
					.join('\n'),
				...(images?.length ? { images } : {})
			}
		}
		default: {
			throw new Error('unsupported role')
		}
	}
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

const PATHS = {
	soul: (agentId: string) => `/system/agents/${agentId}/soul.md`,
	profile: '/system/user.md',
	memory: '/system/memory/core.md',
	daily: (date: Date = new Date()) => `/system/memory/daily/${date.toISOString().slice(0, 10)}.md`,
	sessions: (agentId: string) => `/system/agents/${agentId}/sessions/sessions.json`,
	sessionFile: (agentId: string, sessionId: string) =>
		`/system/agents/${agentId}/sessions/${sessionId}.jsonl`
} as const

const SessionMetaSchema = z.object({
	sessionId: z.string(),
	lastActive: z.iso.datetime().transform((s) => new Date(s)),
	sessionFile: z.string()
})

const SessionsMap = z.record(z.string(), SessionMetaSchema)

type MessageContext = {
	agentId: string
}

async function route(ctx: MessageContext, volume: Volume, text: LLMText): Promise<SessionManager> {
	const sessionKey = resolveSessionKey(ctx)
	const sessionsMap = file(volume, PATHS.sessions(ctx.agentId))
	const sessions = (await sessionsMap.json(SessionsMap)) ?? {}
	const existing = sessions[sessionKey]

	const SIX_HOURS = 6 * 60 * 60 * 1000
	const now = new Date()

	if (existing && now.getTime() - existing.lastActive.getTime() < SIX_HOURS) {
		existing.lastActive = now
		await sessionsMap.write(JSON.stringify(sessions))
		return session(existing.sessionFile, volume)
	}

	if (existing) {
		const previous = session(existing.sessionFile, volume)
		const context = await previous.buildSessionContext()
		if (context.length > 0) {
			const tail = context.map((m) => `${m.role}: ${m.content}`).join('\n')
			const notes = await text.takeNotes(tail)
			if (notes) {
				await file(volume, PATHS.daily(now)).append(`\n\n${notes}`)
			}
		}
	}

	return createSession(ctx, volume, now)
}

// Mint + register a fresh session file (the old one stays on disk, unreferenced) and
// return its manager. Shared by route() (after an idle rollover) and Runtime.newSession.
async function createSession(
	ctx: MessageContext,
	volume: Volume,
	now: Date = new Date()
): Promise<SessionManager> {
	const sessionsMap = file(volume, PATHS.sessions(ctx.agentId))
	const sessions = (await sessionsMap.json(SessionsMap)) ?? {}
	const sessionId = crypto.randomUUID().slice(0, 8)
	const sessionFile = PATHS.sessionFile(ctx.agentId, sessionId)
	sessions[resolveSessionKey(ctx)] = { sessionId, lastActive: now, sessionFile }
	await sessionsMap.write(JSON.stringify(sessions))
	return session(sessionFile, volume)
}

function resolveSessionKey(ctx: MessageContext): string {
	return `agent:${ctx.agentId}`
}
