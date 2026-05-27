import type { SessionEntry } from './session.manager'

export interface DisplayToolCall {
	name: string
	args: unknown
	result?: unknown
	isError?: boolean
}

export interface DisplayMessage {
	readonly role: 'user' | 'assistant'
	readonly content: string
	readonly source?: 'user' | 'app'
	readonly thinking?: string
	readonly toolCalls?: ReadonlyArray<DisplayToolCall>
}

export function sessionEntries2DisplayMessages(entries: readonly SessionEntry[]): DisplayMessage[] {
	const messages: DisplayMessage[] = []
	for (const entry of entries) {
		if (entry.type === 'message' && entry.role === 'tool_result') {
			const last = messages[messages.length - 1]
			const toolCalls = last?.toolCalls ? [...last.toolCalls] : []
			const index = toolCalls.findLastIndex(
				(toolCall) => toolCall.name === entry.tool_name && toolCall.result === undefined
			)
			if (last?.role === 'assistant' && index >= 0) {
				toolCalls[index] = { ...toolCalls[index], result: parseToolResult(entry.content) }
				messages[messages.length - 1] = { ...last, toolCalls }
				continue
			}
		}

		const message = sessionEntry2DisplayMessage(entry)
		if (!message) continue

		const last = messages[messages.length - 1]
		if (
			last?.role === 'assistant' &&
			!last.content &&
			last.toolCalls?.length &&
			message.role === 'assistant' &&
			message.toolCalls?.length
		) {
			messages[messages.length - 1] = {
				...last,
				toolCalls: [...last.toolCalls, ...message.toolCalls]
			}
			continue
		}

		messages.push(message)
	}
	return messages
}

function parseToolResult(content: string): unknown {
	try {
		return JSON.parse(content)
	} catch {
		return content
	}
}

function sessionEntry2DisplayMessage(entry: SessionEntry): DisplayMessage | null {
	switch (entry.type) {
		case 'message':
			switch (entry.role) {
				case 'user':
					return { role: 'user', content: entry.content, source: entry.source ?? 'user' }
				case 'assistant':
					return { role: 'assistant', content: entry.content }
				case 'assistant_thinking':
					return { role: 'assistant', content: '', thinking: entry.content }
				case 'tool_call':
					return {
						role: 'assistant',
						content: '',
						toolCalls: [{ name: entry.tool_name, args: entry.input }]
					}
				case 'tool_result':
					return {
						role: 'assistant',
						content: '',
						toolCalls: [
							{
								name: entry.tool_name,
								args: undefined,
								result: parseToolResult(entry.content)
							}
						]
					}
				default:
					throw new Error('unsupported message role')
			}
		case 'compaction':
			return { role: 'assistant', content: entry.summary }
		case 'branch_summary':
			return { role: 'assistant', content: entry.summary }
		case 'label':
			return { role: 'assistant', content: `[${entry.label}]` }
	}
}
