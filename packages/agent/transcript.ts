import { stripExpressions } from './expression.ts'
import type { ActivityDetail, ActivitySummary, ImageRef, SessionEntry } from './session.manager.ts'

export type TranscriptImage = ImageRef

export type TranscriptActivity = ActivitySummary | { kind: 'note'; label: string; body?: string }

export type TranscriptItem =
	| {
			id: string
			type: 'message'
			role: 'user'
			content: string
	  }
	| {
			id: string
			type: 'message'
			role: 'assistant'
			content: string
			options?: { label: string }[]
	  }
	| {
			id: string
			type: 'activity'
			label: string
			items: TranscriptActivity[]
			failed?: true
			detailId?: string
	  }
	| { id: string; type: 'image'; image: TranscriptImage }

export type TranscriptStatus =
	| { state: 'idle' }
	| { state: 'thinking'; label: string }
	| { state: 'calling_tool'; label: string }
	| { state: 'responding'; text: string }

export type ActivityDetailResult =
	| { status: 'available'; detail: ActivityDetail }
	| { status: 'expired' }

type LegacyRun = {
	id: string
	items: ActivitySummary[]
	detail: ActivityDetail
	calls: {
		name: string
		detail: Extract<ActivityDetail['items'][number], { kind: 'tool' }>
		settled: boolean
	}[]
}

const LEGACY_DETAIL = 'legacy:'

export function sessionEntriesToTranscriptItems(
	entries: readonly SessionEntry[],
	options: { expressions?: boolean } = {}
): TranscriptItem[] {
	return project(entries, options).items
}

export function legacyActivityDetail(
	entries: readonly SessionEntry[],
	detailId: string
): ActivityDetail | undefined {
	if (!detailId.startsWith(LEGACY_DETAIL)) return undefined
	return project(entries, {}).details.get(detailId)
}

function project(
	entries: readonly SessionEntry[],
	options: { expressions?: boolean }
): { items: TranscriptItem[]; details: Map<string, ActivityDetail> } {
	const items: TranscriptItem[] = []
	const details = new Map<string, ActivityDetail>()
	let run: LegacyRun | null = null

	const flush = () => {
		if (!run) return
		const detailId = `${LEGACY_DETAIL}${run.id}`
		items.push({
			id: run.id,
			type: 'activity',
			label: activityLabel(run.items),
			items: run.items,
			...(run.items.some((item) => item.kind === 'tool' && item.failed)
				? { failed: true as const }
				: {}),
			detailId
		})
		details.set(detailId, run.detail)
		run = null
	}

	const currentRun = (id: string) => {
		run ??= { id, items: [], detail: { items: [] }, calls: [] }
		return run
	}

	for (const entry of entries) {
		if (entry.type === 'activity') {
			flush()
			items.push({
				id: entry.id,
				type: 'activity',
				label: activityLabel(entry.items),
				items: entry.items,
				...(entry.items.some((item) => item.kind === 'tool' && item.failed)
					? { failed: true as const }
					: {}),
				...(entry.detailId ? { detailId: entry.detailId } : {})
			})
			pushImages(items, entry.id, entry.images)
			continue
		}

		if (entry.type === 'compaction') {
			flush()
			pushNote(items, entry.id, `Compacted ${entry.tokensBefore} tokens`, entry.summary)
			continue
		}
		if (entry.type === 'branch_summary') {
			flush()
			pushNote(items, entry.id, 'Summarized branch', entry.summary)
			continue
		}
		if (entry.type === 'label') {
			flush()
			pushNote(items, entry.id, entry.label)
			continue
		}

		switch (entry.role) {
			case 'user':
				flush()
				items.push({
					id: entry.id,
					type: 'message',
					role: 'user',
					content: entry.content
				})
				break
			case 'assistant':
				flush()
				items.push({
					id: entry.id,
					type: 'message',
					role: 'assistant',
					content: options.expressions ? stripExpressions(entry.content).text : entry.content,
					...(entry.options ? { options: entry.options } : {})
				})
				break
			case 'assistant_thinking': {
				const active = currentRun(entry.id)
				active.items.push({ kind: 'think', durationMs: 0 })
				active.detail.items.push({ kind: 'think', content: entry.content })
				break
			}
			case 'tool_call': {
				if (entry.tool_name === 'ask_user') {
					flush()
					const input = entry.input as { question?: unknown; options?: unknown }
					const options = Array.isArray(input.options)
						? input.options
								.filter((option): option is string => typeof option === 'string')
								.map((label) => ({ label }))
						: []
					items.push({
						id: entry.id,
						type: 'message',
						role: 'assistant',
						content: typeof input.question === 'string' ? input.question : '',
						...(options.length ? { options } : {})
					})
					break
				}
				const active = currentRun(entry.id)
				const summary: ActivitySummary = {
					kind: 'tool',
					name: entry.tool_name,
					label: entry.tool_name,
					durationMs: 0
				}
				const detail: Extract<ActivityDetail['items'][number], { kind: 'tool' }> = {
					kind: 'tool',
					name: entry.tool_name,
					input: entry.input,
					result: null
				}
				active.items.push(summary)
				active.detail.items.push(detail)
				active.calls.push({ name: entry.tool_name, detail, settled: false })
				break
			}
			case 'tool_result': {
				if (entry.tool_name === 'ask_user') break
				const active = currentRun(entry.id)
				const call = active.calls.findLast(
					(candidate) => candidate.name === entry.tool_name && !candidate.settled
				)
				if (call) {
					call.detail.result = parseToolResult(entry.content)
					call.settled = true
				} else {
					const detail: Extract<ActivityDetail['items'][number], { kind: 'tool' }> = {
						kind: 'tool',
						name: entry.tool_name,
						input: null,
						result: parseToolResult(entry.content)
					}
					active.items.push({
						kind: 'tool',
						name: entry.tool_name,
						label: entry.tool_name,
						durationMs: 0
					})
					active.detail.items.push(detail)
					active.calls.push({ name: entry.tool_name, detail, settled: true })
				}
				if (entry.images?.length) {
					flush()
					pushImages(items, entry.id, entry.images)
				}
				break
			}
		}
	}
	flush()
	return { items, details }
}

function activityLabel(items: readonly TranscriptActivity[]): string {
	const duration = items.reduce(
		(total, item) => total + (item.kind === 'note' ? 0 : item.durationMs),
		0
	)
	if (items.length === 1 && items[0]?.kind === 'note') return items[0].label
	if (items.length > 0 && items.every((item) => item.kind === 'think'))
		return `Thought for ${seconds(duration)}`
	if (items.length === 1 && items[0]?.kind === 'tool')
		return `${items[0].label} · ${seconds(duration)}`
	return `${items.length} steps · ${seconds(duration)}`
}

function seconds(durationMs: number): string {
	return `${(durationMs / 1000).toFixed(1)}s`
}

function pushNote(items: TranscriptItem[], id: string, label: string, body?: string): void {
	items.push({
		id,
		type: 'activity',
		label,
		items: [{ kind: 'note', label, ...(body ? { body } : {}) }]
	})
}

function pushImages(items: TranscriptItem[], id: string, images?: readonly ImageRef[]): void {
	for (const [index, image] of images?.entries() ?? [])
		items.push({ id: `${id}:image:${index}`, type: 'image', image })
}

function parseToolResult(content: string): unknown {
	try {
		return JSON.parse(content)
	} catch {
		return content
	}
}
