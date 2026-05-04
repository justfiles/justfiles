import type { Volume } from '@justfiles/fs'
import type { Agent, AgentEvent, AgentMessage } from '@mariozechner/pi-agent-core'
import { z } from 'zod'
import { ageCalibration } from './age-calibration'
import { type CompactionSettings, compact, prepareCompaction, shouldCompact } from './compaction'
import { file } from './file'
import type { LLMText } from './llm.text'
import { DEFAULT_SETUP_PROMPT, MEMORY_CONSOLIDATION_PROMPT, systemPrompt } from './prompts'
import {
	type AppendPayload,
	type ContextMessage,
	type SessionEntry,
	type SessionManager,
	session
} from './session.manager'
import { DEFAULT_TIMEZONE, formatInTimezone } from './timezone'

type RuntimeProps = {
	volume: Volume
	agent: Agent
	text: LLMText
	compaction: CompactionSettings
	getTimezone?: () => Promise<string> | string
}

type FrierenEvent = AgentEvent
type FrierenEventListener = (event: FrierenEvent, signal: AbortSignal) => Promise<void> | void

export interface Runtime {
	prompt: (message: string, source?: 'user' | 'app') => Promise<void>
	shutdown: () => Promise<void>
	subscribe: (lisener: FrierenEventListener) => () => void
	history: () => Promise<readonly SessionEntry[]>
	consolidateMemory: (now?: Date) => Promise<void>
	// TODO: remove
	_agent: () => Agent
}

export async function runtime({
	volume,
	agent,
	text,
	compaction,
	getTimezone
}: RuntimeProps): Promise<Runtime> {
	const agentId = 'main'
	const session = await route({ agentId }, volume, text)
	await initSession(session)

	return {
		shutdown,
		prompt,
		subscribe,
		history: () => session.walkActiveBranch(),
		consolidateMemory,
		_agent: () => agent
	}

	async function shutdown() {
		agent.abort()
	}

	async function prompt(message: string, source: 'user' | 'app' = 'user') {
		const offset = agent.state.messages.length
		await agent.prompt(message)
		const newMessages = agent.state.messages.slice(offset)
		await session.append(
			newMessages.map((message, index) => transform(message, index === 0 ? source : 'user'))
		)
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
	}

	async function consolidateMemory(now: Date = new Date()) {
		const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
		const dateStr = yesterday.toISOString().slice(0, 10)
		const daily = await file(volume, PATHS.daily(yesterday)).text()
		if (!daily?.trim()) return
		const existing = (await file(volume, PATHS.memory).text()) ?? ''
		const userPrompt = [
			'# Current MEMORY.md (read-only)',
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

	async function initSession(session: SessionManager) {
		agent.state.systemPrompt = await resolveSystemPrompt()
		const msg = await session.buildSessionContext()
		agent.state.messages = msg.map(contextMessageToAgentMessage)
	}

	function subscribe(lisener: FrierenEventListener) {
		return agent.subscribe(lisener)
	}

	async function resolveSystemPrompt(): Promise<string> {
		const soul = await file(volume, PATHS.soul).text()
		if (!soul) return DEFAULT_SETUP_PROMPT

		const prompt = systemPrompt(soul)
		const profile = await file(volume, PATHS.profile).text()
		if (profile) {
			prompt.add('# about the user', profile)
			const calibration = ageCalibration(profile)
			if (calibration) prompt.add(calibration)
		}

		const tz = (getTimezone ? await getTimezone() : DEFAULT_TIMEZONE) || DEFAULT_TIMEZONE
		const now = new Date()
		prompt.add(
			'# current time',
			`Now: ${formatInTimezone(now, tz)} (${tz}).`,
			'When the user references relative dates ("today", "tomorrow", "next week"), interpret them in this timezone.',
			"When passing date: arguments to calendar tools, use ISO 8601 with the user's offset (or 'Z' for UTC). The agent is responsible for the conversion."
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

function transform(message: AgentMessage, source: 'user' | 'app'): AppendPayload {
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
			if (toolCalls.length > 0)
				return {
					type: 'message',
					role: 'tool_call',
					tool_name: toolCalls[0].tool_name,
					input: toolCalls[0].input
				}
			return { type: 'message', role: 'assistant', content: texts.join('\n') }
		}
		case 'toolResult':
			return {
				type: 'message',
				role: 'tool_result',
				tool_name: message.toolName,
				content: message.content
					.filter((b) => b.type === 'text')
					.map((b) => b.text)
					.join('\n')
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
	soul: '/soul.md',
	profile: '/profiles/user.md',
	memory: '/MEMORY.md',
	daily: (date: Date = new Date()) => `/memory/daily/${date.toISOString().slice(0, 10)}.md`,
	sessions: (agentId: string) => `/agents/${agentId}/sessions/sessions.json`,
	sessionFile: (agentId: string, sessionId: string) =>
		`/agents/${agentId}/sessions/${sessionId}.jsonl`
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

	const sessionId = crypto.randomUUID().slice(0, 8)
	const sessionFile = PATHS.sessionFile(ctx.agentId, sessionId)
	sessions[sessionKey] = { sessionId, lastActive: now, sessionFile }
	await sessionsMap.write(JSON.stringify(sessions))
	return session(sessionFile, volume)
}

function resolveSessionKey(ctx: MessageContext): string {
	return `agent:${ctx.agentId}`
}
