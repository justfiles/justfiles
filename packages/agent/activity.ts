import type { AgentEvent, AgentMessage, AgentTool } from '@earendil-works/pi-agent-core'
import type { Volume } from '@justfiles/fs'
import { file } from './file.ts'
import * as paths from './paths.ts'
import type { ActivityDetail, ActivitySummary, AppendPayload, ImageRef } from './session.manager.ts'

type ToolTime = { started: number; durationMs?: number; failed?: true }

type Run = {
	items: ActivitySummary[]
	detail: ActivityDetail
	images: ImageRef[]
}

type ToolItem = {
	run: Run
	summary: Extract<ActivitySummary, { kind: 'tool' }>
	detail: Extract<ActivityDetail['items'][number], { kind: 'tool' }>
}

export function createActivityRecorder(now: () => number = Date.now) {
	const thinking: number[][] = []
	const tools = new Map<string, ToolTime>()
	let currentThoughts: number[] | null = null
	let thoughtStarted: number | null = null

	return { onEvent, dropLastMessage, write }

	function onEvent(event: AgentEvent): void {
		if (event.type === 'message_start' && event.message.role === 'assistant') {
			currentThoughts = []
		}
		if (event.type === 'message_update') {
			const update = event.assistantMessageEvent
			if (update.type === 'thinking_start' || update.type === 'thinking_delta') {
				currentThoughts ??= []
				thoughtStarted ??= now()
			}
			if (update.type === 'thinking_end') finishThought()
		}
		if (event.type === 'message_end' && event.message.role === 'assistant') finishMessage()
		if (event.type === 'tool_execution_start') {
			tools.set(event.toolCallId, { started: now() })
		}
		if (event.type === 'tool_execution_end') {
			const time = tools.get(event.toolCallId) ?? { started: now() }
			time.durationMs = elapsed(time.started)
			if (event.isError) time.failed = true
			tools.set(event.toolCallId, time)
		}
	}

	function finishThought(): void {
		if (thoughtStarted === null) return
		currentThoughts ??= []
		currentThoughts.push(elapsed(thoughtStarted))
		thoughtStarted = null
	}

	function finishMessage(): void {
		finishThought()
		thinking.push(currentThoughts ?? [])
		currentThoughts = null
	}

	function dropLastMessage(): void {
		thinking.pop()
	}

	function elapsed(started: number): number {
		return Math.max(0, Math.round(now() - started))
	}

	async function write({
		volume,
		agentId,
		sessionId,
		messages,
		agentTools,
		diagnostic
	}: {
		volume: Volume
		agentId: string
		sessionId: string
		messages: readonly AgentMessage[]
		agentTools: readonly AgentTool[]
		diagnostic: (message: AgentMessage) => string | undefined
	}): Promise<AppendPayload[]> {
		if (currentThoughts !== null) finishMessage()
		const labels = new Map(agentTools.map((tool) => [tool.name, tool.label]))
		const output: (AppendPayload | Run)[] = []
		const calls = new Map<string, ToolItem>()
		let run: Run | null = null
		let answerIndex = 0

		const currentRun = () => {
			run ??= { items: [], detail: { items: [] }, images: [] }
			return run
		}
		const closeRun = () => {
			if (run?.items.length) output.push(run)
			run = null
		}
		const addText = (content: string) => {
			if (!content.trim()) return
			closeRun()
			output.push({ type: 'message', role: 'assistant', content })
		}

		for (const message of messages) {
			if (!('role' in message)) throw new Error(`unsupported message: ${JSON.stringify(message)}`)
			if (message.role === 'user') {
				closeRun()
				const content =
					typeof message.content === 'string'
						? message.content
						: message.content
								.filter((block) => block.type === 'text')
								.map((block) => block.text)
								.join('\n')
				output.push({ type: 'message', role: 'user', content })
				continue
			}
			if (message.role === 'assistant') {
				const times = thinking[answerIndex++] ?? []
				let thoughtIndex = 0
				const error = diagnostic(message)
				if (error) {
					addText(`[Agent error: ${error}]`)
					continue
				}

				let text = ''
				const flushText = () => {
					addText(text)
					text = ''
				}
				for (const block of message.content) {
					if (block.type === 'text') {
						text += `${text ? '\n' : ''}${block.text}`
						continue
					}
					flushText()
					if (block.type === 'thinking') {
						const active = currentRun()
						active.items.push({
							kind: 'think',
							durationMs: times[thoughtIndex++] ?? 0
						})
						active.detail.items.push({ kind: 'think', content: block.thinking })
						continue
					}

					if (block.name === 'ask_user') {
						closeRun()
						const input = block.arguments as { question?: unknown; options?: unknown }
						const question = typeof input.question === 'string' ? input.question : ''
						const options = Array.isArray(input.options)
							? input.options
									.filter((option): option is string => typeof option === 'string')
									.map((label) => ({ label }))
							: []
						output.push({
							type: 'message',
							role: 'assistant',
							content: question,
							...(options.length ? { options } : {})
						})
						continue
					}

					const active = currentRun()
					const time = tools.get(block.id)
					const summary: ToolItem['summary'] = {
						kind: 'tool',
						name: block.name,
						label: labels.get(block.name) ?? block.name,
						durationMs: time?.durationMs ?? 0,
						...(time?.failed ? { failed: true } : {})
					}
					const detail: ToolItem['detail'] = {
						kind: 'tool',
						name: block.name,
						input: block.arguments,
						result: null,
						...(time?.failed ? { failed: true } : {})
					}
					active.items.push(summary)
					active.detail.items.push(detail)
					calls.set(block.id, { run: active, summary, detail })
				}
				flushText()
				continue
			}

			if (message.role === 'toolResult') {
				const call = calls.get(message.toolCallId)
				if (!call) continue
				call.detail.result = toolResult(message.content)
				if (message.isError) {
					call.summary.failed = true
					call.detail.failed = true
				}
				const images = (message.details as { images?: ImageRef[] } | undefined)?.images
				if (images?.length) {
					call.run.images.push(...images)
					if (run === call.run) closeRun()
				}
			}
		}
		closeRun()

		const payloads: AppendPayload[] = []
		for (const item of output) {
			if (!('detail' in item)) {
				payloads.push(item)
				continue
			}
			const detailId = crypto.randomUUID()
			let storedId: string | undefined
			try {
				await file(volume, paths.activityDetail(agentId, sessionId, detailId)).write(
					JSON.stringify(item.detail)
				)
				storedId = detailId
			} catch (error) {
				console.error('[agent] activity detail write failed:', error)
			}
			payloads.push({
				type: 'activity',
				items: item.items,
				...(storedId ? { detailId: storedId } : {}),
				...(item.images.length ? { images: item.images } : {})
			})
		}
		return payloads
	}
}

function toolResult(content: readonly { type: string; text?: string }[]): unknown {
	const text = content
		.filter((block): block is { type: 'text'; text: string } => block.type === 'text')
		.map((block) => block.text)
		.join('\n')
	if (content.every((block) => block.type === 'text')) return text
	return content
}
