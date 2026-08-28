import type { SessionStatus } from '@justfiles/agent'
import { createExpressionParser, type Expression } from '@justfiles/agent/expression'
import type { TranscriptStatus } from '@justfiles/agent/protocol'

export function createTranscriptStatusProjector() {
	let lastDetail: Exclude<SessionStatus, { state: 'idle' }>['detail']
	let parser = createExpressionParser()
	let text = ''
	let toolLabel = 'Working'

	return (
		status: SessionStatus,
		onExpression?: (expression: Expression | null) => void
	): TranscriptStatus => {
		if (status.state === 'idle') {
			lastDetail = undefined
			parser = createExpressionParser()
			text = ''
			toolLabel = 'Working'
			return status
		}

		const detail = status.detail
		if (detail && detail !== lastDetail) {
			lastDetail = detail
			let expression: Expression | null | undefined
			if (detail.type === 'agent_start') {
				parser = createExpressionParser()
				text = ''
				expression = null
			}
			if (detail.type === 'message_start' && detail.message.role === 'assistant')
				parser = createExpressionParser()
			if (detail.type === 'message_update' && detail.assistantMessageEvent.type === 'text_delta') {
				const update = parser.push(detail.assistantMessageEvent.delta)
				text += update.text
				if (update.expression) expression = update.expression
			}
			if (detail.type === 'message_end') text += parser.flush()
			if (detail.type === 'tool_execution_start') toolLabel = labelTool(detail.toolName)
			if (expression !== undefined) {
				onExpression?.(expression)
			}
		}

		return status.state === 'thinking'
			? { state: 'thinking', label: 'Thinking' }
			: status.state === 'calling_tool'
				? { state: 'calling_tool', label: toolLabel }
				: { state: 'responding', text }
	}
}

function labelTool(name: string): string {
	switch (name) {
		case 'bash':
			return 'Running a command'
		case 'app':
			return 'Using an app'
		case 'os':
			return 'Checking the desktop'
		case 'fetch':
			return 'Fetching data'
		case 'read_doc':
			return 'Reading documentation'
		case 'read_skill':
			return 'Reading a skill'
		case 'generate_image':
			return 'Generating an image'
		case 'ask_user':
			return 'Preparing a question'
		default:
			return `Using ${name.replaceAll('_', ' ')}`
	}
}
