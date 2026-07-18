import type { Agent, AgentMessage } from '@earendil-works/pi-agent-core'
import type {
	ToolResultMessage as PiToolResultMessage,
	UserMessage as PiUserMessage
} from '@earendil-works/pi-ai'
import type { LLMText } from './llm.text'
import type { SessionEntry } from './session.manager'

interface CompactionResult {
	summary: string
	firstKeptEntryId: string
	tokensBefore: number
}

export interface CompactionSettings {
	enabled: boolean
	reserveTokens: number
	keepRecentTokens: number
}

export function prepareCompaction(
	branch: ReadonlyArray<SessionEntry>,
	settings: CompactionSettings
) {
	// Mirror Pi's prepareCompaction: find where the previous compaction left off.
	// boundaryStart is firstKeptEntryId of the last compaction (not the compaction
	// node itself), so the kept tail from the previous compaction gets folded into
	// the new summary rather than left dangling.
	let boundaryStart = 0
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i]
		if (e?.type === 'compaction') {
			const keptIdx = branch.findIndex((entry) => entry.id === e.firstKeptEntryId)
			boundaryStart = keptIdx >= 0 ? keptIdx : i + 1
			break
		}
	}

	const window = branch.slice(boundaryStart)

	const tokensBefore = Math.ceil(
		window.reduce((sum, e) => {
			if (e.type === 'message' && (e.role === 'user' || e.role === 'assistant'))
				return sum + e.content.length
			if (e.type === 'compaction') return sum + e.summary.length
			return sum
		}, 0) / 4
	)

	// Walk backward keeping recent user/assistant messages within keepRecentTokens.
	// Tool calls/results are not counted — they won't appear in the tail the model sees.
	let keptTokens = 0
	let splitIdx = window.length
	for (let i = window.length - 1; i >= 0; i--) {
		const e = window[i]
		if (e?.type === 'message' && (e.role === 'user' || e.role === 'assistant')) {
			const t = Math.ceil(e.content.length / 4)
			if (keptTokens + t > settings.keepRecentTokens) {
				splitIdx = i + 1
				break
			}
			keptTokens += t
		}
	}
	splitIdx = Math.max(1, Math.min(splitIdx, window.length - 1))

	// firstKeptEntryId is the ID of the branch entry at splitIdx — direct lookup,
	// no counting or cross-referencing needed.
	const splitEntry = window[splitIdx]
	if (!splitEntry) throw new Error('compaction window too small to split')
	const firstKeptEntryId = splitEntry.id

	const content = window
		.slice(0, splitIdx)
		.filter(
			(e): e is Extract<SessionEntry, { type: 'message'; role: 'user' | 'assistant' }> =>
				e.type === 'message' && (e.role === 'user' || e.role === 'assistant')
		)
		.map((e) => `${e.role}: ${e.content}`)
		.join('\n')

	return {
		content,
		firstKeptEntryId,
		tokensBefore
	}
}

export async function compact(
	text: LLMText,
	{ content, firstKeptEntryId, tokensBefore }: ReturnType<typeof prepareCompaction>
): Promise<CompactionResult> {
	const summary = await text.summarise(content)
	return { summary, firstKeptEntryId, tokensBefore }
}

export function shouldCompact(agent: Agent, settings: CompactionSettings): boolean {
	const messages = agent.state.messages
	const contextWindow = agent.state.model.contextWindow

	const last = messages.at(-1)
	let contextTokens: number
	if (last && 'role' in last && last.role === 'assistant' && 'usage' in last) {
		contextTokens = last.usage.totalTokens
	} else {
		contextTokens = messages.reduce((sum, m) => sum + estimateTokens(m), 0)
	}

	return _shouldCompact(contextTokens, contextWindow, settings)
}

function _shouldCompact(
	contextTokens: number,
	contextWindow: number,
	settings: CompactionSettings
): boolean {
	if (!settings.enabled) return false
	return contextTokens > contextWindow - settings.reserveTokens
}

export function estimateTokens(message: AgentMessage): number {
	if (!('role' in message)) return 0

	if (message.role === 'assistant') {
		const m = message
		return m.content.reduce((sum, block) => {
			if (block.type === 'text') return sum + Math.ceil(block.text.length / 4)
			if (block.type === 'thinking') return sum + Math.ceil(block.thinking.length / 4)
			if (block.type === 'toolCall')
				return sum + Math.ceil(JSON.stringify(block.arguments).length / 4)
			return sum
		}, 0)
	}

	if (message.role === 'user') {
		const m = message as PiUserMessage
		const content = m.content
		if (typeof content === 'string') return Math.ceil(content.length / 4)
		return content.reduce((sum, block) => {
			if (block.type === 'text') return sum + Math.ceil(block.text.length / 4)
			return sum + 256 // image estimate
		}, 0)
	}

	if (message.role === 'toolResult') {
		const m = message as PiToolResultMessage
		return m.content.reduce((sum, block) => {
			if (block.type === 'text') return sum + Math.ceil(block.text.length / 4)
			return sum + 256
		}, 0)
	}

	return 0
}
