import type { AgentEvent, EntryRecord, SnapshotEvent, UsageState } from '@earendil-works/pi-durable'
import type { GhostStatus, Transcript, TranscriptEntry, TranscriptEvent } from './types.ts'

/** The entry kind of an ask: a user message whose data holds the asking client's cwd. */
export const ASK = 'ghost.ask'

type Content = readonly { type: string; text?: string }[] | string

/** One conversation's transcript and status, kept current from pi's agent events. */
export function createTranscript(snapshot: SnapshotEvent) {
	let records: EntryRecord[]
	// Text of each content block of the answer being generated; undefined when none is.
	let partial: string[] | undefined
	// Of the partial's text, what listeners have been sent.
	let sent: string
	let status: GhostStatus
	let consolidation: GhostStatus['consolidation']

	function load(event: SnapshotEvent): void {
		records = [...event.entries]
		const message = event.generation?.message
		partial = message === undefined ? undefined : texts(message.content)
		sent = partial?.join('') ?? ''
		status = {
			busy: event.run !== undefined,
			queued: event.inbox.length,
			...(consolidation === undefined ? {} : { consolidation }),
			usage: total(event.usage)
		}
	}

	function current(): Extract<TranscriptEvent, { type: 'snapshot' }> {
		const entries = records.map(toEntry).filter((entry) => entry !== undefined)
		const transcript: Transcript = partial === undefined ? { entries } : { entries, partial: sent }
		return { type: 'snapshot', transcript, status }
	}

	/** Apply one batch and return what listeners see of it. */
	function apply(events: readonly AgentEvent[]): TranscriptEvent[] {
		const out: TranscriptEvent[] = []
		const before = JSON.stringify(status)
		let snapshot = false
		// Send the answer's new text; its deltas add up to the answer entry's text.
		const flush = (now: string) => {
			if (now.length <= sent.length || !now.startsWith(sent)) return
			out.push({ type: 'text', delta: now.slice(sent.length) })
			sent = now
		}
		for (const event of events) {
			switch (event.type) {
				case 'snapshot':
					load(event)
					snapshot = true
					break
				case 'message_start':
					if (event.message.role !== 'assistant') break
					partial = texts(event.message.content)
					sent = ''
					flush(partial.join(''))
					break
				case 'message_update':
					if (partial === undefined) break
					for (const change of event.changes) {
						if (change.type === 'message') partial = texts(change.message.content)
						else if (change.type === 'text_delta')
							partial[change.contentIndex] = (partial[change.contentIndex] ?? '') + change.delta
						else if ('block' in change)
							partial[change.contentIndex] = change.block.type === 'text' ? change.block.text : ''
					}
					flush(partial.join(''))
					break
				case 'message_end':
				case 'entry_appended': {
					const record = event.entry
					const entry = toEntry(record)
					if (entry?.kind === 'assistant') {
						if (partial !== undefined) flush(entry.text)
						partial = undefined
						sent = ''
					}
					if (record.head === undefined) {
						records.push(record)
						if (entry !== undefined) out.push({ type: 'entry', entry })
					} else {
						// A head marker keeps the entries from its head on, as pi's view does.
						const head = record.head
						const kept = records.findIndex((entry) => entry.head === undefined && entry.id >= head)
						records = [record, ...(kept < 0 ? [] : records.slice(kept))]
						snapshot = true
					}
					break
				}
				case 'tool_execution_start':
					if (event.parentToolCallId === undefined)
						out.push({
							type: 'tool',
							callId: event.toolCallId,
							name: event.toolName,
							args: event.args
						})
					break
				case 'run_start':
					status = { ...status, busy: true }
					break
				case 'run_end':
					status = { ...status, busy: false }
					break
				case 'inbox_update':
					status = { ...status, queued: event.items.length }
					break
				case 'usage_changed':
					status = { ...status, usage: total(event.usage) }
					break
			}
		}
		if (snapshot) return [current()]
		if (JSON.stringify(status) !== before) out.push({ type: 'status', status })
		return out
	}

	/** Set the consolidation's state, which pi's events do not carry; returns what listeners see of it. */
	function consolidating(next: GhostStatus['consolidation']): TranscriptEvent[] {
		if (next?.from === consolidation?.from && next?.running === consolidation?.running) return []
		consolidation = next
		const { busy, queued, usage } = status
		status = { busy, queued, ...(next === undefined ? {} : { consolidation: next }), usage }
		return [{ type: 'status', status }]
	}

	load(snapshot)
	return { current, apply, consolidating }
}

/** Our record of one pi entry; undefined for bookkeeping the transcript does not show. */
export function toEntry(record: EntryRecord): TranscriptEntry | undefined {
	const entry = untimed(record)
	const timestamp = record.model?.[0]?.timestamp
	if (entry === undefined || timestamp === undefined) return entry
	return { ...entry, at: new Date(timestamp).toISOString() }
}

function untimed(record: EntryRecord): TranscriptEntry | undefined {
	const message = record.model?.[0]
	const id = record.id
	switch (record.kind) {
		case ASK:
			return message?.role === 'user'
				? {
						id,
						kind: 'user',
						text: text(message.content),
						askId: (record.data as { id?: string } | undefined)?.id
					}
				: undefined
		case 'pi.assistant': {
			if (message?.role !== 'assistant') return undefined
			const toolCalls = message.content.flatMap((block) =>
				block.type === 'toolCall' ? [{ id: block.id, name: block.name, args: block.arguments }] : []
			)
			const failed = message.stopReason === 'error' || message.stopReason === 'aborted'
			return {
				id,
				kind: 'assistant',
				text: text(message.content),
				toolCalls,
				...(failed ? { error: message.errorMessage ?? message.stopReason } : {})
			}
		}
		case 'pi.tool-result':
			return message?.role === 'toolResult'
				? {
						id,
						kind: 'tool',
						callId: message.toolCallId,
						name: message.toolName,
						text: text(message.content),
						isError: message.isError
					}
				: undefined
		case 'pi.reset':
			return message?.role === 'user'
				? { id, kind: 'reset', handoff: text(message.content) }
				: { id, kind: 'reset' }
		case 'pi.compaction':
			return message?.role === 'user'
				? { id, kind: 'compaction', summary: text(message.content) }
				: undefined
	}
	return undefined
}

function texts(content: Content): string[] {
	if (typeof content === 'string') return [content]
	return content.map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
}

export function text(content: Content): string {
	return texts(content).join('')
}

function total(state: UsageState): GhostStatus['usage'] {
	const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
	for (const usage of [...Object.values(state.models), ...Object.values(state.tools)]) {
		sum.input += usage.input
		sum.output += usage.output
		sum.cacheRead += usage.cacheRead
		sum.cacheWrite += usage.cacheWrite
		sum.cost += usage.cost.total
	}
	return sum
}
